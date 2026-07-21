import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildRunContext, writeJson } from "../../src/orchestrator/runContext.js";
import { createRunState } from "../../src/orchestrator/stateMachine.js";
import { buildPlan } from "../../src/phases/02-plan.js";
import { verifyText } from "../../src/phases/04-verify-text.js";
import { verifyVisual } from "../../src/phases/08-verify-visual.js";
import {
  COMPLIANCE_POLICY,
  findRestrictedComplianceTerms,
} from "../../src/tools/compliancePolicy.js";
import type { BlocksFile } from "../../src/schemas/block.js";
import type { DialogueFile } from "../../src/schemas/dialogue.js";

test("medium compliance policy flags lottery and betting guidance terms", () => {
  const hits = findRestrictedComplianceTerms("这场可以推荐下注，体彩赔率很香。");
  assert.deepEqual(hits.map(h => h.term), ["推荐", "下注", "体彩", "赔率"]);
  const marketHits = findRestrictedComplianceTerms("庄家抽水不要出现在成片里。");
  assert.deepEqual(marketHits.map(h => h.term), ["庄家", "抽水"]);

  const safe = findRestrictedComplianceTerms("这场只做赛前概率观察，比分情景只是模型分布。");
  assert.deepEqual(safe, []);
});

test("plan drops strategy blocks and keeps probability analysis neutral", () => {
  const blocks: BlocksFile = {
    reportPath: "fixtures/match.html",
    parsedAt: new Date().toISOString(),
    stats: { total: 5, byKind: {}, unknownPct: 0, highImportanceCount: 4 },
    blocks: [
      {
        kind: "meta",
        id: "m01",
        match: "A vs B",
        matchZh: "甲队 VS 乙队",
        headingPath: [],
        importance: 1,
        dataPoints: [],
        tags: [],
      },
      {
        kind: "bar-list",
        id: "b01",
        headingPath: ["模型预测与赔率分析"],
        importance: 0.9,
        title: "胜平负概率",
        items: [
          { label: "主胜", probability: 0.5, pills: [] },
          { label: "平局", probability: 0.25, pills: [] },
          { label: "客胜", probability: 0.25, pills: [] },
        ],
        dataPoints: [],
      },
      {
        kind: "strategy-card",
        id: "s01",
        headingPath: ["投注策略"],
        importance: 0.95,
        name: "稳健型",
        allocations: [{ market: "胜平负", option: "主胜", amount: 100, units: 1 }],
        summary: ["命中场景 92%"],
        dataPoints: [],
      },
      neutralParagraph("p01", "球队基本面", "主队近期控球更稳，客队反击速度更快。"),
      neutralParagraph("p02", "近期状态", "双方最近走势都有起伏，节奏可能偏谨慎。"),
      neutralParagraph("p03", "风险边界", "伤停和轮换会影响比赛节奏。"),
      neutralParagraph("p04", "历史交手", "过往交手节奏偏开放。"),
    ],
  };

  const plan = buildPlan(blocks);
  const allText = plan.scenes.map(s => `${s.title} ${s.narrativeBeat} ${s.visualSpec.kind}`).join(" ");
  assert.doesNotMatch(allText, /买|投注|推荐|strategy-board|strategy-cards|kelly-bar|recommendation/);
  assert.ok(plan.scenes.some(s => s.visualSpec.kind === "market-grid"), "probability scene should remain");
  assert.ok(!plan.scenes.some(s => s.blockRefs.includes("s01")), "strategy-card should be quarantined");
});

