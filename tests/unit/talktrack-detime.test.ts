import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  stripTimeConcepts,
  writeScene,
  repairCompliancePhrases,
  ensureBrandWelcome,
  enforceDualHostCadence,
  write,
  type AdaptiveKnobs,
} from "../../src/phases/03-write.js";
import { verifyText } from "../../src/phases/04-verify-text.js";
import { auditTalkTrack } from "../../src/phases/04b-audit-talk.js";
import { buildRunContext, writeJson, readJson } from "../../src/orchestrator/runContext.js";
import { createRunState } from "../../src/orchestrator/stateMachine.js";
import { COMPLIANCE_POLICY } from "../../src/tools/compliancePolicy.js";
import type { Scene, TalkPlan } from "../../src/schemas/talkPlan.js";
import type { Block, BlocksFile } from "../../src/schemas/block.js";
import type { DialogueFile, SceneDialogue } from "../../src/schemas/dialogue.js";

// Publish-time tokens that must NEVER reach the spoken script. Football
// in-match vocabulary (上半场 / 补时 / 读秒 / 第九十分钟 …) is intentionally
// excluded from this list.
const FORBIDDEN_TIME = [
  "今晚", "今夜", "明晚", "昨晚", "今天", "明天", "昨天", "今日", "明日", "昨日",
  "后天", "前天", "北京时间", "几点", "三分钟之内", "三分钟左右", "时间不多",
  "这期视频", "本期视频", "马上", "即将",
];

function assertNoForbiddenTime(text: string, ctx: string): void {
  for (const tok of FORBIDDEN_TIME) {
    assert.ok(!text.includes(tok), `${ctx}: should not contain time concept "${tok}" — got: ${text}`);
  }
}

// --------------------------------------------------------------------------
// 1. stripTimeConcepts: removes publish/calendar/clock/duration, keeps football
// --------------------------------------------------------------------------
test("stripTimeConcepts removes calendar / clock / publish-duration words", () => {
  assert.equal(stripTimeConcepts("今晚这场朗斯对尼斯，看点都有哪些？").startsWith("这场朗斯对尼斯"), true);
  assert.ok(!stripTimeConcepts("明晚的趋势怎么看？").includes("明晚"));
  assert.ok(!stripTimeConcepts("用三分钟讲透分布。").includes("三分钟"));
  assert.ok(!stripTimeConcepts("好，三分钟之内把走势讲透。").includes("三分钟之内"));
  assert.ok(!stripTimeConcepts("北京时间晚上八点开球。").includes("北京时间"));
  assert.ok(!stripTimeConcepts("几点开球？").includes("几点"));
  assert.ok(!stripTimeConcepts("时间不多，直接进入看点。").includes("时间不多"));
  assert.equal(stripTimeConcepts("今天的分析就到这里。"), "这场的分析就到这里。");
});

test("stripTimeConcepts preserves '赛前' and legitimate football vocabulary", () => {
  const keep = [
    "赛前概率观察",
    "本内容仅作赛前概率观察和体育数据讨论。",
    "上半场尼斯压制，下半场朗斯反扑。",
    "补时阶段还有变数，读秒时刻别松懈。",
    "第九十分钟才打破僵局。",
    "近五场朗斯三胜两平，本赛季主场很稳。",
    "记得点关注，这场我们接着看。",
    "九十分钟内分出胜负的可能性更高。",
  ];
  for (const s of keep) {
    assert.equal(stripTimeConcepts(s), s, `should leave football/compliance text untouched: ${s}`);
  }
});

// --------------------------------------------------------------------------
// 3. Deterministic writeScene fallback: no time concepts, references fixture
// --------------------------------------------------------------------------
function knobs(): AdaptiveKnobs {
  return { sceneSecScale: 1, extraFillersPerScene: new Map<string, number>(), extraBanned: new Set<string>() };
}

