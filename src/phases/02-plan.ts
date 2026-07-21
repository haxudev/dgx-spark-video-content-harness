import { readJson, writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import { type BlocksFile, type Block } from "../schemas/block.js";
import {
  TalkPlanSchema,
  type TalkPlan,
  type Scene,
  type VisualKind,
  type NarrativeBeat,
} from "../schemas/talkPlan.js";
import { durationPolicy } from "../tools/durationPolicy.js";

/**
 * PLAN phase (v2) — produces a FIXED four-act storyboard. The dynamic
 * chapter-clustering / risk / strategy / compliance machinery of v1 is gone:
 * the simplified deck is always exactly four scenes that mirror the report's
 * own structure, and the compliance disclaimer is folded into the Act-1 open
 * and Act-4 close narration (WRITE emits the required phrases).
 *
 *   Act 1  cover-anime          结论先行 · 全屏动漫封面（双方/胜平负/比分top3/球数top3）
 *   Act 2  fundamentals-signal  球队基本面对比 + 风向标（隐含/公允/模型概率 + 漂移）
 *   Act 3  market-grid          模型概率分布（胜平负/总进球/比分/半全场）— 不变
 *   Act 4  upset-dashboard      爆冷可能性分析（量级/复杂性/主要驱动/潜在比分）
 *
 * Blocks are mapped to acts by their h2 chapter title so the dialogue writer
 * still has real, traceable numbers per act; all heavy visuals are driven by
 * the structured MarketData in COMPOSE rather than by Block voting.
 */

const CPS = 3.7;                  // Chinese chars per second (incl. SSML breaks) — calibrated for Qwen3-TTS

export const plan = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const blocks = await readJson<BlocksFile>(ctx.paths.blocks);
  const policy = durationPolicy();
  const tp = buildPlan(blocks);
  await writeJson(ctx.paths.talkPlan, tp);

  const issues: Issue[] = [];
  if (tp.scenes.length !== 4) issues.push({ kind: "plan-wrong-scene-count", severity: "error", message: `expected 4 acts, got ${tp.scenes.length}` });
  if (!tp.scenes.find(s => s.narrativeBeat === "hook")) issues.push({ kind: "plan-missing-hook", severity: "error", message: "no opening cover scene" });

  const hardErr = issues.some(i => i.severity === "error");
  return { ok: !hardErr, issues };
};

type ChapterKind = "fundamentals" | "market" | "upset" | "other";

