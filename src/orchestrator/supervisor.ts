import { PHASE_ORDER, type Phase, type RunState, RETRY_POLICY, routeIssue } from "./stateMachine.js";
import { logPhaseEnd, logPhaseRetry, logPhaseStart, persistState, writeJson, type RunContext } from "./runContext.js";

export interface VerifyResult {
  ok: boolean;
  issues: Issue[];
}

export interface Issue {
  kind: string;             // e.g. "text-length-overflow"
  severity: "error" | "warn";
  message: string;
  data?: unknown;
}

// A PhaseRunner owns one full run of a single phase.
// It receives prior issues (if a retry) so it can adjust behaviour.
export type PhaseRunner = (
  ctx: RunContext,
  state: RunState,
  priorIssues: Issue[],
) => Promise<{ ok: boolean; issues?: Issue[] }>;

export interface PhaseHandlers {
  [k: string]: PhaseRunner;
}

export interface EscalationRecord {
  phase: Phase;
  attempts: number;
  fallback?: { phase: Phase; attempts: number };
  routedTo?: Phase;
  issues: Issue[];
  remediationHints: string[];
  fullPhaseLog: Array<{ phase: Phase; attempts: number; status: string; issues?: string[] }>;
  at: string;
}

/**
 * Run a single phase via the plan-exec-verify pattern.
 *
 * The PhaseRunner itself is expected to internally implement plan→exec→verify
 * (see e.g. phases/03-write.ts). The supervisor here owns:
 *   - persistent state tracking
 *   - same-phase retry budget
 *   - issue-routed cross-phase rollback
 *   - escalation persistence with diagnostics + remediation hints
 */
export async function runPhase(
  ctx: RunContext,
  state: RunState,
  phase: Phase,
  handlers: PhaseHandlers,
): Promise<void> {
  const runner = handlers[phase];
  if (!runner) throw new Error(`No runner registered for phase ${phase}`);
  const policy = RETRY_POLICY[phase];

  logPhaseStart(state, phase);
  await persistState(ctx, state);

  let issues: Issue[] = [];
  for (let attempt = 0; attempt <= policy.maxRetries; attempt++) {
    if (attempt > 0) {
      logPhaseRetry(state);
      await persistState(ctx, state);
    }
    const { ok, issues: out } = await runner(ctx, state, issues);
    issues = out ?? [];
    if (ok) {
      logPhaseEnd(state, true);
      await persistState(ctx, state);
      return;
    }
  }

  // Same-phase budget exhausted. Determine the most-targeted fallback phase by
  // examining the issues: every error gets routed via ISSUE_ROUTING, and we
  // pick the EARLIEST target so a single re-run covers all error classes
  // simultaneously (e.g. text+plan errors → re-run PLAN, not WRITE alone).
  const errorIssues = issues.filter(i => i.severity === "error");
  const targets = new Set<Phase>();
  for (const i of errorIssues) {
    const tgt = routeIssue(i.kind, phase);
    if (tgt) targets.add(tgt);
  }
  const earliestTarget = pickEarliest(targets) ?? policy.fallbackPhase;
  const fbBudget = policy.fallbackMaxRetries ?? (earliestTarget ? 1 : 0);

  if (earliestTarget && fbBudget > 0) {
    const fb = earliestTarget;
    const fbRunner = handlers[fb];
    if (!fbRunner) {
      await failEscalate(ctx, state, phase, issues, undefined, fb);
      return;
    }
    logPhaseEnd(state, false, issues.map(i => `${i.kind}: ${i.message}`));
    await persistState(ctx, state);

    let fbAttempts = 0;
    for (let a = 0; a < fbBudget; a++) {
      logPhaseStart(state, fb);
      await persistState(ctx, state);
      const { ok, issues: fbIssues } = await fbRunner(ctx, state, issues);
      fbAttempts += 1;
      issues = fbIssues ?? [];
      if (!ok) {
        logPhaseEnd(state, false, issues.map(i => `${i.kind}: ${i.message}`));
        await persistState(ctx, state);
        continue;
      }
      logPhaseEnd(state, true);
      await persistState(ctx, state);
      // Re-run all phases from fb+1 .. phase (inclusive) to recover
      const fbIdx = PHASE_ORDER.indexOf(fb);
      const origIdx = PHASE_ORDER.indexOf(phase);
      let recoverOk = true;
      for (let pi = fbIdx + 1; pi <= origIdx; pi++) {
        const interPhase = PHASE_ORDER[pi]!;
        const interRunner = handlers[interPhase];
        if (!interRunner) continue;
        logPhaseStart(state, interPhase);
        await persistState(ctx, state);
        const r = await interRunner(ctx, state, []);
        if (!r.ok) {
          issues = r.issues ?? [];
          logPhaseEnd(state, false, issues.map(i => `${i.kind}: ${i.message}`));
          await persistState(ctx, state);
          recoverOk = false;
          break;
        }
        logPhaseEnd(state, true);
        await persistState(ctx, state);
      }
      if (recoverOk) return;
    }
    await failEscalate(ctx, state, phase, issues, { phase: fb, attempts: fbAttempts }, fb);
    return;
  }

  await failEscalate(ctx, state, phase, issues);
}