test("deterministic writeScene hook references the fixture and carries no time concepts", () => {
  const hook: Scene = {
    id: "s01",
    title: "赛前看点",
    narrativeBeat: "hook",
    blockRefs: [],
    dataPointRefs: [],
    targetSec: 20,
    transitionIn: "none",
    visualSpec: { kind: "hook", props: { matchZh: "朗斯 VS 尼斯", kickoff: "欧冠 · 北京时间 2026-05-31 00:00 · 周六014" } },
  };
  const plan: TalkPlan = {
    matchId: "t",
    totalTargetSec: 140,
    scenes: [hook],
    dropped: [],
    createdAt: new Date().toISOString(),
  };
  const lines = writeScene(hook, new Map<string, Block>(), knobs(), plan);
  const joined = lines.map(l => l.text).join(" ");
  assert.ok(joined.includes("朗斯"), `hook should name the fixture: ${joined}`);
  assertNoForbiddenTime(joined, "deterministic hook");
  // hook still carries the opening compliance phrase
  assert.match(joined, /赛前概率观察/);
  // The female host (Anchor) leads the whole opening: welcome → compliance →
  // question, all spoken by 小美. The male host (Analyst) only answers after.
  assert.equal(lines[0]!.speaker, "Anchor");
  assert.ok(lines[0]!.text.includes(COMPLIANCE_POLICY.brand), `welcome should name the brand: ${lines[0]!.text}`);
  assert.equal(lines[1]!.speaker, "Anchor");
  assert.match(lines[1]!.text, /赛前概率观察/);
  assert.equal(lines[2]!.speaker, "Anchor");
  assert.match(lines[2]!.text, /[？?]/);
  // The first Analyst line appears only after the female-led opening trio.
  const firstAnalystIdx = lines.findIndex(l => l.speaker === "Analyst");
  assert.equal(firstAnalystIdx, 3, "male host should speak only after the female welcome/compliance/question");
});

// --------------------------------------------------------------------------
// 3b. ensureBrandWelcome: guarantees the opening Anchor brand welcome
// --------------------------------------------------------------------------
test("ensureBrandWelcome inserts a brand welcome as the first Anchor line", () => {
  const scenes: SceneDialogue[] = [
    { sceneId: "s01", lines: [
      { id: "s01-l1", sceneId: "s01", speaker: "Analyst", text: "比利时一侧可能性稍高。", ssml: "", targetSec: 2, estChars: 10 },
    ] },
  ];
  ensureBrandWelcome(scenes);
  const first = scenes[0]!.lines[0]!;
  assert.equal(first.speaker, "Anchor");
  assert.ok(first.text.includes(COMPLIANCE_POLICY.brand), `inserted welcome should name the brand: ${first.text}`);
  assertNoForbiddenTime(first.text, "inserted welcome");
});

test("ensureBrandWelcome is idempotent when a brand welcome already leads", () => {
  const scenes: SceneDialogue[] = [
    { sceneId: "s01", lines: [
      { id: "s01-l1", sceneId: "s01", speaker: "Anchor", text: `欢迎来到${COMPLIANCE_POLICY.brand}，我是小美。`, ssml: "", targetSec: 2, estChars: 12 },
      { id: "s01-l2", sceneId: "s01", speaker: "Analyst", text: "先说明一下。", ssml: "", targetSec: 2, estChars: 6 },
    ] },
  ];
  const before = scenes[0]!.lines.length;
  ensureBrandWelcome(scenes);
  assert.equal(scenes[0]!.lines.length, before);
  assert.ok(scenes[0]!.lines[0]!.text.includes(COMPLIANCE_POLICY.brand));
});

// --------------------------------------------------------------------------
// 4. repairCompliancePhrases: inserts only the closing phrases (v2: no opening)
// --------------------------------------------------------------------------
test("repairCompliancePhrases inserts closing compliance phrases and leaves the opening untouched", () => {
  const scenes: SceneDialogue[] = [
    { sceneId: "s01", lines: [
      { id: "s01-l1", sceneId: "s01", speaker: "Anchor", text: "朗斯对尼斯这场，看点在哪？", ssml: "", targetSec: 2, estChars: 10 },
    ] },
    { sceneId: "s09", lines: [
      { id: "s09-l1", sceneId: "s09", speaker: "Anchor", text: "最后唠叨几句。", ssml: "", targetSec: 2, estChars: 6 },
    ] },
  ];
  repairCompliancePhrases(scenes);
  const openText = scenes[0]!.lines.map(l => l.text).join(" ");
  const closeText = scenes[scenes.length - 1]!.lines.map(l => l.text).join(" ");
  // v2: no opening compliance read-out — the opening scene keeps its single line.
  assert.equal(scenes[0]!.lines.length, 1, "opening scene should not gain a compliance line");
  assert.doesNotMatch(openText, /赛前概率观察/);
  // Closing still carries the full compliance read-out, spoken by the male host.
  assert.match(closeText, /体育数据讨论/);
  assert.match(closeText, /结果承诺/);
  assert.match(closeText, /参与决策依据/);
  const closeCmpl = scenes[scenes.length - 1]!.lines.find(l => /结果承诺/.test(l.text));
  assert.equal(closeCmpl?.speaker, "Analyst", "closing compliance should be spoken by Analyst (male)");
});

// --------------------------------------------------------------------------
// 4b. enforceDualHostCadence: breaks ≥3 same-speaker runs (except compliance)
// --------------------------------------------------------------------------
function maxStreak(lines: { speaker: string }[]): number {
  let best = 0, cur = 0, prev: string | null = null;
  for (const l of lines) { cur = l.speaker === prev ? cur + 1 : 1; prev = l.speaker; if (cur > best) best = cur; }
  return best;
}