export function buildPlan(file: BlocksFile): TalkPlan {
  const policy = durationPolicy();
  const blocks = file.blocks;
  const meta = blocks.find(b => b.kind === "meta") as (Block & { kind: "meta" }) | undefined;
  const matchZh = meta?.matchZh ?? meta?.match ?? "本场比赛";

  // Bucket blocks by report chapter so each act gets traceable numbers.
  const byChapter: Record<ChapterKind, Block[]> = { fundamentals: [], market: [], upset: [], other: [] };
  for (const b of blocks) {
    if (b.kind === "meta" || b.kind === "heading") continue;
    byChapter[chapterOf(b)].push(b);
  }
  const topN = (bs: Block[], n: number): Block[] =>
    bs.slice().sort((a, b) => importanceWithBoost(b) - importanceWithBoost(a)).slice(0, n);

  const metaRef = meta ? [meta.id] : [];
  const fundamentalsBlocks = topN(byChapter.fundamentals, 6);
  const marketBlocks       = topN(byChapter.market, 6);
  const upsetBlocks        = topN(byChapter.upset, 6);

  // Fixed durations, scaled to the duration target afterwards.
  const base = { cover: 26, fundamentals: 40, market: 46, upset: 36 };
  const baseSum = base.cover + base.fundamentals + base.market + base.upset;
  const scale = policy.targetSec / baseSum;
  const sec = (v: number) => clampInt(Math.round(v * scale), 10, 70);

  let seq = 0;
  const sid = () => `s${String(++seq).padStart(2, "0")}`;

  const cover: Scene = {
    id: sid(),
    title: shortMatch(matchZh).slice(0, 36),
    narrativeBeat: "hook",
    blockRefs: [...metaRef, ...topN(byChapter.market, 3).map(b => b.id)],
    dataPointRefs: pickTopDataPoints(topN(byChapter.market, 3), 4),
    targetSec: sec(base.cover),
    transitionIn: "none",
    visualSpec: {
      kind: "cover-anime",
      props: {
        match: meta?.match ?? "",
        matchZh,
        kickoff: meta?.kickoff ?? "",
        league: meta?.league ?? "",
        venue: meta?.venue ?? "",
        tags: meta?.tags ?? [],
      },
    },
  };

  const fundamentals: Scene = {
    id: sid(),
    title: "基本面与风向标",
    narrativeBeat: "comparison",
    blockRefs: [...fundamentalsBlocks.map(b => b.id), ...topN(byChapter.market, 2).map(b => b.id)],
    dataPointRefs: pickTopDataPoints(fundamentalsBlocks, 6),
    targetSec: sec(base.fundamentals),
    transitionIn: "fade",
    visualSpec: { kind: "fundamentals-signal", props: visualPropsFor(fundamentalsBlocks) },
  };

  const market: Scene = {
    id: sid(),
    title: "模型可能性分布",
    narrativeBeat: "data-drill",
    blockRefs: marketBlocks.map(b => b.id),
    dataPointRefs: pickTopDataPoints(marketBlocks, 6),
    targetSec: sec(base.market),
    transitionIn: "cross-fade-soft",
    visualSpec: { kind: "market-grid", props: visualPropsFor(marketBlocks) },
  };

  const upset: Scene = {
    id: sid(),
    title: "爆冷可能性分析",
    narrativeBeat: "reveal",
    blockRefs: upsetBlocks.map(b => b.id),
    dataPointRefs: pickTopDataPoints(upsetBlocks, 6),
    targetSec: sec(base.upset),
    transitionIn: "cross-fade-soft",
    visualSpec: { kind: "upset-dashboard", props: visualPropsFor(upsetBlocks) },
  };

  const scenes: Scene[] = [cover, fundamentals, market, upset];

  // Duration is advisory only; keep the plan near the target for pacing, without
  // imposing a hard runtime envelope. VERIFY_AV later checks audio/video sync.
  let total = scenes.reduce((s, x) => s + x.targetSec, 0);
  const adjustable = () => scenes.filter(s => s.narrativeBeat !== "hook");
  while (total > policy.hardMaxSec) {
    const adj = adjustable().sort((a, b) => b.targetSec - a.targetSec)[0];
    if (!adj || adj.targetSec <= 12) break;
    adj.targetSec -= 1; total -= 1;
  }
  while (total < policy.hardMinSec) {
    const adj = adjustable().sort((a, b) => a.targetSec - b.targetSec)[0];
    if (!adj || adj.targetSec >= 70) break;
    adj.targetSec += 1; total += 1;
  }

  return TalkPlanSchema.parse({
    matchId: file.reportPath,
    totalTargetSec: total,
    scenes,
    dropped: [],
    rationale: "v2 fixed four-act plan: cover-anime → fundamentals-signal → market-grid → upset-dashboard.",
    createdAt: new Date().toISOString(),
  });
}

// --------------------------- helpers --------------------------------------

/** Classify a block into one of the four canonical report chapters by h2 title. */
function chapterOf(b: Block): ChapterKind {
  const path = b.headingPath.join(" ");
  if (/基本面|球队.*赛事|两队|战术|阵容|历史交锋|动机|舆情/.test(path)) return "fundamentals";
  if (/模型预测|赔率|预测.*分析|胜平负|总进球|比分|半全场|盘口|市场/.test(path)) return "market";
  if (/爆冷|冷门|复杂性|潜在.*比分|尾部|upset/i.test(path)) return "upset";
  if (/策略|投注|模拟/.test(path)) return "other";
  return "other";
}

function importanceWithBoost(b: Block): number {
  let imp = b.importance;
  if (b.kind === "kpi-grid")      imp += 0.15;
  if (b.kind === "bar-list")      imp += 0.1;
  if (b.kind === "table")         imp += 0.1;
  return imp;
}

function pickTopDataPoints(bs: Block[], n: number): string[] {
  const all = bs.flatMap(b => b.dataPoints.map(dp => ({ id: dp.id, score: scoreDP(dp) })));
  return all.sort((a, b) => b.score - a.score).slice(0, n).map(x => x.id);
}

function scoreDP(dp: { kind: string; value: number | string; tone: string }): number {
  let s = 1;
  if (dp.kind === "probability") s += 2;
  if (dp.kind === "ratio") s += 1.2;
  if (dp.tone === "good" || dp.tone === "bad" || dp.tone === "hl") s += 1;
  return s;
}

function visualPropsFor(chosen: Block[]): Record<string, unknown> {
  const ids = chosen.map(b => b.id);
  return { primaryBlocks: ids.slice(0, 3), allBlocks: ids };
}

function shortMatch(matchZh: string): string {
  return matchZh.replace(/.*·\s*/, "").replace(/\s*比赛分析\s*$/, "").trim();
}

function clampInt(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(x)));
}

// Re-export the helper for downstream phases
export const CHARS_PER_SECOND = CPS;
