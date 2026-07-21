import * as fs from "node:fs/promises";
import * as path from "node:path";
import Handlebars from "handlebars";
import type { Block } from "../schemas/block.js";
import type { TalkPlan, Scene, VisualKind } from "../schemas/talkPlan.js";
import type { AudioManifest, AudioLine } from "../schemas/audioManifest.js";
import type { DialogueFile, DialogueLine } from "../schemas/dialogue.js";
import type { MarketData } from "./marketExtractor.js";
import { sanitizeRestrictedComplianceText, COMPLIANCE_POLICY } from "./compliancePolicy.js";
import { SPEAKER_DISPLAY } from "./ssml.js";
import { renderFps } from "./runProfile.js";
import { avatarLayoutCss } from "./avatarLayout.js";

export interface BuildOpts {
  blocks: Block[];
  plan: TalkPlan;
  manifest: AudioManifest;
  dialogue: DialogueFile;
  templatesDir: string;
  market?: MarketData | null;
  /** Optional relative path to the agent-generated background image (e.g. "bg.png"). */
  bgImage?: string | null;
  /** Optional relative path to the agent-generated opening cover image (e.g. "cover.png"). */
  coverImage?: string | null;
  /** Seconds the opening cover should remain visible at timeline start. */
  coverSec?: number | null;
}

const VALID_KINDS: VisualKind[] = [
  "hook", "kpi-grid", "comparison", "bars", "strategy-cards", "callout",
  "list-beats", "quote", "table-row-focus", "paragraph-flow", "risk",
  "compliance", "outro",
  // M5 extensions
  "timeline", "side-by-side-cards", "probability-map", "kelly-bar",
  // M6 — ECharts dashboards
  "team-fundamentals", "market-grid", "upset-dashboard", "strategy-board",
  "watch-boundary",
  // v2 — simplified 4-act deck
  "cover-anime", "fundamentals-signal",
];

export async function buildComposition(opts: BuildOpts): Promise<string> {
  // Register helpers and partials
  registerHelpers();
  await registerScenePartials(opts.templatesDir);

  const rootSrc = await fs.readFile(path.join(opts.templatesDir, "composition.html.hbs"), "utf8");
  const rootTpl = Handlebars.compile(rootSrc, { noEscape: false });

  const visualBlocks = sanitizeVisualData(opts.blocks) as Block[];
  const blockMap = new Map<string, Block>(visualBlocks.map(b => [b.id, b]));
  const market = sanitizeVisualData(opts.market ?? null) as MarketData | null;
  const lineMap = new Map<string, DialogueLine>(
    opts.dialogue.scenes.flatMap(s => s.lines.map(l => [l.id, l] as const)),
  );

  const scenesCtx = opts.plan.scenes.map((s) => {
    const audioScene = opts.manifest.scenes.find(a => a.sceneId === s.id);
    const data = projectScene(s, blockMap, market);
    // The Act-1 cover scene renders the agent-generated anime poster full-bleed.
    if (s.visualSpec.kind === "cover-anime") {
      (data as Record<string, unknown>).coverImage = opts.coverImage ?? null;
    }
    const audio = opts.manifest.lines
      .filter(l => l.sceneId === s.id)
      .map(al => ({ ...al, text: lineMap.get(al.id)?.text ?? "" }));
    return {
      id: s.id,
      title: s.title,
      kind: s.visualSpec.kind,
      props: s.visualSpec.props,
      data,
      audio,
      startSec: audioScene?.startSec ?? 0,
      durSec: audioScene?.durSec ?? s.targetSec,
      transitionIn: s.transitionIn,
    };
  });

  const audioLines = opts.manifest.lines.map(al => ({
    ...al,
    text: (lineMap.get(al.id)?.text ?? "").slice(0, 220),
  }));

  const totalSec = opts.manifest.totalSec;

  return rootTpl({
    matchId: safeId(opts.plan.matchId),
    brand: COMPLIANCE_POLICY.brand,
    headerLabel: COMPLIANCE_POLICY.headerLabel,
    bgImage: opts.bgImage ?? null,
    // v2: the opening cover is a full Act-1 scene (rendered inside the
    // cover-anime partial), not a timeline-0 overlay — disable the legacy
    // top-level cover-poster so it never lingers over later scenes.
    coverImage: null,
    coverSec: 0,
    totalSec,
    fps: renderFps(),
    scenes: scenesCtx,
    audioLines,
    avatarLayoutCss: new Handlebars.SafeString(avatarLayoutCss()),
    chartsJson: JSON.stringify({
      hero:        market?.hero        ?? null,
      market1x2:   market?.market1x2   ?? null,
      result1x2:   result1x2(market),
      totalGoals:  market?.totalGoals  ?? null,
      correctScore:market?.correctScore?? null,
      htft:        market?.htft        ?? null,
      upset:       market?.upset       ?? null,
      marketSignal:buildSignal1x2(market),
      compareMetrics: buildCompareMetrics(market),
      strategy:    null,
      fundamentals:market?.fundamentals?? null,
      boundary: {
        market1x2: market?.market1x2 ?? null,
        totalGoals: market?.totalGoals ?? null,
        upset: market?.upset ?? null,
      },
    }),
    speakerDisplay: SPEAKER_DISPLAY,
    generatedAt: new Date().toISOString(),
  });
}

