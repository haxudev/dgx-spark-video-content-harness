import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { AudioManifest } from "../../src/schemas/audioManifest.js";
import {
  mergeIntervals, speakingIntervals, complement, enableExpr, freezeEnableExpr, distinctSpeakers,
} from "../../src/tools/avatarSpeakerTimeline.js";
import { buildSpeakerOverlayArgs, buildStillArgs } from "../../src/phases/09-render.js";
import { avatarOverlayRect } from "../../src/tools/avatarLayout.js";

// Minimal manifest: female (Anchor) and male (Analyst) take strict turns.
const line = (speaker: string, startSec: number, durSec: number) =>
  ({ id: `${speaker}-${startSec}`, sceneId: "s01", speaker, wavPath: "x.wav", startSec, durSec, trackIndex: speaker === "Anchor" ? 0 : 1, boundaries: [], cacheHit: false } as any);
const MANI = {
  matchId: "m", totalSec: 20, sampleRate: 24000, channels: 1,
  lines: [
    line("Anchor", 0, 4),     // female 0-4
    line("Analyst", 4.2, 4),  // male 4.2-8.2
    line("Anchor", 8.4, 3),   // female 8.4-11.4
    line("Analyst", 11.6, 4), // male 11.6-15.6
  ],
  scenes: [], interLineGapMs: 150, interSpeakerGapMs: 250, createdAt: "now",
} as unknown as AudioManifest;

test("mergeIntervals merges overlapping and touching intervals", () => {
  assert.deepEqual(
    mergeIntervals([{ start: 0, end: 2 }, { start: 2, end: 3 }, { start: 5, end: 6 }, { start: 1, end: 1.5 }]),
    [{ start: 0, end: 3 }, { start: 5, end: 6 }],
  );
});

test("speakingIntervals gathers + pads one speaker's turns", () => {
  const f = speakingIntervals(MANI, "Anchor", 0);
  assert.deepEqual(f, [{ start: 0, end: 4 }, { start: 8.4, end: 11.4 }]);
  const padded = speakingIntervals(MANI, "Anchor", 0.1);
  assert.equal(padded[0]!.end, 4.1, "utterance widened by pad");
});

test("complement returns the gaps within [0,total]", () => {
  const f = speakingIntervals(MANI, "Anchor", 0);
  assert.deepEqual(complement(f, 20), [{ start: 4, end: 8.4 }, { start: 11.4, end: 20 }]);
});

test("enableExpr emits a between() sum (OR over disjoint intervals)", () => {
  assert.equal(enableExpr([{ start: 1, end: 2 }, { start: 3, end: 4.5 }]), "between(t,1.000,2.000)+between(t,3.000,4.500)");
  assert.equal(enableExpr([]), "0");
});

test("freezeEnableExpr: a host's half freezes exactly while the OTHER host talks", () => {
  // Freeze female (Anchor) = complement of Anchor speaking = roughly the male turns.
  const freezeFemale = freezeEnableExpr(MANI, "Anchor", 20, 0);
  assert.match(freezeFemale, /between\(t,4\.000,8\.400\)/, "female frozen during the 4.0-8.4 male turn");
  assert.match(freezeFemale, /between\(t,11\.400,20\.000\)/);
  // During the female's own turn (t=2) she must NOT be frozen.
  assert.doesNotMatch(freezeFemale, /between\(t,0\.000,4\.000\)/);
});

test("freezeEnableExpr falls back to always-frozen when the speaker never talks", () => {
  assert.equal(freezeEnableExpr(MANI, "Narrator", 20, 0), "1");
});

test("distinctSpeakers lists the hosts present", () => {
  assert.deepEqual(distinctSpeakers(MANI).sort(), ["Analyst", "Anchor"]);
});

test("buildStillArgs grabs a single frame", () => {
  const args = buildStillArgs("/loop.mp4", "/still.png");
  assert.ok(args.includes("-frames:v") && args[args.indexOf("-frames:v") + 1] === "1");
  assert.equal(args[args.length - 1], "/still.png");
});

test("buildSpeakerOverlayArgs splits the band at centre, freezes each idle half, keeps deck audio", () => {
  const rect = avatarOverlayRect();
  const plan = { leftFreeze: "between(t,4.000,8.400)", rightFreeze: "between(t,0.000,4.000)" };
  const args = buildSpeakerOverlayArgs("/deck.mp4", "/loop.mp4", "/still.png", rect, 150.27, plan, "/final.mp4");
  const fc = args[args.indexOf("-filter_complex") + 1]!;
  const cw = rect.w / 2; // rect.w is even; half is integer here
  // still must be split before cropping — reusing one pad label twice silently
  // drops the second crop (the right half), letting the deck show through.
  assert.match(fc, /split=2\[sa\]\[sb\]/, "still fanned out to both halves");
  assert.match(fc, new RegExp(`\\[sa\\]crop=${cw}:${rect.h}:0:0`), "left half crop");
  assert.match(fc, new RegExp(`\\[sb\\]crop=${rect.w - cw}:${rect.h}:${cw}:0`), "right half crop");
  // each half gated by its freeze predicate
  assert.match(fc, /overlay=0:0:enable='between\(t,4\.000,8\.400\)'/, "left frozen while male talks");
  assert.match(fc, new RegExp(`overlay=${cw}:0:enable='between\\(t,0\\.000,4\\.000\\)'`), "right frozen while female talks");
  assert.match(fc, new RegExp(`overlay=${rect.x}:${rect.y}:shortest=1`), "band composited onto deck at band position");
  // looped moving clip + looped still + deck audio
  assert.ok(args.includes("-stream_loop") && args[args.indexOf("-stream_loop") + 1] === "-1");
  assert.ok(args.join(" ").includes("0:a?"), "keeps the deck's TTS audio");
  assert.equal(args[args.indexOf("-t") + 1], "150.270");
  assert.equal(args[args.length - 1], "/final.mp4");
});