test("enforceDualHostCadence guarantees no ≥3 same-speaker run in non-compliance scenes", () => {
  const mk = (sceneId: string, speaker: "Anchor" | "Analyst", n: number) =>
    ({ id: `${sceneId}-l${n}`, sceneId, speaker, text: `第${n}句内容。`, ssml: "", targetSec: 2, estChars: 5 });
  const scenes: SceneDialogue[] = [
    { sceneId: "s02", lines: [
      mk("s02", "Anchor", 1), mk("s02", "Analyst", 2), mk("s02", "Analyst", 3),
      mk("s02", "Analyst", 4), mk("s02", "Analyst", 5), mk("s02", "Anchor", 6),
    ] },
    { sceneId: "s06", lines: [ // compliance — allowed to have a long Analyst run
      mk("s06", "Anchor", 1), mk("s06", "Analyst", 2), mk("s06", "Analyst", 3), mk("s06", "Analyst", 4),
    ] },
  ];
  const plan = {
    scenes: [
      { id: "s02", narrativeBeat: "data-drill" },
      { id: "s06", narrativeBeat: "compliance" },
    ],
  } as any;

  assert.ok(maxStreak(scenes[0]!.lines) >= 3, "precondition: s02 has a 3+ Analyst run");
  enforceDualHostCadence(scenes, plan);
  assert.ok(maxStreak(scenes[0]!.lines) <= 2, "content scene must have no ≥3 same-speaker run after repair");
  // compliance scene is intentionally left untouched
  assert.equal(scenes[1]!.lines.length, 4, "compliance scene should be unchanged");
  // inserted reaction lines carry no time concepts
  assertNoForbiddenTime(scenes[0]!.lines.map(l => l.text).join(" "), "cadence-inserted beats");
});

// --------------------------------------------------------------------------
// 5. Integration guard (non-skipped): WRITE → VERIFY_TEXT → AUDIT_TALK offline.
//    Confirms the de-timed deterministic fallback still satisfies compliance,
//    char floor and dual-host cadence — covers the gap when the external e2e
//    fixture is absent.
// --------------------------------------------------------------------------
test("offline WRITE→VERIFY_TEXT→AUDIT_TALK: de-timed fallback stays compliant", async () => {
  const prevDisable = process.env.HARNESS_DISABLE_LLM;
  const prevMax = process.env.HARNESS_MAX_DURATION_SEC;
  process.env.HARNESS_DISABLE_LLM = "1";
  process.env.HARNESS_MAX_DURATION_SEC = "150";

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pf-detime-"));
  try {
    const ctx = await buildRunContext(path.join(root, "20260531", "lens-vs-nice.html"), root);
    const state = createRunState(ctx.matchId, ctx.reportPath);

    await writeJson(ctx.paths.blocks, syntheticBlocks(ctx.reportPath));
    await writeJson(ctx.paths.talkPlan, syntheticPlan(ctx.matchId));

    const wr = await write(ctx, state, []);
    assert.ok(wr.ok, "WRITE should succeed");

    const dlg = await readJson<DialogueFile>(ctx.paths.dialogue);
    const allText = dlg.scenes.flatMap(s => s.lines).map(l => l.text).join(" ");

    // (a) No publish-time concepts anywhere
    assertNoForbiddenTime(allText, "offline dialogue");
    // (b) Fixture is referenced by team names
    assert.ok(allText.includes("朗斯") || allText.includes("尼斯"), "dialogue should name the fixture");
    // (c) Compliance phrases survive
    assert.match(allText, /赛前概率观察/);
    assert.match(allText, /体育数据讨论/);
    assert.match(allText, /结果承诺/);
    assert.match(allText, /参与决策依据/);
    // (d) Char floor met with margin
    assert.ok(dlg.totalChars >= 520, `total chars ${dlg.totalChars} should clear the char floor`);

    const vt = await verifyText(ctx, state, []);
    assert.ok(vt.ok, `VERIFY_TEXT should pass: ${JSON.stringify(vt.issues?.filter(i => i.severity === "error"))}`);

    const at = await auditTalkTrack(ctx, state, []);
    assert.ok(at.ok, `AUDIT_TALK should pass: ${JSON.stringify(at.issues?.filter(i => i.severity === "error"))}`);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    restore("HARNESS_DISABLE_LLM", prevDisable);
    restore("HARNESS_MAX_DURATION_SEC", prevMax);
  }
});

function restore(key: string, val: string | undefined): void {
  if (val === undefined) delete process.env[key];
  else process.env[key] = val;
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