test("duration env is an advisory pacing target, not a hard runtime gate", () => {
  const prevMax = process.env.HARNESS_MAX_DURATION_SEC;
  const prevTarget = process.env.HARNESS_TARGET_DURATION_SEC;
  process.env.HARNESS_MAX_DURATION_SEC = "120";
  process.env.HARNESS_TARGET_DURATION_SEC = "112";

  try {
    const blocks: BlocksFile = {
      reportPath: "fixtures/match.html",
      parsedAt: new Date().toISOString(),
      stats: { total: 7, byKind: {}, unknownPct: 0, highImportanceCount: 5 },
      blocks: [
        {
          kind: "meta",
          id: "m01",
          match: "A vs B",
          matchZh: "甲队 VS 乙队",
          headingPath: [],
          importance: 1,
          dataPoints: [],
          tags: [],
        },
        neutralParagraph("p01", "球队基本面", "主队近期控球更稳，客队反击速度更快。"),
        {
          kind: "bar-list",
          id: "b01",
          headingPath: ["模型预测与赔率分析"],
          importance: 0.9,
          title: "胜平负概率",
          items: [
            { label: "主胜", probability: 0.5, pills: [] },
            { label: "平局", probability: 0.25, pills: [] },
            { label: "客胜", probability: 0.25, pills: [] },
          ],
          dataPoints: [],
        },
        neutralParagraph("p02", "爆冷可能性分析", "杯赛单场方差偏大，平局和加时变量需要留意。"),
        neutralParagraph("p03", "模拟投注策略", "不同画像之间分歧明显，应先看风险跨度。"),
        {
          kind: "strategy-card",
          id: "s01",
          headingPath: ["模拟投注策略"],
          importance: 0.95,
          name: "稳健型",
          allocations: [{ market: "胜平负", option: "主胜", amount: 100, units: 1 }],
          summary: ["命中场景 92%"],
          dataPoints: [],
        },
      ],
    };

    const plan = buildPlan(blocks);
    const total = plan.scenes.reduce((sum, scene) => sum + scene.targetSec, 0);
    assert.ok(total >= 100 && total <= 124, `expected total near advisory target, got ${total}`);
    // v2 always produces the fixed four-act storyboard.
    assert.equal(plan.scenes.length, 4, "v2 plan should be exactly four acts");
    assert.deepEqual(
      plan.scenes.map(s => s.visualSpec.kind),
      ["cover-anime", "fundamentals-signal", "market-grid", "upset-dashboard"],
    );
    assert.ok(!plan.scenes.some(s => s.blockRefs.includes("s01")), "strategy-card should remain quarantined");
  } finally {
    restoreEnv("HARNESS_MAX_DURATION_SEC", prevMax);
    restoreEnv("HARNESS_TARGET_DURATION_SEC", prevTarget);
  }
});

test("verifyText rejects restricted compliance terms in dialogue", async () => {
  const root = await fs.mkdtemp(path.join("/tmp", "podcast-policy-text-"));
  const ctx = await buildRunContext("/tmp/fixtures/match.html", root);
  const state = createRunState(ctx.matchId, ctx.reportPath);

  await writeJson(ctx.paths.blocks, minimalBlocksFile(ctx.reportPath));
  await writeJson(ctx.paths.talkPlan, {
    matchId: ctx.matchId,
    totalTargetSec: 145,
    scenes: [
      scene("s01", "hook", "hook"),
      scene("s02", "compliance", "compliance"),
    ],
    dropped: [],
    createdAt: new Date().toISOString(),
  });
  const dialogue: DialogueFile = {
    matchId: ctx.matchId,
    scenes: [
      { sceneId: "s01", lines: [line("s01-l1", "s01", "Anchor", "这场推荐下注吗？")] },
      { sceneId: "s02", lines: [
        line("s02-l1", "s02", "Anchor", "最后提醒。"),
        line("s02-l2", "s02", "Analyst", "以上内容仅供体育数据讨论。"),
        line("s02-l3", "s02", "Analyst", "模型概率不代表比赛结果承诺。"),
        line("s02-l4", "s02", "Analyst", "请理性看球，不作为任何参与决策依据。"),
      ] },
    ],
    totalEstSec: 145,
    totalChars: 520,
    createdAt: new Date().toISOString(),
  };
  await writeJson(ctx.paths.dialogue, dialogue);

  const result = await verifyText(ctx, state, []);
  assert.equal(result.ok, false);
  assert.ok(result.issues?.some(i => i.kind === "text-restricted-compliance-terms"));
  await fs.rm(root, { recursive: true, force: true });
});

