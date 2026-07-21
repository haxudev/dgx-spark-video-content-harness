import { test } from "node:test";
import assert from "node:assert/strict";
import { deduplicateCrossSceneBoundaries } from "../../src/phases/03-write.js";
import type { SceneDialogue, DialogueLine } from "../../src/schemas/dialogue.js";

/**
 * Targeted tests for the WRITE-phase deduplication pass.
 *
 * Background: the LLM, when given both "scene must end with a teaser
 * question" and "scene first line must not repeat previousLineTail",
 * frequently parrots the same Anchor question on both sides of the scene
 * boundary. The audience hears the female voice ask the same thing twice
 * — first as the closing of scene N and then immediately as the opener of
 * scene N+1. `deduplicateCrossSceneBoundaries` cleans those up.
 */

function mkLine(id: string, sceneId: string, speaker: "Anchor" | "Analyst", text: string): DialogueLine {
  return { id, sceneId, speaker, text, ssml: "", targetSec: 0, estChars: text.length };
}

function mkScene(id: string, ...lines: Array<[id: string, sp: "Anchor" | "Analyst", text: string]>): SceneDialogue {
  return { sceneId: id, lines: lines.map(([lid, sp, t]) => mkLine(lid, id, sp, t)) };
}

test("dedup drops scene-N first line when it exactly matches scene-N-1 last line", () => {
  const scenes: SceneDialogue[] = [
    mkScene("s01",
      ["s01-l1", "Anchor", "今晚谁更有戏？"],
      ["s01-l2", "Analyst", "客队偏强。"],
      ["s01-l3", "Anchor", "那客场这边呢，有没有机会？"]),
    mkScene("s02",
      ["s02-l1", "Anchor", "那客场这边呢，有没有机会？"],
      ["s02-l2", "Analyst", "机会不小。"],
      ["s02-l3", "Anchor", "继续讲。"]),
  ];
  deduplicateCrossSceneBoundaries(scenes);
  assert.equal(scenes[1]!.lines.length, 2);
  assert.equal(scenes[1]!.lines[0]!.id, "s02-l2");
});

test("dedup trims overlapping prefix when scene-N first line extends the previous closer", () => {
  const scenes: SceneDialogue[] = [
    mkScene("s01",
      ["s01-l1", "Anchor", "那这账怎么算？"]),
    mkScene("s02",
      ["s02-l1", "Anchor", "那这账怎么算？模型分布怎么说？"],
      ["s02-l2", "Analyst", "模型说……"]),
  ];
  deduplicateCrossSceneBoundaries(scenes);
  // The duplicated "那这账怎么算？" prefix is gone — only the extension
  // ("模型分布怎么说？") survives at the head of scene 2.
  assert.equal(scenes[1]!.lines.length, 2);
  assert.equal(scenes[1]!.lines[0]!.text, "模型分布怎么说？");
});

test("dedup ignores boundaries with different speakers", () => {
  const scenes: SceneDialogue[] = [
    mkScene("s01",
      ["s01-l1", "Analyst", "那这是一个关键点。"]),
    mkScene("s02",
      ["s02-l1", "Anchor", "那这是一个关键点。"], // same text, different speaker — natural call-and-response
      ["s02-l2", "Analyst", "继续。"]),
  ];
  deduplicateCrossSceneBoundaries(scenes);
  assert.equal(scenes[1]!.lines.length, 2);
  assert.equal(scenes[1]!.lines[0]!.text, "那这是一个关键点。");
});

test("dedup keeps the longer line when previous is a prefix of current's extension that's too short to stand alone", () => {
  const scenes: SceneDialogue[] = [
    mkScene("s01",
      ["s01-l1", "Anchor", "那这账怎么算？"]),
    mkScene("s02",
      ["s02-l1", "Anchor", "那这账怎么算？呢？"], // remainder "呢？" is <4 chars → drop the whole line
      ["s02-l2", "Analyst", "模型这么说……"]),
  ];
  deduplicateCrossSceneBoundaries(scenes);
  assert.equal(scenes[1]!.lines.length, 1);
  assert.equal(scenes[1]!.lines[0]!.id, "s02-l2");
});

test("dedup tolerates punctuation/whitespace variation between the two duplicates", () => {
  const scenes: SceneDialogue[] = [
    mkScene("s01",
      ["s01-l1", "Anchor", "那平局和客队呢，差距大吗？"]),
    mkScene("s02",
      ["s02-l1", "Anchor", "那平局和客队呢？差距大吗?"], // punctuation differs
      ["s02-l2", "Analyst", "差距不小。"]),
  ];
  deduplicateCrossSceneBoundaries(scenes);
  assert.equal(scenes[1]!.lines.length, 1);
  assert.equal(scenes[1]!.lines[0]!.id, "s02-l2");
});

test("dedup leaves clean (non-duplicate) boundaries alone", () => {
  const scenes: SceneDialogue[] = [
    mkScene("s01",
      ["s01-l1", "Anchor", "那这场怎么看？"]),
    mkScene("s02",
      ["s02-l1", "Anchor", "我们先看基本面。"],
      ["s02-l2", "Analyst", "好。"]),
  ];
  deduplicateCrossSceneBoundaries(scenes);
  assert.equal(scenes[1]!.lines.length, 2);
  assert.equal(scenes[1]!.lines[0]!.text, "我们先看基本面。");
});
