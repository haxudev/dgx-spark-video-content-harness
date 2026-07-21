/**
 * Speaker-aware lip-sync for the dual-host podcast presenter band.
 *
 * The avatar service animates BOTH faces of the two-people clip from one driving
 * audio, so both mouths move together — wrong for a 男女对谈 where only one host
 * talks at a time. RENDER fixes this purely at composite time (no extra GPU): it
 * splits the band at the vertical centre and FREEZES the idle half to a still
 * frame whenever that speaker is silent, using the per-line speaker timeline from
 * the TTS audio manifest. Female (Anchor) sits left, male (Analyst) right.
 *
 * These helpers turn the manifest into the ffmpeg `overlay=...:enable='…'`
 * expressions that gate each half's frozen still.
 */
import type { AudioManifest } from "../schemas/audioManifest.js";

export interface Interval { start: number; end: number; }

/** Merge overlapping / touching intervals (input need not be sorted). */
export function mergeIntervals(ivs: Interval[]): Interval[] {
  if (ivs.length === 0) return [];
  const sorted = [...ivs].sort((a, b) => a.start - b.start);
  const out: Interval[] = [{ ...sorted[0]! }];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const last = out[out.length - 1]!;
    if (cur.start <= last.end + 1e-6) last.end = Math.max(last.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

/**
 * Merged speaking intervals for one speaker. `padSec` widens each utterance a
 * touch so the mouth starts moving just before — and settles just after — the
 * audio, which reads more naturally than a hard cut.
 */
export function speakingIntervals(mani: AudioManifest, speaker: string, padSec = 0): Interval[] {
  const raw = mani.lines
    .filter(l => l.speaker === speaker && l.durSec > 0)
    .map(l => ({ start: Math.max(0, l.startSec - padSec), end: l.startSec + l.durSec + padSec }));
  return mergeIntervals(raw);
}

/** Complement of `ivs` within `[0, total]` (the gaps). */
export function complement(ivs: Interval[], total: number): Interval[] {
  const out: Interval[] = [];
  let cursor = 0;
  for (const iv of mergeIntervals(ivs)) {
    const s = Math.max(0, iv.start);
    if (s > cursor + 1e-6) out.push({ start: cursor, end: Math.min(s, total) });
    cursor = Math.max(cursor, Math.min(iv.end, total));
  }
  if (cursor < total - 1e-6) out.push({ start: cursor, end: total });
  return out;
}

/** ffmpeg overlay `enable` predicate that is TRUE during the given intervals. */
export function enableExpr(ivs: Interval[]): string {
  const parts = ivs
    .filter(i => i.end > i.start + 1e-3)
    .map(i => `between(t,${i.start.toFixed(3)},${i.end.toFixed(3)})`);
  return parts.length ? parts.join("+") : "0";
}

/**
 * ffmpeg `enable` predicate that is TRUE while `speaker` is NOT talking — i.e.
 * the intervals during which that speaker's half of the band must be frozen to
 * the idle still. Empty manifest → "1" (always frozen, safe fallback).
 */
export function freezeEnableExpr(mani: AudioManifest, speaker: string, total: number, padSec = 0.12): string {
  const speak = speakingIntervals(mani, speaker, padSec);
  if (speak.length === 0) return "1";
  return enableExpr(complement(speak, total));
}

export function distinctSpeakers(mani: AudioManifest): string[] {
  return [...new Set(mani.lines.map(l => l.speaker))];
}