test("verifyVisual requires neutral policy chrome and rejects betting labels", async () => {
  const root = await fs.mkdtemp(path.join("/tmp", "podcast-policy-visual-"));
  const ctx = await buildRunContext("/tmp/fixtures/match.html", root);
  const state = createRunState(ctx.matchId, ctx.reportPath);
  await fs.mkdir(ctx.paths.compositionDir, { recursive: true });
  await fs.writeFile(ctx.paths.compositionHtml, `
    <div data-composition-id="x" data-width="1080" data-height="1920" data-fps="30">
      <div class="lower-third" data-vtt-src="subtitles.vtt"></div>
      <section data-scene-id="s01"></section><section data-scene-id="s02"></section><section data-scene-id="s03"></section>
      <audio></audio>
      <div>${COMPLIANCE_POLICY.brand}</div>
      <div>${COMPLIANCE_POLICY.headerLabel}</div>
      <div>${COMPLIANCE_POLICY.footerText}</div>
      <div>模拟投注策略</div>
    </div>
  `, "utf8");

  const result = await verifyVisual(ctx, state, []);
  assert.equal(result.ok, false);
  assert.ok(result.issues?.some(i => i.kind === "visual-restricted-compliance-terms"));
  await fs.rm(root, { recursive: true, force: true });
});

test("verifyVisual flags a composition missing the persistent brand", async () => {
  const root = await fs.mkdtemp(path.join("/tmp", "podcast-policy-brand-"));
  const ctx = await buildRunContext("/tmp/fixtures/match.html", root);
  const state = createRunState(ctx.matchId, ctx.reportPath);
  await fs.mkdir(ctx.paths.compositionDir, { recursive: true });
  await fs.writeFile(ctx.paths.compositionHtml, `
    <div data-composition-id="x" data-width="1080" data-height="1920" data-fps="30">
      <div class="lower-third" data-vtt-src="subtitles.vtt"></div>
      <section data-scene-id="s01"></section><section data-scene-id="s02"></section><section data-scene-id="s03"></section>
      <audio></audio>
      <div>${COMPLIANCE_POLICY.headerLabel}</div>
      <div>${COMPLIANCE_POLICY.footerText}</div>
    </div>
  `, "utf8");

  const result = await verifyVisual(ctx, state, []);
  assert.equal(result.ok, false);
  assert.ok(
    result.issues?.some(i => i.kind === "visual-lint-missing" && i.message.includes(COMPLIANCE_POLICY.brand)),
    `expected a missing-brand lint issue, got: ${JSON.stringify(result.issues)}`,
  );
  await fs.rm(root, { recursive: true, force: true });
});

function minimalBlocksFile(reportPath: string): BlocksFile {
  return {
    reportPath,
    parsedAt: new Date().toISOString(),
    stats: { total: 1, byKind: {}, unknownPct: 0, highImportanceCount: 1 },
    blocks: [{
      kind: "meta",
      id: "m01",
      match: "A vs B",
      matchZh: "甲队 VS 乙队",
      headingPath: [],
      importance: 1,
      dataPoints: [],
      tags: [],
    }],
  };
}

function neutralParagraph(id: string, heading: string, text: string) {
  return {
    kind: "paragraph" as const,
    id,
    headingPath: [heading],
    importance: 0.75,
    text,
    emphasis: [],
    containsSimulated: false,
    dataPoints: [],
  };
}

function scene(id: string, narrativeBeat: string, kind: string) {
  return {
    id,
    title: id,
    narrativeBeat,
    blockRefs: [],
    dataPointRefs: [],
    targetSec: 80,
    transitionIn: "none",
    visualSpec: { kind, props: {} },
  };
}

function line(id: string, sceneId: string, speaker: "Anchor" | "Analyst", text: string) {
  return {
    id,
    sceneId,
    speaker,
    text,
    ssml: `<speak>${text}</speak>`,
    targetSec: 10,
    estChars: Math.max(1, text.length),
  };
}

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