function sanitizeVisualData(value: unknown): unknown {
  if (typeof value === "string") return sanitizeRestrictedComplianceText(value);
  if (Array.isArray(value)) return value.map(sanitizeVisualData);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitizeVisualData(v)]));
  }
  return value;
}

/** Sanitize LLM-summarised reflection cards so compliance terms don't reach composition.html. */
function sanitizeCardsList(cards: unknown[]): unknown[] {
  return cards.map((c: unknown) => {
    if (!c || typeof c !== "object") return c;
    const o = c as Record<string, unknown>;
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === "string") {
        sanitized[k] = sanitizeRestrictedComplianceText(v);
      }
      else if (Array.isArray(v)) {
        sanitized[k] = v.map(s => typeof s === "string" ? sanitizeRestrictedComplianceText(s) : s);
      }
      else {
        sanitized[k] = v;
      }
    }
    return sanitized;
  });
}

function projectScene(scene: Scene, blockMap: Map<string, Block>, market: MarketData | null): any {
  const blocks = scene.blockRefs.map(id => blockMap.get(id)).filter((b): b is Block => !!b);
  // Provide a shape the scene partials can rely on
  const project: any = {
    sceneTitle: scene.title,
    blocks,
    // common slices
    kpis: blocks.filter(b => b.kind === "kpi-grid"),
    tables: blocks.filter(b => b.kind === "table"),
    barLists: blocks.filter(b => b.kind === "bar-list"),
    strategies: blocks.filter(b => b.kind === "strategy-card"),
    callouts: blocks.filter(b => b.kind === "callout"),
    lists: blocks.filter(b => b.kind === "list"),
    paragraphs: blocks.filter(b => b.kind === "paragraph"),
    meta: blocks.find(b => b.kind === "meta"),
  };

  // M6: rich market data slices for ECharts-driven partials. Each slice is
  // attached only when both the scene kind and the market region exist —
  // partials still degrade gracefully when missing.
  if (market) {
    project.market = market;
    if (scene.visualSpec.kind === "team-fundamentals") {
      project.fundamentals = market.fundamentals;
      project.hero = market.hero;
    }
    if (scene.visualSpec.kind === "cover-anime") {
      project.hero = market.hero;
      project.fundamentals = market.fundamentals;
      project.market1x2 = market.market1x2;
      project.totalGoals = market.totalGoals;
      project.correctScore = market.correctScore;
    }
    if (scene.visualSpec.kind === "fundamentals-signal") {
      project.fundamentals = market.fundamentals;
      project.hero = market.hero;
      project.marketSignal = buildSignal1x2(market);
      project.compareMetrics = buildCompareMetrics(market);
    }
    if (scene.visualSpec.kind === "market-grid") {
      // 赛果分布 is 胜负平-only — drop 让球 so the donut + 较高情景 summary never show 让胜/让平/让负.
      project.market1x2    = result1x2(market) ?? market.market1x2;
      project.totalGoals   = market.totalGoals;
      project.correctScore = market.correctScore;
      project.htft         = market.htft;
    }
    if (scene.visualSpec.kind === "upset-dashboard") {
      project.upset = market.upset;
      if (project.upset) {
        project.upset = {
          ...project.upset,
          upsetLabel: inferUpsetLabel(market),
        };
        // 爆冷指标: drop 预期进球 and keep the other four for a clean 2×2 grid.
        if (Array.isArray(project.upset.complexityMetrics)) {
          project.upset.complexityMetrics = project.upset.complexityMetrics
            .filter((m: any) => !/预期进球|期望进球/.test(String(m?.label ?? "")))
            .slice(0, 4);
        }
      }
      // Fallback: many reports ship an empty `.upset-score-card` grid, which
      // leaves a large blank gap in the scene. When the upset block exists but
      // carries no per-score breakdown, synthesise it from the correct-score
      // Top-N list (same data, different DOM region) so the panel stays full.
      if (project.upset && (!Array.isArray(project.upset.scores) || project.upset.scores.length === 0)) {
        const top = market.correctScore?.topScores ?? [];
        if (top.length) {
          // Determine the favoured side from 1x2 so we can label scorelines as
          // "符合热门" vs "爆冷" without hard-coding team identities.
          const outs = market.market1x2?.outcomes ?? [];
          let favRole = "";
          if (outs.length) {
            favRole = outs.reduce((m, o) => (o.pct > m.pct ? o : m), outs[0]!).role;
          }
          const favHome = favRole.includes("主");
          const favAway = favRole.includes("客");
          const derived = top.slice(0, 4).map((s, i) => {
            const m = String(s.score).match(/(\d+)\s*[-:：]\s*(\d+)/);
            const h = m ? Number(m[1]) : NaN;
            const a = m ? Number(m[2]) : NaN;
            let interp = "比分胶着";
            if (Number.isFinite(h) && Number.isFinite(a)) {
              if (h === a) interp = "平局僵持";
              else if (h > a) interp = favAway ? "主队爆冷领先" : "主队领先";
              else interp = favHome ? "客队爆冷反击" : "客队占先";
            }
            return { score: String(s.score), pct: s.pct, interp, top: s.lead === true || i === 0 };
          });
          project.upset = { ...project.upset, scores: derived };
        }
      }
      // 爆冷下方固定的 2×2 四卡：把最有信息量的爆冷信号收敛成正好四张卡片，
      // 不依赖 drivers（很多报告为空）也能稳定铺满。
      if (project.upset) {
        project.upset.cards = buildUpsetCards(project.upset);
      }
    }
    if (scene.visualSpec.kind === "strategy-board" || scene.visualSpec.kind === "watch-boundary") {
      project.strategy = market.strategy;
    }
    if (scene.visualSpec.kind === "hook") {
      project.hero = market.hero;
      // Surface a compact model snapshot so the cover scene isn't a near-empty
      // centred card — fills the upper gap with 1x2 odds + expected goals.
      project.market1x2  = market.market1x2;
      project.totalGoals = market.totalGoals;
    }
  }

  // Surface LLM-summarised cards (set by WRITE phase) into the projected
  // scene data so handlebars partials can pick them up. Each kind has its
  // own override field:
  //   - risk:               props.reflectionCards         → data.reflectionCards
  //   - team-fundamentals:  props.fundamentalsHighlights  → data.fundamentals.highlights
  //   - upset-dashboard:    props.upsetInterpretCards     → data.upset.interpretCards
  // Each falls through to the deterministic compose-time path when missing.
  const propsRef = scene.visualSpec.props as Record<string, unknown> | undefined;
  if (propsRef) {
    if (Array.isArray(propsRef.reflectionCards)) {
      project.reflectionCards = sanitizeCardsList(propsRef.reflectionCards);
    }
    if (scene.visualSpec.kind === "team-fundamentals" && Array.isArray(propsRef.fundamentalsHighlights)) {
      if (!project.fundamentals) project.fundamentals = {};
      project.fundamentals.highlights = propsRef.fundamentalsHighlights;
    }
    if (scene.visualSpec.kind === "upset-dashboard" && Array.isArray(propsRef.upsetInterpretCards)) {
      if (!project.upset) project.upset = {};
      project.upset.interpretCards = sanitizeCardsList(propsRef.upsetInterpretCards);
    }
  }

  return project;
}

