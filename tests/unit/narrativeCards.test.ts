import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { write } from "../../src/phases/03-write.js";
import { buildPlan } from "../../src/phases/02-plan.js";
import { buildComposition } from "../../src/tools/hfmlBuilder.js";
import { buildRunContext, readJson, writeJson } from "../../src/orchestrator/runContext.js";
import { createRunState } from "../../src/orchestrator/stateMachine.js";
import type { BlocksFile } from "../../src/schemas/block.js";
import type { TalkPlan, Scene } from "../../src/schemas/talkPlan.js";
import type { MarketData } from "../../src/tools/marketExtractor.js";
import type { DialogueFile } from "../../src/schemas/dialogue.js";
import type { AudioManifest } from "../../src/schemas/audioManifest.js";

test("WRITE produces a conclusion-first four-act dialogue offline (no LLM)", async () => {
  const prevDisable = process.env.HARNESS_DISABLE_LLM;
  process.env.HARNESS_DISABLE_LLM = "1";
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "podcast-v2-"));
  try {
    const reportPath = path.join(root, "20260615", "germany-curacao.html");
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, "<html></html>", "utf8");
    const ctx = await buildRunContext(reportPath, root);
    const state = createRunState(ctx.matchId, ctx.reportPath);
    const plan = buildPlan(syntheticBlocks(ctx.reportPath));

    await writeJson(ctx.paths.blocks, syntheticBlocks(ctx.reportPath));
    await writeJson(ctx.paths.talkPlan, plan);
    await writeJson(ctx.paths.marketData, syntheticMarket());

    const result = await write(ctx, state, []);
    assert.equal(result.ok, true);

    const dlg = await readJson<DialogueFile>(ctx.paths.dialogue);
    assert.equal(dlg.scenes.length, 4, "v2 dialogue should have four acts");

    // Act 1 opens with an Anchor brand welcome and leads with the conclusion.
    const first = dlg.scenes[0]!.lines[0]!;
    assert.equal(first.speaker, "Anchor");
    assert.match(first.text, /AI球赛观察/);
    const act1 = dlg.scenes[0]!.lines.map(l => l.text).join("");
    assert.match(act1, /先说结论|最看好/);

    // Closing compliance read-outs land in the last act.
    const lastText = dlg.scenes[3]!.lines.map(l => l.text).join("");
    assert.match(lastText, /体育数据讨论/);
    assert.match(lastText, /结果承诺/);
    assert.match(lastText, /理性看球/);

    // No betting / odds language anywhere.
    const all = dlg.scenes.flatMap(s => s.lines).map(l => l.text).join("");
    assert.doesNotMatch(all, /下注|投注|赔率|庄家|抽水|推荐/);
  } finally {
    if (prevDisable === undefined) delete process.env.HARNESS_DISABLE_LLM;
    else process.env.HARNESS_DISABLE_LLM = prevDisable;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("PLAN builds a fixed four-act storyboard", () => {
  const plan = buildPlan(syntheticBlocks("fixture.html"));
  assert.equal(plan.scenes.length, 4, "v2 plan should be exactly four acts");
  assert.deepEqual(
    plan.scenes.map(s => s.visualSpec.kind),
    ["cover-anime", "fundamentals-signal", "market-grid", "upset-dashboard"],
  );
  assert.equal(plan.scenes[0]!.narrativeBeat, "hook");
});

test("upset dashboard labels the non-favoured side dynamically instead of hard-coding home unbeaten", async () => {
  const plan = syntheticPlan("fixture");
  const market = syntheticMarket();
  const dialogue: DialogueFile = {
    matchId: "fixture",
    scenes: plan.scenes.map(scene => ({
      sceneId: scene.id,
      lines: [{
        id: `${scene.id}-l1`,
        sceneId: scene.id,
        speaker: "Anchor",
        text: "这场怎么看？",
        ssml: "<speak>这场怎么看？</speak>",
        targetSec: 2,
        estChars: 6,
      }],
    })),
    totalEstSec: 12,
    totalChars: 36,
    createdAt: new Date().toISOString(),
  };
  const manifest: AudioManifest = {
    matchId: "fixture",
    totalSec: 12,
    sampleRate: 24000,
    channels: 1,
    lines: plan.scenes.map((scene, index) => ({
      id: `${scene.id}-l1`,
      sceneId: scene.id,
      speaker: "Anchor",
      wavPath: `${scene.id}.wav`,
      startSec: index * 2,
      durSec: 2,
      trackIndex: 0,
      boundaries: [],
      cacheHit: true,
      provider: "azure",
    })),
    scenes: plan.scenes.map((scene, index) => ({
      sceneId: scene.id,
      startSec: index * 2,
      endSec: index * 2 + 2,
      durSec: 2,
      lineIds: [`${scene.id}-l1`],
    })),
    interLineGapMs: 150,
    interSpeakerGapMs: 250,
    provider: "azure",
    voices: { Anchor: "zh-CN-XiaoxiaoNeural", Analyst: "zh-CN-YunxiNeural" },
    createdAt: new Date().toISOString(),
  };

  const html = await buildComposition({
    blocks: syntheticBlocks("fixture.html").blocks,
    plan,
    manifest,
    dialogue,
    market,
    templatesDir: path.resolve(process.cwd(), "templates"),
  });

  assert.match(html, /库拉索不输（爆冷）综合可能性/);
  assert.doesNotMatch(html, /主队不输（爆冷）综合概率/);
});

function syntheticPlan(matchId: string): TalkPlan {
  const scene = (id: string, title: string, kind: Scene["visualSpec"]["kind"], beat: Scene["narrativeBeat"], blockRefs: string[]): Scene => ({
    id,
    title,
    narrativeBeat: beat,
    blockRefs,
    dataPointRefs: [],
    targetSec: 20,
    transitionIn: "none",
    visualSpec: { kind, props: id === "s01" ? { matchZh: "德国 对 库拉索 比赛分析" } : {} },
  });
  return {
    matchId,
    totalTargetSec: 120,
    scenes: [
      scene("s01", "赛前看点", "hook", "hook", []),
      scene("s02", "爆冷可能性分析", "upset-dashboard", "data-drill", ["b-upset"]),
      scene("s03", "赛前反思", "risk", "risk", ["b-risk"]),
      scene("s04", "重要提示", "compliance", "compliance", []),
    ],
    dropped: [],
    createdAt: new Date().toISOString(),
  };
}

function syntheticBlocks(reportPath: string): BlocksFile {
  return {
    reportPath,
    parsedAt: new Date().toISOString(),
    blocks: [
      {
        kind: "meta",
        id: "b-meta",
        headingPath: [],
        importance: 1,
        dataPoints: [],
        match: "Germany vs Curacao",
        matchZh: "德国 对 库拉索 比赛分析",
        league: "世界杯",
        kickoff: "",
        venue: "",
        tags: [],
      },
      {
        kind: "paragraph",
        id: "b-upset",
        headingPath: ["爆冷可能性分析"],
        importance: 0.7,
        dataPoints: [],
        text: "模型把德国视为热门稳定，爆冷意味着库拉索不输，平局比分需要留意。",
        emphasis: [],
      },
      {
        kind: "list",
        id: "b-risk",
        headingPath: ["赛前反思"],
        importance: 0.6,
        dataPoints: [],
        ordered: false,
        items: [
          { text: "德国强弱底色明显，但大赛样本仍有边界。", emphasis: [] },
          { text: "库拉索如果守住前段节奏，平局剧本会被放大。", emphasis: [] },
        ],
      },
    ],
    stats: { total: 3, byKind: {}, unknownPct: 0, highImportanceCount: 2 },
  };
}

function syntheticMarket(): MarketData {
  return {
    hero: {
      title: "德国 对 库拉索 比赛分析",
      headline: "模型最看好 主胜（81.3%）",
      matchZh: "德国 对 库拉索 比赛分析",
      league: "世界杯",
      kickoff: "",
      season: "",
      homeName: "德国",
      awayName: "库拉索",
    },
    fundamentals: {
      homeName: "德国",
      awayName: "库拉索",
      homeStats: { label: "主队", recent: "—", ppg: "—", goals: "—", conceded: "—", splitLabel: "主场", splitGoals: "—", splitConceded: "—" },
      awayStats: { label: "客队", recent: "—", ppg: "—", goals: "—", conceded: "—", splitLabel: "客场", splitGoals: "—", splitConceded: "—" },
      homeBlurb: "德国强弱底色更清楚，控球与阵容深度会压住比赛节奏。",
      awayBlurb: "库拉索更多依赖防线密度和反击速度，平局剧本要看前段抗压。",
      highlights: [],
    },
    market1x2: {
      outcomes: [
        { role: "主胜", team: "德国", pct: 81.3, lead: true },
        { role: "平局", team: "—", pct: 13.1, lead: false },
        { role: "客胜", team: "库拉索", pct: 5.6, lead: false },
      ],
    },
    totalGoals: { bars: [], peakLabel: "2球", expected: "2.6", ge3pct: "48.0%" },
    correctScore: {
      topScores: [
        { score: "2-0", pct: 15.6, lead: true },
        { score: "1-1", pct: 6.4 },
      ],
      matrix: [],
    },
    htft: null,
    upset: {
      probPct: "18.7%",
      band: "热门稳定",
      favTeam: "德国",
      favPct: "81.3%",
      complexity: "国家队评分样本偏少，模型把握度低于俱乐部联赛，置信区间更宽。",
      scores: [
        { score: "1-1", pct: 6.4, interp: "平局", top: true },
        { score: "0-0", pct: 4.6, interp: "平局", top: false },
      ],
      factors: [],
    },
    strategy: null,
  };
}
