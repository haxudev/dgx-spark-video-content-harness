import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { buildRunContext, loadOrInitState } from "../../src/orchestrator/runContext.js";
import { createRunState } from "../../src/orchestrator/stateMachine.js";
import { runRange } from "../../src/orchestrator/supervisor.js";
import { ingest } from "../../src/phases/01-ingest.js";
import { plan } from "../../src/phases/02-plan.js";
import { write } from "../../src/phases/03-write.js";
import { verifyText } from "../../src/phases/04-verify-text.js";
import { auditTalkTrack } from "../../src/phases/04b-audit-talk.js";
import { tts } from "../../src/phases/05-tts.js";
import { verifyAudio } from "../../src/phases/06-verify-audio.js";
import { avatar } from "../../src/phases/06b-avatar.js";
import { compose } from "../../src/phases/07-compose.js";
import { verifyVisual } from "../../src/phases/08-verify-visual.js";
import { render } from "../../src/phases/09-render.js";
import { verifyAv } from "../../src/phases/10-verify-av.js";
import { auditVisualFrames } from "../../src/phases/10b-audit-visual.js";
import { post } from "../../src/phases/11-post.js";

const REPORT = "/home/haxu/swa_html/reports/20260519/bournemouth-vs-man-city.html";
const HAS_REPORT = fsSync.existsSync(REPORT);

const HANDLERS = {
  INGEST: ingest, PLAN: plan, WRITE: write, VERIFY_TEXT: verifyText,
  AUDIT_TALK: auditTalkTrack, TTS: tts, VERIFY_AUDIO: verifyAudio, AVATAR: avatar, COMPOSE: compose, VERIFY_VISUAL: verifyVisual,
  RENDER: render, VERIFY_AV: verifyAv, AUDIT_VISUAL: auditVisualFrames, POST: post,
};

test("e2e: bournemouth report through INGEST..POST with stub TTS + skipped render", {
  timeout: 90_000,
  skip: HAS_REPORT ? false : `missing external fixture ${REPORT}`,
}, async () => {
  process.env.HARNESS_SKIP_RENDER = "1";
  process.env.HARNESS_SKIP_COVER = "1";
  process.env.HARNESS_SKIP_BGIMAGE = "1";
  // Force the offline stub TTS: disable the local Qwen host so the test never
  // depends on a reachable TTS service.
  process.env.HARNESS_TTS_PROVIDER = "qwen";
  process.env.QWEN_TTS_BASE_URL = "";
  process.env.QWEN_TTS_CLONE_URL = "";
  const outDir = `/tmp/podcast-football-e2e-${Date.now()}`;
  const ctx = await buildRunContext(REPORT, outDir);
  const state = await loadOrInitState(ctx, () => createRunState(ctx.matchId, ctx.reportPath));

  await runRange(ctx, state, "INGEST", "POST", HANDLERS);

  // Verify expected artifacts
  for (const p of [
    ctx.paths.blocks, ctx.paths.talkPlan, ctx.paths.dialogue,
    ctx.paths.audioManifest, ctx.paths.compositionHtml,
    ctx.paths.subtitles, ctx.paths.deliveryManifest, ctx.paths.complianceAudit,
  ]) {
    const stat = await fs.stat(p);
    assert.ok(stat.size > 0, `${path.basename(p)} should not be empty`);
  }

  // Sanity on manifest
  const mani = JSON.parse(await fs.readFile(ctx.paths.audioManifest, "utf8"));
  assert.ok(mani.totalSec >= 180, `total ${mani.totalSec}s should be ≥ 180s`);
  assert.ok(mani.totalSec <= 380, `total ${mani.totalSec}s should be ≤ 380s`);
  assert.ok(mani.scenes.length >= 6, `should have ≥ 6 scenes, got ${mani.scenes.length}`);

  // State machine recorded all 11 phases as OK
  const st = JSON.parse(await fs.readFile(ctx.paths.state, "utf8"));
  const phases = st.phases.filter((p: any) => p.status === "ok").map((p: any) => p.phase);
  for (const must of ["INGEST","PLAN","WRITE","VERIFY_TEXT","AUDIT_TALK","TTS","VERIFY_AUDIO","COMPOSE","VERIFY_VISUAL","RENDER","VERIFY_AV","AUDIT_VISUAL","POST"]) {
    assert.ok(phases.includes(must), `phase ${must} must be ok in state.json`);
  }

  // Cleanup
  await fs.rm(outDir, { recursive: true, force: true });
});