function inferUpsetLabel(market: MarketData): string {
  const fav = market.upset?.favTeam?.trim();
  const home = market.hero?.homeName?.trim() || market.fundamentals?.homeName?.trim();
  const away = market.hero?.awayName?.trim() || market.fundamentals?.awayName?.trim();
  if (fav && home && fav === home && away) return `${away}不输`;
  if (fav && away && fav === away && home) return `${home}不输`;
  return "非热门方向";
}

/**
 * Curate exactly four KPI cards for the Act-4 爆冷 2×2 grid (rendered below the
 * gauge). Priority: 综合爆冷可能性 → 热门方优势 → up to two 爆冷指标
 * (complexityMetrics) → top 潜在爆冷比分 as filler. Always returns ≤4, padding
 * from whatever upset signals exist so the grid is never half-empty regardless
 * of the report shape (drivers are frequently empty).
 */
interface UpsetCard { label: string; value: string; detail: string; accentPct: number | null; tone: string; }
function buildUpsetCards(upset: any): UpsetCard[] {
  if (!upset) return [];
  const pctNum = (s: unknown): number | null => {
    const m = String(s ?? "").match(/-?\d+(?:\.\d+)?/);
    return m ? Number(m[0]) : null;
  };
  const cards: UpsetCard[] = [];
  const detail = (s: unknown) => sanitizeRestrictedComplianceText(String(s ?? ""));
  if (upset.probPct) {
    cards.push({ label: "综合爆冷可能性", value: String(upset.probPct), detail: detail(upset.band ?? "模型综合判断"), accentPct: pctNum(upset.probPct), tone: "hot" });
  }
  if (upset.favTeam || upset.favPct) {
    cards.push({ label: "热门方优势", value: String(upset.favPct ?? "—"), detail: upset.favTeam ? `${upset.favTeam} 占优` : "模型偏向", accentPct: pctNum(upset.favPct), tone: "fav" });
  }
  for (const m of (Array.isArray(upset.complexityMetrics) ? upset.complexityMetrics : [])) {
    if (cards.length >= 4) break;
    if (!m || !m.label) continue;
    cards.push({ label: String(m.label), value: String(m.value ?? ""), detail: detail(m.detail), accentPct: typeof m.pct === "number" ? m.pct : pctNum(m.value), tone: "metric" });
  }
  for (const s of (Array.isArray(upset.scores) ? upset.scores : [])) {
    if (cards.length >= 4) break;
    if (!s || !s.score) continue;
    cards.push({ label: `潜在爆冷比分 ${s.score}`, value: `${s.pct}%`, detail: detail(s.interp), accentPct: typeof s.pct === "number" ? s.pct : pctNum(s.pct), tone: "score" });
  }
  return cards.slice(0, 4);
}

