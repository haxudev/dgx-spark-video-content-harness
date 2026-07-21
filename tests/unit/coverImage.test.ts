import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as path from "node:path";
import { buildComposition } from "../../src/tools/hfmlBuilder.js";
import {
  buildCoverBrief,
  buildCoverPrompt,
  buildCoverPromptCandidates,
  fair1x2Probabilities,
  top3Scores,
} from "../../src/tools/coverImage.js";

test("fair1x2Probabilities devigs and rounds to integer percentages summing to 100", () => {
  const probs = fair1x2Probabilities([
    { role: "主胜", team: "墨西哥", pct: 62.1, lead: true },
    { role: "平局", team: "平局", pct: 24.4, lead: false },
    { role: "客胜", team: "南非", pct: 17.3, lead: false },
  ]);

  assert.deepEqual(probs.map(p => [p.role, p.pct]), [
    ["主胜", 60],
    ["平局", 23],
    ["客胜", 17],
  ]);
  assert.equal(probs.reduce((sum, p) => sum + p.pct, 0), 100);
});

test("buildCoverPrompt fallback is a fast cinematic backdrop: team identity, no baked-in numbers", async () => {
  const original = process.env.HARNESS_DISABLE_LLM;
  process.env.HARNESS_DISABLE_LLM = "1";
  try {
    const prompt = await buildCoverPrompt({
      matchZh: "墨西哥 vs 南非",
      homeTeam: "墨西哥",
      awayTeam: "南非",
      outcomes: [
        { role: "主胜", team: "墨西哥", pct: 56, lead: true },
        { role: "平局", team: "平局", pct: 28, lead: false },
        { role: "客胜", team: "南非", pct: 16, lead: false },
      ],
      topScores: [
        { score: "2-0", pct: 14.2, lead: true },
        { score: "1-0", pct: 12.4 },
        { score: "1-1", pct: 10.7 },
      ],
      topGoals: [
        { goals: "2", pct: 23.8 },
        { goals: "3", pct: 22.6 },
        { goals: "1", pct: 16.9 },
      ],
    });

    // Team identity is conveyed (allowed), but probabilities / scores / goals
    // are NOT baked into the image — they are overlaid as crisp HTML so the
    // gpt-image-2 generation stays fast and reliable.
    assert.match(prompt, /墨西哥/);
    assert.match(prompt, /南非/);
    assert.match(prompt, /photorealistic|realistic/i);
    assert.match(prompt, /flag|crest/i);
    assert.match(prompt, /backdrop|lower third|overlaid/i);
    assert.doesNotMatch(prompt, /56%|28%|16%/);
    assert.doesNotMatch(prompt, /2-0 14%|1-0 12%|2球 24%/);
    assert.doesNotMatch(prompt, /current famous squad star players/);
  } finally {
    if (original === undefined) delete process.env.HARNESS_DISABLE_LLM;
    else process.env.HARNESS_DISABLE_LLM = original;
  }
});

test("buildCoverPromptCandidates yields a non-empty deterministic fallback for the gpt-image-2 cover", async () => {
  const original = process.env.HARNESS_DISABLE_LLM;
  process.env.HARNESS_DISABLE_LLM = "1";
  try {
    const candidates = await buildCoverPromptCandidates({
      matchZh: "墨西哥 vs 南非",
      homeTeam: "墨西哥",
      awayTeam: "南非",
    });
    // At least the conservative deterministic prompt is always present so the
    // mandatory Act-1 cover never depends on a reachable chat LLM.
    assert.ok(candidates.length >= 1);
    for (const p of candidates) assert.ok(p.trim().length >= 40);
    assert.match(candidates[candidates.length - 1]!, /墨西哥/);
    assert.match(candidates[candidates.length - 1]!, /南非/);
  } finally {
    if (original === undefined) delete process.env.HARNESS_DISABLE_LLM;
    else process.env.HARNESS_DISABLE_LLM = original;
  }
});

test("buildCoverBrief keeps top three scorelines in source order", () => {
  const brief = buildCoverBrief({
    homeTeam: "A队",
    awayTeam: "B队",
    topScores: [
      { score: "1-0", pct: 11 },
      { score: "2-1", pct: 10 },
      { score: "1-1", pct: 9 },
      { score: "0-0", pct: 8 },
    ],
  });

  assert.deepEqual(top3Scores(brief.topScores).map(s => s.score), ["1-0", "2-1", "1-1"]);
});

test("buildComposition renders the cover image inside the Act-1 cover-anime scene", async () => {
  const now = new Date().toISOString();
  const html = await buildComposition({
    blocks: [],
    templatesDir: path.resolve("templates"),
    coverImage: "cover.png",
    plan: {
      matchId: "cover-test",
      totalTargetSec: 6,
      dropped: [],
      createdAt: now,
      scenes: [{
        id: "s01",
        title: "开场",
        narrativeBeat: "hook",
        blockRefs: [],
        dataPointRefs: [],
        targetSec: 6,
        transitionIn: "none",
        visualSpec: { kind: "cover-anime", props: {} },
      }],
    },
    dialogue: {
      matchId: "cover-test",
      createdAt: now,
      totalEstSec: 6,
      totalChars: 4,
      scenes: [{
        sceneId: "s01",
        lines: [{
          id: "s01-l1",
          sceneId: "s01",
          speaker: "Anchor",
          text: "开场观察",
          ssml: "<speak>开场观察</speak>",
          targetSec: 6,
          estChars: 4,
        }],
      }],
    },
    manifest: {
      matchId: "cover-test",
      totalSec: 6,
      sampleRate: 24000,
      channels: 1,
      interLineGapMs: 150,
      interSpeakerGapMs: 250,
      provider: "stub",
      createdAt: now,
      voices: {},
      scenes: [{ sceneId: "s01", startSec: 0, endSec: 6, durSec: 6, lineIds: ["s01-l1"] }],
      lines: [{
        id: "s01-l1",
        sceneId: "s01",
        speaker: "Anchor",
        wavPath: "s01-l1.wav",
        startSec: 0,
        durSec: 6,
        trackIndex: 0,
        boundaries: [],
        cacheHit: false,
        provider: "stub",
      }],
    },
  });

  assert.match(html, /class="cover-anime-bg"/);
  assert.match(html, /src="cover\.png"/);
  // With an AI cover backdrop present, the data panel is still rendered on top.
  assert.match(html, /class="cover-anime has-img"/);
  // v2 no longer renders the legacy timeline-0 cover-poster overlay.
  assert.doesNotMatch(html, /class="cover-poster clip"/);
});
