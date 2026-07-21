import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { buildRunContext, loadOrInitState } from "../../src/orchestrator/runContext.js";
import { createRunState } from "../../src/orchestrator/stateMachine.js";
import { runRange, type PhaseHandlers, type Issue } from "../../src/orchestrator/supervisor.js";
import { ingest } from "../../src/phases/01-ingest.js";

const REPORT = "/home/haxu/swa_html/reports/20260519/bournemouth-vs-man-city.html";
const HAS_REPORT = fsSync.existsSync(REPORT);

test("supervisor self-corrects via issue routing: WRITE failure → re-run PLAN → succeed", {
  timeout: 30_000,
  skip: HAS_REPORT ? false : `missing external fixture ${REPORT}`,
}, async () => {
  const outDir = `/tmp/podcast-football-recover-${Date.now()}`;
  const ctx = await buildRunContext(REPORT, outDir);
  const state = await loadOrInitState(ctx, () => createRunState(ctx.matchId, ctx.reportPath));

  // PLAN runs OK the second time; the first time it succeeds but WRITE will
  // claim a plan-level error that routes back to PLAN.
  let planRuns = 0;
  let writeRuns = 0;
  const handlers: PhaseHandlers = {
    INGEST: ingest,
    PLAN: async (ctx, _state, _prior) => {
      planRuns += 1;
      // Write a synthetic plan that satisfies downstream
      const file = {
        matchId: ctx.matchId,
        totalTargetSec: 240,
        scenes: [
          { id: "s01", title: "Hook", narrativeBeat: "hook" as const, blockRefs: [], dataPointRefs: [],
            targetSec: 30, transitionIn: "none" as const, visualSpec: { kind: "hook" as const, props: {} } },
          { id: "s02", title: "Compliance", narrativeBeat: "compliance" as const, blockRefs: [], dataPointRefs: [],
            targetSec: 30, transitionIn: "fade" as const, visualSpec: { kind: "compliance" as const, props: {} } },
        ],
        dropped: [],
        rationale: "test",
        createdAt: new Date().toISOString(),
      };
      await fs.mkdir(path.dirname(ctx.paths.talkPlan), { recursive: true });
      await fs.writeFile(ctx.paths.talkPlan, JSON.stringify(file));
      return { ok: true };
    },
    WRITE: async (_ctx, _state, prior): Promise<{ ok: boolean; issues?: Issue[] }> => {
      writeRuns += 1;
      // Fail until PLAN has re-run at least once; then succeed.
      if (planRuns < 2) {
        return {
          ok: false,
          issues: [
            { kind: "plan-missing-hook", severity: "error", message: "synthetic: missing hook" },
          ],
        };
      }
      return { ok: true };
    },
    VERIFY_TEXT: async () => ({ ok: true }),
    AUDIT_TALK: async () => ({ ok: true }),
    TTS: async () => ({ ok: true }),
    VERIFY_AUDIO: async () => ({ ok: true }),
    COMPOSE: async () => ({ ok: true }),
    VERIFY_VISUAL: async () => ({ ok: true }),
    RENDER: async () => ({ ok: true }),
    VERIFY_AV: async () => ({ ok: true }),
    AUDIT_VISUAL: async () => ({ ok: true }),
    POST: async () => ({ ok: true }),
  };

  await runRange(ctx, state, "INGEST", "POST", handlers);

  assert.ok(planRuns >= 2, `PLAN should have re-run via issue routing; got ${planRuns}`);
  assert.ok(writeRuns >= 2, `WRITE should have been retried; got ${writeRuns}`);
  // No escalation file should exist if recovery succeeded
  await assert.rejects(fs.stat(ctx.paths.escalation), (e: any) => e?.code === "ENOENT");
  await fs.rm(outDir, { recursive: true, force: true });
});

test("supervisor escalation file includes remediation hints + full phase log", {
  timeout: 30_000,
  skip: HAS_REPORT ? false : `missing external fixture ${REPORT}`,
}, async () => {
  const outDir = `/tmp/podcast-football-escalate-${Date.now()}`;
  const ctx = await buildRunContext(REPORT, outDir);
  const state = await loadOrInitState(ctx, () => createRunState(ctx.matchId, ctx.reportPath));

  const handlers: PhaseHandlers = {
    INGEST: ingest,
    // PLAN always fails with banned-terms (would route to WRITE — earlier than PLAN — impossible: forward route refused)
    PLAN: async () => ({
      ok: false,
      issues: [
        { kind: "text-banned-terms", severity: "error", message: "synthetic banned", data: ["TestTerm"] },
      ],
    }),
    WRITE: async () => ({ ok: true }),
    VERIFY_TEXT: async () => ({ ok: true }),
    AUDIT_TALK: async () => ({ ok: true }),
    TTS: async () => ({ ok: true }),
    VERIFY_AUDIO: async () => ({ ok: true }),
    COMPOSE: async () => ({ ok: true }),
    VERIFY_VISUAL: async () => ({ ok: true }),
    RENDER: async () => ({ ok: true }),
    VERIFY_AV: async () => ({ ok: true }),
    AUDIT_VISUAL: async () => ({ ok: true }),
    POST: async () => ({ ok: true }),
  };

  await assert.rejects(runRange(ctx, state, "INGEST", "POST", handlers), /escalate/);
  const esc = JSON.parse(await fs.readFile(ctx.paths.escalation, "utf8"));
  assert.equal(esc.phase, "PLAN");
  assert.ok(Array.isArray(esc.remediationHints));
  assert.ok(esc.remediationHints.length >= 1);
  assert.ok(Array.isArray(esc.fullPhaseLog));
  assert.ok(esc.fullPhaseLog.some((p: any) => p.phase === "INGEST" && p.status === "ok"));
  await fs.rm(outDir, { recursive: true, force: true });
});