/**
 * Build the Act-2 team-comparison metrics (实力评分 / 近期场均 / 预期进球) from
 * the parsed fundamentals + complexity data. Each metric carries both teams'
 * numeric value so the client renders a normalised "tug of war" bar pair.
 */
function buildCompareMetrics(market: MarketData | null): Array<{ label: string; home: number; away: number }> {
  if (!market) return [];
  const out: Array<{ label: string; home: number; away: number }> = [];
  const homeKv = market.fundamentals?.homeStats?.kvStats ?? [];
  const awayKv = market.fundamentals?.awayStats?.kvStats ?? [];
  const num = (s: unknown): number => parseFloat(String(s ?? "").replace(/[^\d.\-]/g, ""));
  const findKv = (kv: Array<{ label: string; value: string }>, re: RegExp): number => {
    const m = kv.find(x => re.test(x.label));
    return m ? num(m.value) : NaN;
  };
  const push = (label: string, home: number, away: number) => {
    if (Number.isFinite(home) && Number.isFinite(away)) out.push({ label, home, away });
  };
  push("实力评分", findKv(homeKv, /实力|评分|strength/i), findKv(awayKv, /实力|评分|strength/i));
  push("近期场均", findKv(homeKv, /近期|场均|近况/), findKv(awayKv, /近期|场均|近况/));
  const xg = market.upset?.complexityMetrics?.find(m => /预期进球|期望进球/.test(m.label));
  if (xg) {
    const nums = (String(xg.value).match(/(\d+(?:\.\d+)?)/g) ?? []).map(Number);
    if (nums.length >= 2) push("预期进球", nums[0]!, nums[1]!);
  }
  return out;
}

/**
 * Build the Act-2 风向标 from the 胜负平 (1x2) market: the three-bar 概率对比
 * (隐含 / 公允 / 模型) plus 赛前概率漂移. All series are derived from the single
 * reliable source — the per-outcome open→last 票面赔率 in `oddsMovement` — so the
 * chart matches the report's 「赔率→概率深度分解」 胜负平 tab regardless of which tab
 * the SPA rendered:
 *   隐含 (含抽水) = 1 / last;  公允 (去抽水) = (1/last) / Σ(1/last);  模型 = market1x2.
 *   漂移 = 去抽水 open→last delta (equals the report's 概率漂移 pp).
 * Probability-only: raw odds never leave this function.
 */
