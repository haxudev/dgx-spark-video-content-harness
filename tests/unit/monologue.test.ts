import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { write, buildMonologueSystemPrompt } from "../../src/phases/03-write.js";
import { verifyText } from "../../src/phases/04-verify-text.js";
import { auditTalkTrack } from "../../src/phases/04b-audit-talk.js";
import { buildRunContext, writeJson, readJson } from "../../src/orchestrator/runContext.js";
import { createRunState } from "../../src/orchestrator/stateMachine.js";
import { scriptMode } from "../../src/tools/runProfile.js";
import { COMPLIANCE_POLICY } from "../../src/tools/compliancePolicy.js";
import { SPEAKER_DISPLAY } from "../../src/tools/ssml.js";
import type { Scene, TalkPlan } from "../../src/schemas/talkPlan.js";
import type { Block, BlocksFile } from "../../src/schemas/block.js";
import type { DialogueFile, SceneDialogue } from "../../src/schemas/dialogue.js";

function restore(key: string, val: string | undefined): void {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
}

// --------------------------------------------------------------------------
// 1. scriptMode() env accessor
// --------------------------------------------------------------------------
test("scriptMode defaults to podcast and reads HARNESS_SCRIPT_MODE", () => {
  const prev = process.env.HARNESS_SCRIPT_MODE;
  try {
    delete process.env.HARNESS_SCRIPT_MODE;
    assert.equal(scriptMode(), "podcast");
    process.env.HARNESS_SCRIPT_MODE = "monologue";
    assert.equal(scriptMode(), "monologue");
    process.env.HARNESS_SCRIPT_MODE = "MONOLOGUE";
    assert.equal(scriptMode(), "monologue");
    process.env.HARNESS_SCRIPT_MODE = "garbage";
    assert.equal(scriptMode(), "podcast");
  } finally {
    restore("HARNESS_SCRIPT_MODE", prev);
  }
});

// --------------------------------------------------------------------------
// 2. buildMonologueSystemPrompt: single-host, plain/comprehensible, compliant
// --------------------------------------------------------------------------
test("buildMonologueSystemPrompt is single-host, plain-language and compliant", () => {
  const prompt = buildMonologueSystemPrompt({
    glossary: [{ term: "Elo", aliases: ["elo"], simpleZh: "球队实力评分" } as any],
    banned: ["稳胆", "推荐"],
    closing: ["以上内容仅供体育数据讨论", "模型概率不代表比赛结果承诺"],
  });
  // Single-host persona present, dual-host wording absent
  assert.match(prompt, new RegExp(SPEAKER_DISPLAY.Narrator));
  assert.match(prompt, /单人口播/);
  assert.ok(!prompt.includes("男女双"), "monologue prompt must not ask for dual hosts");
  // Plain / comprehensible framing: middle-school audience, pitch-only imagery,
  // and an explicit ban on cross-domain/abstract metaphors.
  assert.match(prompt, /一听就懂/);
  assert.match(prompt, /直白易懂/);
  assert.match(prompt, /足球场上看得见的画面|球赛术语/);
  assert.match(prompt, /门缝|裂缝/);          // listed as FORBIDDEN metaphors
  assert.match(prompt, /(严禁|不许)[^\n]*(跨领域|抽象)/);
  // Compliance guardrails carried over verbatim
  assert.match(prompt, /模型概率不代表比赛结果承诺/);
  assert.match(prompt, /庄家/);          // explicitly forbidden in the口径 list
  assert.match(prompt, /无时间概念/);
  // Banned + glossary injected
  assert.match(prompt, /稳胆/);
  assert.match(prompt, /球队实力评分/);
});