function pickEarliest(set: Set<Phase>): Phase | undefined {
  let best: Phase | undefined;
  let bestIdx = Infinity;
  for (const p of set) {
    const i = PHASE_ORDER.indexOf(p);
    if (i < bestIdx) { bestIdx = i; best = p; }
  }
  return best;
}

function remediationHints(issues: Issue[]): string[] {
  const out: string[] = [];
  const kinds = new Set(issues.map(i => i.kind));
  if (kinds.has("text-banned-terms")) {
    out.push("Update config/banned-terms.yaml or extend stripBanned() in 03-write.ts.");
  }
  if (kinds.has("text-restricted-compliance-terms") || kinds.has("visual-restricted-compliance-terms") || kinds.has("post-restricted-compliance-terms")) {
    out.push("Apply the medium compliance policy: remove lottery, betting, purchase, recommendation, stake, payoff, and profit/loss language from generated output.");
  }
  if (kinds.has("text-glossary-no-first-explanation")) {
    out.push("Add an alias to config/glossary.yaml so first-occurrence detection sees it.");
  }
  if (kinds.has("text-compliance-opening-missing") || kinds.has("text-compliance-closing-missing")) {
    out.push("Verify config/compliance-phrases.yaml keywords match the dialogue produced.");
  }
  if ([...kinds].some(k => k.startsWith("talk-audit-"))) {
    out.push("Inspect verify/talk-track-audit.json and revise 03-write.ts prompts/templates for cadence, clarity, or compliance.");
  }
  if (kinds.has("text-no-compliance-policy-mention")) {
    out.push("Ensure the opening scene includes the configured sports-data observation phrase.");
  }
  if (kinds.has("text-scene-drift") || kinds.has("audio-scene-drift")) {
    out.push("Loosen scene.targetSec in 02-plan.ts or adjust SSML <prosody rate>.");
  }
  if (kinds.has("visual-lint-missing") || kinds.has("compose-scene-missing")) {
    out.push("Inspect composition/index.html — likely a missing template partial or stale data-scene-id.");
  }
  if (kinds.has("compose-cover-missing") || kinds.has("compose-bg-missing")) {
    out.push("gpt-image-2 cover.png/bg.png generation failed: verify AZURE_OPENAI_IMAGE_* env (endpoint/key/deployment) and image-API reachability; inspect verify/compose.json. To intentionally ship without AI images, set HARNESS_SKIP_COVER=1 / HARNESS_SKIP_BGIMAGE=1.");
  }
  if ([...kinds].some(k => k.startsWith("visual-audit-"))) {
    out.push("Inspect verify/visual-frame-audit.json and verify/visual-frames/*.jpg; adjust templates or rerun with Qwen vision enabled.");
  }
  if (kinds.has("verify-av-duration-drift")) {
    out.push("Re-render with --fps=30 and inspect inter-scene gaps in audio/manifest.json.");
  }
  if (kinds.has("plan-hi-importance-uncovered")) {
    out.push("Lower the importance threshold or increase MAX_SCENES in 02-plan.ts.");
  }
  if (out.length === 0) out.push("See verify/*.json for detailed per-phase diagnostics.");
  return out;
}

async function failEscalate(
  ctx: RunContext,
  state: RunState,
  phase: Phase,
  issues: Issue[],
  fallback?: { phase: Phase; attempts: number },
  routedTo?: Phase,
): Promise<void> {
  logPhaseEnd(state, false, issues.map(i => `${i.kind}: ${i.message}`));
  await persistState(ctx, state);
  const rec: EscalationRecord = {
    phase,
    attempts: RETRY_POLICY[phase].maxRetries + 1,
    fallback,
    routedTo,
    issues,
    remediationHints: remediationHints(issues),
    fullPhaseLog: state.phases.map(p => ({
      phase: p.phase,
      attempts: p.attempts,
      status: p.status,
      issues: p.issues,
    })),
    at: new Date().toISOString(),
  };
  await writeJson(ctx.paths.escalation, rec);
  throw new Error(`[escalate] phase=${phase} budget exhausted (${issues.length} issue${issues.length === 1 ? "" : "s"}). See ${ctx.paths.escalation}`);
}

/**
 * Drive the pipeline from `from` phase to `to` phase (inclusive).
 */
export async function runRange(
  ctx: RunContext,
  state: RunState,
  from: Phase,
  to: Phase,
  handlers: PhaseHandlers,
): Promise<void> {
  const startIdx = PHASE_ORDER.indexOf(from);
  const endIdx = PHASE_ORDER.indexOf(to);
  if (startIdx < 0 || endIdx < 0) throw new Error(`Invalid range ${from}..${to}`);
  for (let i = startIdx; i <= endIdx; i++) {
    const p = PHASE_ORDER[i]!;
    if (p === "DONE") break;
    await runPhase(ctx, state, p, handlers);
  }
}