interface SignalRow1x2 { role: string; model: number | null; implied: number | null; fair: number | null; }
interface SignalDrift1x2 { role: string; open: number; last: number; delta: number; absDelta: number; dir: "up" | "down" | "flat"; }
export interface Signal1x2 { rows: SignalRow1x2[]; drift: SignalDrift1x2[]; hasImplied: boolean; hasFair: boolean; hasModel: boolean; }
export function buildSignal1x2(market: MarketData | null): Signal1x2 | null {
  const all = market?.market1x2?.outcomes ?? [];
  if (!all.length) return null;
  const isHandicap = (role: unknown) => String(role ?? "").startsWith("让");
  const r1 = (x: number) => Math.round(x * 10) / 10;
  const fin = (v: unknown): v is number => typeof v === "number" && isFinite(v);
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, b) => a + (b ?? 0), 0);

  // 赔率→概率深度分解 (.mr-od-table) rows — the report's own 隐含/公允/模型 columns,
  // keyed by role. The lookup is role-keyed, so when the SPA rendered a non-胜负平 tab
  // (总球数/比分) the 主胜/平局/客胜 lookups simply miss and we fall back to the
  // odds-movement derivation below.
  const odByRole = new Map((market?.marketSignal?.rows ?? []).map(r => [String(r.role), r] as const));
  const moveByRole = new Map((market?.oddsMovement?.points ?? []).map(p => [String(p.role), p] as const));

  type Outcome = (typeof all)[number];
  function buildGroup(outs: Outcome[]): { rows: SignalRow1x2[]; drift: SignalDrift1x2[] } {
    const lastInv = outs.map(o => { const p = moveByRole.get(o.role); return p && p.last > 0 ? 1 / p.last : null; });
    const openInv = outs.map(o => { const p = moveByRole.get(o.role); return p && p.open > 0 ? 1 / p.open : null; });
    const lastSum = sum(lastInv), openSum = sum(openInv);

    const rows: SignalRow1x2[] = outs.map((o, i) => {
      const od = odByRole.get(o.role);
      // 模型 from market1x2 pct (kept identical to the Act-3 胜负平 pie); 隐含/公允 prefer
      // the report's 赔率→概率深度分解 columns, else derive from open→last 票面赔率.
      const model = fin(o.pct) ? o.pct : (od && fin(od.model) ? od.model : null);
      const implied = od && fin(od.implied) ? r1(od.implied)
        : (lastInv[i] != null ? r1(lastInv[i]! * 100) : null);
      const fair = od && fin(od.fair) ? r1(od.fair)
        : (lastInv[i] != null && lastSum > 0 ? r1((lastInv[i]! / lastSum) * 100) : null);
      return { role: o.role, model, implied, fair };
    });

    const drift: SignalDrift1x2[] = outs.map((o, i) => {
      if (openInv[i] == null || lastInv[i] == null || openSum <= 0 || lastSum <= 0) return null;
      const open = r1((openInv[i]! / openSum) * 100);
      const last = r1((lastInv[i]! / lastSum) * 100);
      const delta = r1(last - open);
      return { role: o.role, open, last, delta, absDelta: Math.abs(delta), dir: delta > 0.05 ? "up" : delta < -0.05 ? "down" : "flat" };
    }).filter((d): d is SignalDrift1x2 => d !== null);

    return { rows, drift };
  }

  const usable = (rows: SignalRow1x2[]) =>
    rows.some(r => [r.model, r.implied, r.fair].some(v => fin(v) && (v as number) > 0));

  const sv = all.filter(o => !isHandicap(o.role)); // 胜负平 主胜/平局/客胜
  const hv = all.filter(o => isHandicap(o.role));  // 让球 让胜/让平/让负

  // Act-2 风向标 shows 胜负平 by default — never the handicap bars. Only when 胜负平 has
  // NO usable 赔率/概率 data at all do we fall back to the 让球 outcomes (per spec): they
  // are then the only market signal available for this match.
  let group = sv.length ? buildGroup(sv) : { rows: [] as SignalRow1x2[], drift: [] as SignalDrift1x2[] };
  if (!usable(group.rows) && hv.length) group = buildGroup(hv);
  if (!group.rows.length) return null;

  const { rows, drift } = group;
  const has = (k: keyof SignalRow1x2) => rows.some(r => fin(r[k]) && (r[k] as number) > 0);
  const hasMove = drift.some(d => d.absDelta >= 0.1);
  return { rows, drift: hasMove ? drift : [], hasImplied: has("implied"), hasFair: has("fair"), hasModel: has("model") };
}

/**
 * Act-3 赛果分布 is 胜负平-only — drop the 让球 (让胜/让平/让负) outcomes that share the
 * same market1x2 list so the proportion pie shows only 主胜/平局/客胜 (sums to 100%).
 */
export function result1x2(market: MarketData | null): NonNullable<MarketData["market1x2"]> | null {
  const all = market?.market1x2?.outcomes ?? [];
  if (!all.length) return null;
  const outcomes = all.filter(o => !String(o.role ?? "").startsWith("让"));
  return outcomes.length ? { outcomes } : null;
}