// --------------------------------------------------------------------------
// 3. Integration: offline monologue WRITE → VERIFY_TEXT → AUDIT_TALK
//    (no market.json → single-voice relabel of the deterministic fallback)
// --------------------------------------------------------------------------
test("offline monologue WRITE→VERIFY_TEXT→AUDIT_TALK: single-host, compliant, gates pass", async () => {
  const prevMode = process.env.HARNESS_SCRIPT_MODE;
  const prevDisable = process.env.HARNESS_DISABLE_LLM;
  const prevMax = process.env.HARNESS_MAX_DURATION_SEC;
  process.env.HARNESS_SCRIPT_MODE = "monologue";
  process.env.HARNESS_DISABLE_LLM = "1";
  process.env.HARNESS_MAX_DURATION_SEC = "150";

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pf-mono-"));
  try {
    const ctx = await buildRunContext(path.join(root, "20260531", "lens-vs-nice.html"), root);
    const state = createRunState(ctx.matchId, ctx.reportPath);

    await writeJson(ctx.paths.blocks, syntheticBlocks(ctx.reportPath));
    await writeJson(ctx.paths.talkPlan, syntheticPlan(ctx.matchId));

    const wr = await write(ctx, state, []);
    assert.ok(wr.ok, "WRITE should succeed");

    const dlg = await readJson<DialogueFile>(ctx.paths.dialogue);
    // (a) mode stamped into the artifact
    assert.equal(dlg.mode, "monologue");
    // (b) every line is voiced by the single Narrator
    const speakers = new Set(dlg.scenes.flatMap(s => s.lines).map(l => l.speaker));
    assert.deepEqual([...speakers], ["Narrator"], `monologue must be single-host: got ${[...speakers]}`);
    // (c) first spoken line is a Narrator brand welcome
    const first = dlg.scenes[0]!.lines[0]!;
    assert.equal(first.speaker, "Narrator");
    assert.ok(first.text.includes(COMPLIANCE_POLICY.brand), `welcome should name brand: ${first.text}`);
    // (d) compliance read-out survives
    const allText = dlg.scenes.flatMap(s => s.lines).map(l => l.text).join(" ");
    assert.match(allText, /体育数据讨论/);
    assert.match(allText, /结果承诺/);
    assert.match(allText, /参与决策依据/);

    const vt = await verifyText(ctx, state, []);
    assert.ok(vt.ok, `VERIFY_TEXT should pass: ${JSON.stringify(vt.issues?.filter(i => i.severity === "error"))}`);
    // No dual-host-only complaints in monologue mode
    assert.ok(!vt.issues?.some(i => i.kind === "text-scene-single-speaker"),
      "monologue must not raise text-scene-single-speaker");

    const at = await auditTalkTrack(ctx, state, []);
    assert.ok(at.ok, `AUDIT_TALK should pass: ${JSON.stringify(at.issues?.filter(i => i.severity === "error"))}`);
    assert.ok(!at.issues?.some(i => i.kind === "talk-audit-dual-host-cadence"),
      "monologue must not raise talk-audit-dual-host-cadence");
    assert.ok(!at.issues?.some(i => i.kind === "talk-audit-speaker-balance"),
      "monologue must not raise talk-audit-speaker-balance");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    restore("HARNESS_SCRIPT_MODE", prevMode);
    restore("HARNESS_DISABLE_LLM", prevDisable);
    restore("HARNESS_MAX_DURATION_SEC", prevMax);
  }
});

