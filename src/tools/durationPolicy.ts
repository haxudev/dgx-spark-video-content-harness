export interface DurationPolicy {
  targetSec: number;
  hardMinSec: number;
  hardMaxSec: number;
  shortForm: boolean;
}

const DEFAULT_TARGET_SEC = 165;

export function durationPolicy(): DurationPolicy {
  // Duration is advisory only: plan/write aim around a target length, while the
  // final gate is AV sync (rendered MP4 duration vs audio manifest), not a hard
  // min/max runtime envelope.
  const requestedMaxAsTarget = positiveInt(process.env.HARNESS_MAX_DURATION_SEC);
  const requestedTarget = positiveInt(process.env.HARNESS_TARGET_DURATION_SEC);
  const targetSec = requestedTarget ?? requestedMaxAsTarget ?? DEFAULT_TARGET_SEC;
  return {
    targetSec,
    hardMinSec: 0,
    hardMaxSec: Number.MAX_SAFE_INTEGER,
    shortForm: false,
  };
}

function positiveInt(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