function registerHelpers(): void {
  Handlebars.registerHelper("pctFrac", (n: any) => `${(Number(n) * 100).toFixed(1)}%`);
  Handlebars.registerHelper("pct0", (n: any) => `${Math.round(Number(n) * 100)}%`);
  Handlebars.registerHelper("fixed", (n: any, p: any) => Number(n).toFixed(Number(p)));
  Handlebars.registerHelper("eq", (a: any, b: any) => a === b);
  Handlebars.registerHelper("ne", (a: any, b: any) => a !== b);
  Handlebars.registerHelper("gt", (a: any, b: any) => Number(a) > Number(b));
  Handlebars.registerHelper("lte", (a: any, b: any) => Number(a) <= Number(b));
  Handlebars.registerHelper("trim", (s: any, n: any) => {
    const str = String(s ?? "");
    return str.length > Number(n) ? str.slice(0, Number(n)) + "…" : str;
  });
  Handlebars.registerHelper("speakerBadge", (s: string) => SPEAKER_DISPLAY[s as keyof typeof SPEAKER_DISPLAY] ?? s);
  Handlebars.registerHelper("multiply", (a: any, b: any) => Number(a) * Number(b));
  Handlebars.registerHelper("add", (a: any, b: any) => Number(a) + Number(b));
  Handlebars.registerHelper("dirSymbol", (d: any) => d === "up" ? "▲" : d === "down" ? "▼" : "—");
  Handlebars.registerHelper("toneClass", (t: string) => {
    if (t === "good") return "text-emerald-400";
    if (t === "bad")  return "text-rose-400";
    if (t === "warn") return "text-amber-400";
    if (t === "hl")   return "text-violet-400";
    return "text-slate-100";
  });
  Handlebars.registerHelper("scenePartial", (kind: string) => {
    if (!VALID_KINDS.includes(kind as VisualKind)) return "scene-paragraph-flow";
    return `scene-${kind}`;
  });
  Handlebars.registerHelper("json", (v: any) => new Handlebars.SafeString(JSON.stringify(v ?? null)));
  Handlebars.registerHelper("times", function (n: any, opts: any) {
    let out = "";
    for (let i = 0; i < Number(n); i++) out += opts.fn({ index: i });
    return out;
  });

  // Replace English / variable-name / abbreviation tokens that bled in from
  // the source data tables with plain-Chinese phrasing. Applied to every
  // risk-card bullet so the slide reads cleanly for mobile viewers and
  // matches the spoken-Chinese tone of the rest of the video.
  const scrubJargon = (s: string): string => {
    let out = sanitizeRestrictedComplianceText(s);
    // Bracketed/equation forms first — "X = 12.68%" or "X (净 …)" etc.
    out = out.replace(/\bELO\b/gi, "实力分");
    out = out.replace(/\beffective[_\s-]?gap\b/gi, "有效差距");
    out = out.replace(/\bprob[_\s-]?edge\b/gi, "公平概率优势");
    out = out.replace(/\btotal[_\s-]?goals\b/gi, "总进球");
    out = out.replace(/\bcorrect[_\s-]?score\b/gi, "比分");
    out = out.replace(/\bht[_\s-]?ft\b/gi, "半全场");
    out = out.replace(/\bmax[_\s-]?upset\b/gi, "极端爆冷场景");
    out = out.replace(/\bform[_\s-]?score\b/gi, "状态分");
    out = out.replace(/\bupset[_\s-]?prob\b/gi, "爆冷概率");
    out = out.replace(/\b1x2\b/gi, "胜负平");
    out = out.replace(/\b1X2\b/g, "胜负平");
    out = out.replace(/\bbootstrap\b/gi, "重采样检验");
    out = out.replace(/\bpoisson\b/gi, "泊松模型");
    out = out.replace(/\bnull[-\s]?test\b/gi, "零假设检验");
    out = out.replace(/\bmargin\b/gi, "安全边际");
    out = out.replace(/\bvig\b/gi, "安全边际");
    out = out.replace(/\bjuice\b/gi, "安全边际");
    out = out.replace(/\bxG\b/g, "预期进球");
    out = out.replace(/\bxGA\b/g, "预期失球");
    out = out.replace(/\bMC\b/g, "蒙特卡洛");
    out = out.replace(/\bVAR\b/g, "录像回放");
    // Greek-letter / equation noise → drop or paraphrase
    out = out.replace(/λ[_\s-]?[hH]/g, "主队进球率");
    out = out.replace(/λ[_\s-]?[aA]/g, "客队进球率");
    out = out.replace(/[\u03b4]\s*=\s*/g, "扰动量 ");
    out = out.replace(/\bz\s*=\s*/gi, "z 值 ");
    out = out.replace(/\bp\s*=\s*/g, "p 值 ");
    out = out.replace(/\bn[_\s-]?prior\b/gi, "样本量");
    // Standalone English status tokens
    out = out.replace(/\bhigh\b/gi, "偏高");
    out = out.replace(/\bmid\b/gi, "中等");
    out = out.replace(/\blow\b/gi, "偏低");
    // Tidy whitespace and dangling punctuation introduced by replacement
    out = sanitizeRestrictedComplianceText(out)
      .replace(/\s+/g, " ")
      .replace(/[，,]\s*$/, "")
      .trim();
    return out;
  };

  // Pre-game reflection card builder — collects items from data.lists/callouts/paragraphs
  // and reduces them into up to 6 card objects {icon, title, bullets[], accent}.
  // Each input line is split on the first colon: left becomes the headline,
  // and the right side is further split on , ; → into up to 5 short bullets so
  // the user can actually read every factoid (no ellipsis truncation).
  // All cards share the same dark base background; only an accent stripe
  // varies by category, keeping the row visually unified.
  // Output count is always symmetric (2, 4, or 6) so the 2-column grid lays
  // out cleanly on mobile vertical (9:16) viewports.
  Handlebars.registerHelper("riskItems", function (data: any) {
    if (!data) return [];

    // Defense-in-depth: paragraphs / bullets with money / amount / odds
    // mechanics must never become a reflection card, even if the planner
    // let one slip through.
    const MONEY_TOKEN_RE = /[¥$]|资金|敞口|全押|本金|单注|起投|下注金额|净收益|凯利|kelly|赔率|套利/i;

    /**
     * Decorate a {title, bullets[]} pair with a deterministic icon + accent
     * picked from the same keyword categories the extraction path uses. We
     * round the result down to the nearest even count (2 / 4 / 6) so the
     * 2-column grid lays out symmetrically on mobile vertical viewports.
     */
    const decorate = (raw: Array<{ title?: string; bullets?: string[] }>) => {
      const out: Array<{ icon: string; title: string; bullets: string[]; accent: string }> = [];
      for (const c of raw) {
        if (!c) continue;
        const titleSrc = String(c.title ?? "").replace(/\s+/g, " ").trim();
        if (!titleSrc) continue;
        const title = titleSrc.length > 14 ? titleSrc.slice(0, 12) + "…" : titleSrc;
        const bulletsSrc = Array.isArray(c.bullets) ? c.bullets : [];
        const bullets: string[] = [];
        for (const b of bulletsSrc) {
          if (typeof b !== "string") continue;
          if (MONEY_TOKEN_RE.test(b)) continue;
          const clean = scrubJargon(b.replace(/\s+/g, " ").trim());
          if (!clean) continue;
          bullets.push(clean.length > 60 ? clean.slice(0, 58) + "…" : clean);
          if (bullets.length >= 3) break;
        }
        if (bullets.length === 0) continue;
        const t = title + (bullets[0] ?? "");
        let icon = "📌";
        let accent = "var(--accent)";
        if (/安全边际|分摊|返还/.test(t))              { icon = "💸"; accent = "var(--warn)"; }
        else if (/公众|热度|资金|大众/.test(t))         { icon = "🔥"; accent = "var(--alert)"; }
        else if (/风险|压力|边界|留意/.test(t))         { icon = "⚖️"; accent = "var(--warn)"; }
        else if (/历史|近10年|频率|样本|末轮/.test(t))  { icon = "📈"; accent = "var(--positive)"; }
        else if (/实力|差距|主场|气势|冲击/i.test(t))   { icon = "🏟️"; accent = "var(--accent)"; }
        else if (/方差|杯赛|决赛门槛|聚类|爆冷/.test(t)){ icon = "🎲"; accent = "var(--warn)"; }
        else if (/平局|加时|点球/.test(t))             { icon = "⏱️"; accent = "var(--hl)"; }
        else if (/反击|高压|战术|节奏/.test(t))         { icon = "⚔️"; accent = "var(--accent)"; }
        else if (/动机|心理|激励|保级/.test(t))         { icon = "🎯"; accent = "var(--accent)"; }
        out.push({ icon, title, bullets, accent });
        if (out.length >= 6) break;
      }
      if (out.length % 2 === 1 && out.length > 1) out.pop();
      return out;
    };

    // PREFERRED PATH: WRITE phase already summarised reflection cards via LLM
    // (data.reflectionCards). Use those directly so the visual reads as a
    // curated short narrative rather than a regex slice of raw blocks.
    if (Array.isArray(data.reflectionCards) && data.reflectionCards.length > 0) {
      const decorated = decorate(data.reflectionCards as Array<{ title?: string; bullets?: string[] }>);
      if (decorated.length >= 2) return decorated;
      // fall through to extraction if the LLM output was unusable
    }

    // FALLBACK PATH: deterministic block extraction. Used when no LLM
    // provider is configured, or when the LLM output failed validation.
    const raw: string[] = [];
    for (const lst of (data.lists ?? []) as Array<{ items: Array<{ text: string }> }>) {
      for (const it of lst.items ?? []) raw.push(it.text);
    }
    for (const co of (data.callouts ?? []) as Array<{ tone: string; text: string }>) {
      if (co.tone !== "compliance") raw.push(co.text);
    }
    for (const p of (data.paragraphs ?? []) as Array<{ text: string }>) {
      raw.push(p.text);
    }
    const cards: Array<{ icon: string; title: string; bullets: string[]; accent: string }> = [];
    const seen = new Set<string>();
    for (const line of raw) {
      if (MONEY_TOKEN_RE.test(String(line))) continue;
      const clean = scrubJargon(String(line).replace(/[*＊]+/g, "").replace(/\s+/g, " ").trim());
      if (!clean || clean.length < 4) continue;
      const colonIdx = clean.search(/[:：]/);
      let title = colonIdx > 0 && colonIdx <= 14 ? clean.slice(0, colonIdx).trim() : "";
      let bodyRaw = colonIdx > 0 && colonIdx <= 14 ? clean.slice(colonIdx + 1).trim() : clean;
      if (!title) {
        const split = bodyRaw.split(/[，,。]/, 1)[0] ?? bodyRaw;
        title = split.length > 14 ? split.slice(0, 12) + "…" : split;
        if (split.length < bodyRaw.length) bodyRaw = bodyRaw.slice(split.length).replace(/^[，,。\s]+/, "");
      }
      if (title.length > 14) title = title.slice(0, 12) + "…";
      // Split body into up to 4 readable bullets. Prefer semicolons/arrows
      // as primary delimiters (logical clauses); only fall back to commas
      // when no stronger marker exists. Cap at 4 to keep card height
      // predictable now that we may render up to 6 cards in three rows.
      const partsStrong = bodyRaw.split(/\s*(?:[;；]|→|->)\s*/).map(s => s.trim()).filter(Boolean);
      let parts: string[];
      if (partsStrong.length >= 2) parts = partsStrong;
      else parts = bodyRaw.split(/\s*[,，]\s*/).map(s => s.trim()).filter(Boolean);
      const bullets = parts.slice(0, 4)
        .map(s => scrubJargon(s))
        .filter(Boolean)
        .map(s => s.length > 60 ? s.slice(0, 58) + "…" : s);
      if (bullets.length === 0) continue;
      const key = title + "|" + bullets[0]!.slice(0, 20);
      if (seen.has(key)) continue;
      seen.add(key);
      const t = (title + bodyRaw);
      let icon = "📌";
      let accent = "var(--accent)";
      if (/安全边际|分摊|返还/.test(t))              { icon = "💸"; accent = "var(--warn)"; }
      else if (/公众|热度|资金|大众/.test(t))         { icon = "🔥"; accent = "var(--alert)"; }
      else if (/风险|压力/.test(t))                  { icon = "⚖️"; accent = "var(--warn)"; }
      else if (/历史|近10年|频率|样本/.test(t))      { icon = "📈"; accent = "var(--positive)"; }
      else if (/实力分|实力|差距|主场加成/i.test(t)) { icon = "🏟️"; accent = "var(--accent)"; }
      else if (/方差|杯赛|决赛门槛|聚类/.test(t))    { icon = "🎲"; accent = "var(--warn)"; }
      else if (/平局|加时|点球/.test(t))             { icon = "⏱️"; accent = "var(--hl)"; }
      else if (/反击|高压|战术/.test(t))             { icon = "⚔️"; accent = "var(--accent)"; }
      cards.push({ icon, title, bullets, accent });
      if (cards.length >= 6) break;
    }
    // Round down to nearest even count so the 2-column grid is symmetric
    // on mobile. Drops 1 card if we ended up with 1/3/5; preserves 2/4/6.
    if (cards.length % 2 === 1 && cards.length > 1) cards.pop();
    return cards;
  });
}

async function registerScenePartials(templatesDir: string): Promise<void> {
  const dir = path.join(templatesDir, "scenes");
  const files = await fs.readdir(dir);
  for (const f of files) {
    if (!f.endsWith(".hbs")) continue;
    const name = `scene-${f.replace(/\.hbs$/, "")}`;
    const src = await fs.readFile(path.join(dir, f), "utf8");
    Handlebars.registerPartial(name, src);
  }
}

function safeId(s: string): string {
  return path.basename(s, path.extname(s)).replace(/[^A-Za-z0-9_-]/g, "_");
}

function round(x: number, p: number): number {
  const f = Math.pow(10, p);
  return Math.round(x * f) / f;
}
