export type Phase =
  | "INGEST"
  | "PLAN"
  | "WRITE"
  | "VERIFY_TEXT"
  | "AUDIT_TALK"
  | "TTS"
  | "VERIFY_AUDIO"
  | "AVATAR"
  | "COMPOSE"
  | "VERIFY_VISUAL"
  | "RENDER"
  | "VERIFY_AV"
  | "AUDIT_VISUAL"
  | "POST"
  | "DONE";

export const PHASE_ORDER: Phase[] = [
  "INGEST",
  "PLAN",
  "WRITE",
  "VERIFY_TEXT",
  "AUDIT_TALK",
  "TTS",
  "VERIFY_AUDIO",
  "AVATAR",
  "COMPOSE",
  "VERIFY_VISUAL",
  "RENDER",
  "VERIFY_AV",
  "AUDIT_VISUAL",
  "POST",
  "DONE",
];

export interface RetryPolicy {
  maxRetries: number;          // same-phase retries
  fallbackPhase?: Phase;       // phase to roll back to on exhaust
  fallbackMaxRetries?: number; // re-runs of the rolled-back phase
}

export const RETRY_POLICY: Record<Phase, RetryPolicy> = {
  INGEST:        { maxRetries: 1 },
  PLAN:          { maxRetries: 2 },
  WRITE:         { maxRetries: 3, fallbackPhase: "PLAN", fallbackMaxRetries: 1 },
  VERIFY_TEXT:   { maxRetries: 0, fallbackPhase: "WRITE", fallbackMaxRetries: 3 },
  AUDIT_TALK:    { maxRetries: 0, fallbackPhase: "WRITE", fallbackMaxRetries: 2 },
  TTS:           { maxRetries: 2 },
  VERIFY_AUDIO:  { maxRetries: 0, fallbackPhase: "TTS", fallbackMaxRetries: 2 },
  AVATAR:        { maxRetries: 1 },
  COMPOSE:       { maxRetries: 2 },
  VERIFY_VISUAL: { maxRetries: 0, fallbackPhase: "COMPOSE", fallbackMaxRetries: 2 },
  RENDER:        { maxRetries: 1 },
  VERIFY_AV:     { maxRetries: 0, fallbackPhase: "COMPOSE", fallbackMaxRetries: 2 },
  AUDIT_VISUAL:  { maxRetries: 0 },
  POST:          { maxRetries: 1 },
  DONE:          { maxRetries: 0 },
};

/**
 * Per-issue routing table: when an issue of a given kind appears, which phase
 * is the most efficient one to retry? Empty fallback ⇒ use the phase's default
 * RETRY_POLICY.fallbackPhase. This lets a single fail-class shortcut to the
 * right earlier phase instead of falling back generically.
 */
export const ISSUE_ROUTING: Record<string, Phase> = {
  // text issues
  "text-total-too-short":                  "WRITE",
  "text-total-too-long":                   "WRITE",
  "text-scene-drift":                      "WRITE",
  "text-scene-dialogue-thin":              "WRITE",
  "text-scene-single-speaker":             "WRITE",
  "text-banned-terms":                     "WRITE",
  "text-sentence-too-long":                "WRITE",
  "text-compliance-opening-missing":       "WRITE",
  "text-compliance-closing-missing":       "WRITE",
  "text-glossary-no-first-explanation":    "WRITE",
  "text-data-fidelity":                    "WRITE",
  "text-no-compliance-policy-mention":     "WRITE",
  "text-restricted-compliance-terms":      "WRITE",
  "write-agent-required":                  "WRITE",
  "talk-audit-restricted-terms":           "WRITE",
  "talk-audit-dual-host-cadence":          "WRITE",
  "talk-audit-speaker-balance":            "WRITE",
  "talk-audit-low-score":                  "WRITE",
  // audio issues
  "audio-scene-drift":                     "TTS",
  "audio-overlap":                         "TTS",
  "audio-gap-too-large":                   "TTS",
  // avatar issues (digital-human presenter clip)
  "avatar-job-failed":                     "AVATAR",
  "avatar-unreachable":                    "AVATAR",
  "avatar-image-missing":                  "AVATAR",
  "avatar-download-failed":                "AVATAR",
  // composition issues
  "compose-no-stage-attr":                 "COMPOSE",
  "compose-no-audio":                      "COMPOSE",
  "compose-scene-missing":                 "COMPOSE",
  "visual-lint-missing":                   "COMPOSE",
  "visual-no-audio":                       "COMPOSE",
  "visual-too-few-scenes":                 "COMPOSE",
  "visual-restricted-compliance-terms":    "COMPOSE",
  "visual-audit-frame-extract-failed":     "RENDER",
  "visual-audit-qwen-review-failed":       "AUDIT_VISUAL",
  "visual-audit-qwen-unavailable":         "AUDIT_VISUAL",
  "post-restricted-compliance-terms":      "WRITE",
  "verify-av-duration-drift":              "COMPOSE",
  // plan issues
  "plan-total-too-short":                  "PLAN",
  "plan-total-too-long":                   "PLAN",
  "plan-missing-hook":                     "PLAN",
  "plan-missing-compliance":               "PLAN",
  "plan-hi-importance-uncovered":          "PLAN",
};

export function routeIssue(kind: string, current: Phase): Phase | undefined {
  const target = ISSUE_ROUTING[kind];
  if (!target) return RETRY_POLICY[current].fallbackPhase;
  // Don't route forward (would skip work)
  const ti = PHASE_ORDER.indexOf(target);
  const ci = PHASE_ORDER.indexOf(current);
  return ti < ci ? target : undefined;
}

export function nextPhase(phase: Phase): Phase {
  const idx = PHASE_ORDER.indexOf(phase);
  if (idx < 0 || idx >= PHASE_ORDER.length - 1) return "DONE";
  return PHASE_ORDER[idx + 1]!;
}

export interface PhaseLog {
  phase: Phase;
  startedAt: string;
  endedAt?: string;
  attempts: number;
  status: "ok" | "fail" | "skipped" | "running";
  issues?: string[];
}

export interface RunState {
  matchId: string;
  reportPath: string;
  currentPhase: Phase;
  phases: PhaseLog[];
  startedAt: string;
  updatedAt: string;
  ttsCacheHits?: number;
  ttsCacheMisses?: number;
}

export function createRunState(matchId: string, reportPath: string): RunState {
  const now = new Date().toISOString();
  return {
    matchId,
    reportPath,
    currentPhase: "INGEST",
    phases: [],
    startedAt: now,
    updatedAt: now,
  };
}