// --------------------------------------------------------------------------
// 4. Gate branching: the SAME single-speaker dialogue fails the dual-host gate
//    in podcast mode but passes in monologue mode; restricted terms still fail.
// --------------------------------------------------------------------------
test("AUDIT_TALK: single-speaker dialogue fails as podcast but passes as monologue", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pf-mono-gate-"));
  try {
    const ctx = await buildRunContext(path.join(root, "20260531", "x.html"), root);
    const state = createRunState(ctx.matchId, ctx.reportPath);
    await writeJson(ctx.paths.talkPlan, twoActPlan(ctx.matchId));

    // podcast: a single-speaker track is a hard dual-host failure
    await writeJson(ctx.paths.dialogue, monologueDialogue("podcast"));
    const asPodcast = await auditTalkTrack(ctx, state, []);
    assert.ok(!asPodcast.ok, "single-speaker dialogue must fail audit in podcast mode");
    assert.ok(asPodcast.issues?.some(i => i.kind === "talk-audit-dual-host-cadence"),
      "podcast should flag dual-host cadence");

    // monologue: same track is valid
    await writeJson(ctx.paths.dialogue, monologueDialogue("monologue"));
    const asMono = await auditTalkTrack(ctx, state, []);
    assert.ok(asMono.ok, `monologue should pass: ${JSON.stringify(asMono.issues?.filter(i => i.severity === "error"))}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("AUDIT_TALK still catches restricted terms in monologue mode", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pf-mono-restr-"));
  try {
    const ctx = await buildRunContext(path.join(root, "20260531", "x.html"), root);
    const state = createRunState(ctx.matchId, ctx.reportPath);
    await writeJson(ctx.paths.talkPlan, twoActPlan(ctx.matchId));

    const dlg = monologueDialogue("monologue");
    // Plant a restricted compliance term (庄家) into a content line.
    dlg.scenes[0]!.lines[2]!.text = "都说这场稳，背后是庄家在推。";
    await writeJson(ctx.paths.dialogue, dlg);

    const at = await auditTalkTrack(ctx, state, []);
    assert.ok(!at.ok, "restricted term must fail the audit even in monologue mode");
    assert.ok(at.issues?.some(i => i.kind === "talk-audit-restricted-terms"),
      "should flag talk-audit-restricted-terms");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// fixtures
// --------------------------------------------------------------------------
function nLine(sceneId: string, n: number, text: string): SceneDialogue["lines"][number] {
  return { id: `${sceneId}-l${n}`, sceneId, speaker: "Narrator", text, ssml: "", targetSec: 2, estChars: 8 };
}

function monologueDialogue(mode: "podcast" | "monologue"): DialogueFile {
  const scenes: SceneDialogue[] = [
    { sceneId: "s01", lines: [
      nLine("s01", 1, `欢迎来到${COMPLIANCE_POLICY.brand}，我是${SPEAKER_DISPLAY.Narrator}。`),
      nLine("s01", 2, "这场我先把底牌摊给你。"),
      nLine("s01", 3, "都说主队稳赢，可你真信吗？"),
      nLine("s01", 4, "越被看好的一方，压力其实越大。"),
    ] },
    { sceneId: "s02", lines: [
      nLine("s02", 1, "所以这场的真相，热门看着稳，变数一直在。"),
      nLine("s02", 2, "以上内容仅供体育数据讨论。"),
      nLine("s02", 3, "模型概率不代表比赛结果承诺。"),
      nLine("s02", 4, "请理性看球，不作为任何参与决策依据。"),
    ] },
  ];
  return {
    matchId: "t", mode, scenes,
    totalEstSec: 30, totalChars: 120, createdAt: new Date().toISOString(),
  };
}

function twoActPlan(matchId: string): TalkPlan {
  const scene = (id: string, title: string, beat: any): Scene => ({
    id, title, narrativeBeat: beat, blockRefs: [], dataPointRefs: [], targetSec: 18,
    transitionIn: "none", visualSpec: { kind: "cover-anime", props: {} },
  });
  return {
    matchId, totalTargetSec: 120,
    scenes: [scene("s01", "结论先行", "hook"), scene("s02", "收尾", "outro")],
    dropped: [], createdAt: new Date().toISOString(),
  };
}

function syntheticPlan(matchId: string): TalkPlan {
  const scene = (id: string, title: string, kind: any, beat: any, blockRefs: string[], targetSec: number, props: any = {}): Scene => ({
    id, title, narrativeBeat: beat, blockRefs, dataPointRefs: [], targetSec,
    transitionIn: "none", visualSpec: { kind, props },
  });
  return {
    matchId,
    totalTargetSec: 180,
    scenes: [
      scene("s01", "赛前看点", "hook", "hook", [], 18, { matchZh: "朗斯 VS 尼斯" }),
      scene("s02", "模型分布", "bars", "data-drill", ["b-bars", "b-kpi"], 34),
      scene("s03", "两队对照", "comparison", "comparison", ["b-table"], 32),
      scene("s04", "赛前反思", "risk", "risk", ["b-list"], 28),
      scene("s05", "模型情景", "strategy-cards", "recommendation", ["b-strat"], 30),
      scene("s06", "内容边界", "compliance", "compliance", [], 18),
    ],
    dropped: [],
    createdAt: new Date().toISOString(),
  };
}

function syntheticBlocks(reportPath: string): BlocksFile {
  const blocks: Block[] = [
    {
      kind: "meta", id: "b-meta", headingPath: [], importance: 0.9, dataPoints: [],
      match: "Lens vs Nice", matchZh: "朗斯 VS 尼斯", league: "法甲",
      kickoff: "法甲 · 北京时间 2026-05-31 03:00 · 周六014", venue: "博拉尔特球场", tags: [],
    },
    {
      kind: "bar-list", id: "b-bars", headingPath: ["模型分布"], importance: 0.8,
      dataPoints: [], title: "胜平负分布",
      items: [
        { label: "朗斯胜", probability: 0.46, pills: [] },
        { label: "平局", probability: 0.29, pills: [] },
        { label: "尼斯胜", probability: 0.25, pills: [] },
      ],
    },
    {
      kind: "kpi-grid", id: "b-kpi", headingPath: ["模型分布"], importance: 0.7, dataPoints: [],
      items: [
        { id: "k1", label: "朗斯主场进球均值", value: "1.6", tone: "good", numeric: 1.6 },
        { id: "k2", label: "尼斯客场失球均值", value: "1.4", tone: "warn", numeric: 1.4 },
        { id: "k3", label: "两队近期交手", value: "3胜2平", tone: "neutral" },
      ],
    },
    {
      kind: "table", id: "b-table", headingPath: ["两队对照"], importance: 0.7, dataPoints: [],
      headers: ["项", "朗斯", "尼斯"],
      rows: [
        [{ text: "近五场", pills: [], tone: "neutral" }, { text: "三胜两平", pills: [], tone: "good" }, { text: "两胜两平一负", pills: [], tone: "neutral" }],
        [{ text: "主客状态", pills: [], tone: "neutral" }, { text: "主场偏强", pills: [], tone: "good" }, { text: "客场偏稳", pills: [], tone: "neutral" }],
        [{ text: "进攻", pills: [], tone: "neutral" }, { text: "1.6", numeric: 1.6, pills: [], tone: "good" }, { text: "1.2", numeric: 1.2, pills: [], tone: "neutral" }],
      ],
    },
    {
      kind: "list", id: "b-list", headingPath: ["赛前反思"], importance: 0.6, dataPoints: [], ordered: false,
      items: [
        { text: "模型只能描述大致方向，球场永远有变量。", emphasis: [] },
        { text: "主场气势能放大朗斯的反扑强度。", emphasis: [] },
        { text: "尼斯客场偏稳，平局并非没机会。", emphasis: [] },
        { text: "把分布当导航，而不是当结论。", emphasis: [] },
      ],
    },
    {
      kind: "strategy-card", id: "b-strat", headingPath: ["模型情景"], importance: 0.6, dataPoints: [],
      name: "稳健情景", goal: "看常规赛果分布",
      allocations: [
        { market: "胜平负", option: "朗斯不败" },
        { market: "总进球", option: "两到三球" },
      ],
      summary: ["更关注常规赛果", "进球波动有限"],
    },
  ];
  return {
    reportPath,
    parsedAt: new Date().toISOString(),
    blocks,
    stats: { total: blocks.length, byKind: {}, unknownPct: 0, highImportanceCount: 3 },
  };
}
