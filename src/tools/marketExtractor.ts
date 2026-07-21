/**
 * marketExtractor — pulls structured market data out of a source HTML report
 * (e.g. swa_html/reports/{date}/{match}.html) so the COMPOSE phase can feed
 * rich, chart-ready props into ECharts-based scene partials.
 *
 * The HTML schema is fairly stable: dedicated CSS classes like .market-1x2,
 * .market-tg, .market-cs, .market-htft, .upset-hero, .profile-card and
 * .payoff-card identify each visual region. We harvest them with cheerio.
 *
 * Returns a `MarketData` object that mirrors the four visual modules in the
 * source report:
 *   - hero          (match meta + headline)
 *   - fundamentals  (per-team summary stats and per-side splits)
 *   - markets       (1x2, total-goals, correct-score, ht/ft)
 *   - upset         (gauge + Top-N upset scores + complexity note)
 *   - strategy      (profiles + payoff scenario cards)
 *
 * All percentages are returned as numeric 0..100 plus a string variant so the
 * partial can pick whichever is convenient.
 */

import * as cheerio from "cheerio";
import * as fs from "node:fs/promises";

export interface MarketData {
  hero: {
    title: string;
    headline: string;
    matchZh: string;
    league: string;
    kickoff: string;
    season: string;
    homeName: string;
    awayName: string;
  };
  fundamentals: {
    homeName: string;
    awayName: string;
    homeStats: TeamStats;
    awayStats: TeamStats;
    homeBlurb: string;
    awayBlurb: string;
    highlights: HighlightCard[];
  };
  market1x2: { outcomes: Outcome[] } | null;
  totalGoals: { bars: Array<{ goals: string; pct: number }>; topGoals: Array<{ goals: string; pct: number }>; peakLabel: string; expected: string; ge3pct: string } | null;
  correctScore: { topScores: Array<{ score: string; pct: number; lead?: boolean }>; matrix: ScoreMatrix } | null;
  htft: { rows: Array<{ ht: string; cells: number[]; rowSum: number }>; colSums: number[]; peak: { row: number; col: number } } | null;
  /**
   * v2 「风向标」 — implied / fair / model probability comparison plus the
   * pre-match implied-probability drift. Probability-only by design (no odds,
   * no EV, no betting language) so it stays inside the medium compliance policy.
   */
  marketSignal: MarketSignal | null;
  /**
   * v2 「赔率→概率」运动 — the per-outcome 胜负平 open→last odds parsed from the
   * `.mr-om-odds-line` movement block. Consumers derive probability-only views
   * (隐含=1/last, 公允=de-vig, 漂移=de-vig open→last delta); raw odds never reach
   * a consumer-facing string.
   */
  oddsMovement: OddsMovement | null;
  upset: {
    probPct: string;
    band: string;
    favTeam: string;
    favPct: string;
    complexity: string;
    scores: Array<{ score: string; pct: number; interp: string; top: boolean }>;
    factors: UpsetFactor[];
    complexityMetrics: ComplexityMetric[];
    drivers: UpsetDriver[];
  } | null;
  strategy: { profiles: StrategyProfile[]; payoff: PayoffScenario | null } | null;
}

export interface MarketSignalRow {
  role: string;        // 主胜 / 平局 / 客胜
  implied: number;     // 市场隐含概率 %
  fair: number;        // 去边际公允概率 %
  model: number;       // 模型概率 %
  mismatchPp: number;  // 模型 − 公允（百分点，可正可负）
}

export interface MarketDriftPoint {
  role: string;        // 主胜 / 平局 / 客胜
  open: number;        // 开盘隐含概率 %（已归一）
  last: number;        // 最新隐含概率 %（已归一）
}

export interface MarketSignal {
  rows: MarketSignalRow[];
  drift: MarketDriftPoint[] | null;
}

/** Per-outcome 胜负平 open→last 票面赔率 from the `.mr-om-odds-line` block. */
export interface OddsMovementPoint { role: string; open: number; last: number; }
export interface OddsMovement { points: OddsMovementPoint[]; }

export interface ComplexityMetric {
  label: string;       // 爆冷压力 / 复杂信号 / 赛果分散度 / 最高单比分 / 预期进球
  value: string;       // 原始文本，如 "26.5%" / "1.03" / "1.71 / 1.11"
  pct: number | null;  // 当 value 是百分比时的数值，否则 null
  detail: string;
}

export interface UpsetDriver {
  label: string;       // 市场压缩 / 临界放缓 / 临界指数（已去敏感词）
  pct: number;
}

export interface HighlightCard {
  icon: string;       // emoji
  title: string;      // 8-14 chars
  bullets: string[];  // 1-2 short bullets, each ≤ 38 chars
  tone?: "info" | "warn" | "good" | "bad";
}

export interface UpsetFactor {
  label: string;      // factor name, ≤ 16 chars
  weight: string;     // "+6%"
  interp: string;     // short interpretation, ≤ 40 chars
}

export interface TeamStats {
  label: "主队" | "客队";
  recent: string;     // "5胜 4平 3负" / "9胜 0平 3负"
  ppg: string;        // "1.58"
  goals: string;      // "1.67"
  conceded: string;   // "1.42"
  splitLabel: "主场" | "客场";
  splitGoals: string;
  splitConceded: string;
  attackCoeff?: string;
  defenseCoeff?: string;
  // Generic key/value stats parsed from the report's .team .stats .stat blocks
  // (e.g. "实力 1665", "近期场均 2.10"). Used as fallback when the traditional
  // fields above are not present.
  kvStats?: Array<{ label: string; value: string }>;
}

export interface Outcome {
  role: string;            // 主胜 / 平局 / 客胜
  team: string;
  pct: number;             // 30.3
  lead: boolean;
}

export type ScoreMatrix = Array<Array<{ pct: number; top: boolean; draw: boolean }>>;

export interface StrategyProfile {
  name: string;            // 稳健型 / 激进型 / 猎手型 / 爆冷型
  icon: string;            // 🛡️ / 🔥 / 🎯 / 🎲
  risk: string;            // 低风险 / 高敞口 / ...
  tagline: string;
  picks: Array<{ market: string; option: string; pp: string; odds: string; stake: string }>;
  totalStake: string;
  rationale: string;
}

export interface PayoffScenario {
  score: string;           // "1-2"
  probLabel: string;       // "模型 P = 9.2%"
  outcome1x2: string;      // "客胜（阿斯顿维拉 (Aston Villa)）"
  totalGoals: string;      // "3球"
  cards: Array<{
    name: string;          // 稳健型/激进型/...
    hits: string;          // "1/1 命中" / "3/3 命中"
    profit: string;        // "+¥53.00" / "−¥100.00"
    profitTone: "gain" | "loss";
    rows: Array<{ hit: boolean; pick: string; stake: string; delta: string; deltaTone: "gain" | "loss" }>;
  }>;
}

export async function extractMarketData(htmlPath: string): Promise<MarketData> {
  const html = await fs.readFile(htmlPath, "utf8");
  return extractMarketDataFromHtml(html);
}

export function extractMarketDataFromHtml(html: string): MarketData {
  const $ = cheerio.load(html);

  // ── Hero ──────────────────────────────────────────────────────────────
  // Support both legacy .hero and newer .mr-hero (Next.js SPA)
  const heroH1 = $(".hero h1, .mr-hero-title").first();
  const heroTitle = textOf(heroH1).trim();
  const heroHeadline = $(".hero .headline, .mr-hero-sub").first().text().trim();
  const dl = $("section.m-fundamentals dl.meta div, .mr-meta > div");
  const league   = textOf(dl.filter((_, e) => /联赛/.test($(e).find("dt").text())).find("dd"));
  const kickoff  = textOf(dl.filter((_, e) => /时间/.test($(e).find("dt").text())).find("dd"));
  const season   = textOf(dl.filter((_, e) => /赛季/.test($(e).find("dt").text())).find("dd"));
  // SPA: .mr-team-name inside .mr-team-home / .mr-team-away
  const homeName = textOf($(".team.home .name, .mr-team-home .mr-team-name").first());
  const awayName = textOf($(".team.away .name, .mr-team-away .mr-team-name").first());

  // ── Fundamentals ──────────────────────────────────────────────────────
  // Support both legacy m-fundamentals findings and new mr-findings blocks
  const findings = $("section.m-fundamentals .finding, .mr-findings .mr-finding").toArray();
  const getBlurb = (el: any) =>
    $(el).find(".fbody, .mr-finding-body").first().text().replace(/\s+/g, " ").trim();
  const homeBlurb = findings[0] ? getBlurb(findings[0]) : "";
  const awayBlurb = findings[1] ? getBlurb(findings[1]) : "";

  const homeStats = parseTeamStats(homeBlurb, "主队", "主场");
  const awayStats = parseTeamStats(awayBlurb, "客队", "客场");

  // Fallback: if no `.finding` blurbs (report uses a compact `.team .stats .stat`
  // schema), pull label/value pairs straight off the markup so the visual still
  // surfaces real numbers instead of "—".
  const readKv = (sel: string): Array<{ label: string; value: string }> => {
    const out: Array<{ label: string; value: string }> = [];
    // Legacy: .stats .stat .label + .value
    // SPA: .mr-team-stats .mr-stat .mr-stat-label + .mr-stat-value
    $(`${sel} .stats .stat, ${sel} .mr-team-stats .mr-stat`).each((_, el) => {
      const label = $(el).find(".label, .mr-stat-label").first().text().trim();
      const value = $(el).find(".value, .mr-stat-value").first().text().trim();
      if (label && value) out.push({ label, value });
    });
    return out;
  };
  const homeKv = readKv("section.m-fundamentals .team.home, .mr-team-home");
  const awayKv = readKv("section.m-fundamentals .team.away, .mr-team-away");
  if (homeKv.length) homeStats.kvStats = homeKv;
  if (awayKv.length) awayStats.kvStats = awayKv;

  // Highlights — pull a curated set of finding blocks from m-fundamentals
  // and reduce each to a card-friendly shape (title + 1–2 short bullets).
  // Per-team form findings are intentionally skipped: the top stat-grid
  // already surfaces those numbers, so the highlight row should be reserved
  // for narrative angles (tactics / injuries / motivation / venue).
  const highlights = extractHighlights($, "section.m-fundamentals, section.mr-section");

  // ── Market 1x2 ────────────────────────────────────────────────────────
  // Legacy: .market-1x2 .outcome .role/.team/.pct
  // SPA: .mr-card.mr-mkt-1x2 .mr-outcome .mr-outcome-role/.mr-outcome-team/.mr-outcome-pct
  let market1x2: MarketData["market1x2"] = null;
  const $m1x2 = $(".market-1x2, .mr-card.mr-mkt-1x2").first();
  if ($m1x2.length) {
    const outcomes = $m1x2.find(".outcome, .mr-outcome").map((_, el) => ({
      role: textOf($(el).find(".role, .mr-outcome-role")),
      team: textOf($(el).find(".team, .mr-outcome-team")),
      pct: pctNum($(el).find(".pct, .mr-outcome-pct").text()),
      lead: $(el).hasClass("lead"),
    })).get();
    market1x2 = { outcomes };
  }

  // ── Total goals ───────────────────────────────────────────────────────
  // Legacy: .market-tg .col .pct
  // SPA: .mr-card.mr-mkt-tg .mr-tg-col .mr-tg-pct
  let totalGoals: MarketData["totalGoals"] = null;
  const $tg = $(".market-tg, .mr-card.mr-mkt-tg").first();
  if ($tg.length) {
    const labels = $tg.find(".labels span, .mr-tg-labels span").map((_, e) => textOf($(e))).get();
    const bars = $tg.find(".col, .mr-tg-col").map((i, el) => ({
      goals: labels[i] ?? String(i),
      pct: pctNum($(el).find(".pct, .mr-tg-pct").text()),
    })).get();
    const peakIdx = bars.reduce((maxI, b, i, arr) => (b.pct > arr[maxI]!.pct ? i : maxI), 0);
    const summary = $tg.find(".summary, .mr-tg-summary").first().text().replace(/\s+/g, " ");
    const expected = (summary.match(/期望进球[:：]?\s*([\d.]+)/) ?? [])[1] ?? "";
    const ge3pct   = (summary.match(/≥\s*3\s*球概率[:：]?\s*([\d.%]+)/) ?? [])[1] ?? "";
    // Top-3 goal counts by probability — feeds the Act-1 cover (球数 top3).
    const topGoals = bars
      .filter(b => Number.isFinite(b.pct) && b.pct > 0)
      .slice()
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 3)
      .map(b => ({ goals: b.goals, pct: b.pct }));
    totalGoals = { bars, topGoals, peakLabel: bars[peakIdx]?.goals ?? "", expected, ge3pct };
  }

  // ── Correct score (heatmap + Top-N) ───────────────────────────────────
  // Legacy: .market-cs .top-list .item
  // SPA: .mr-card.mr-mkt-cs .mr-cs-toplist .mr-cs-item
  // Fallback: some reports use mr-card-wide + heading text for the CS card
  let correctScore: MarketData["correctScore"] = null;
  let $cs = $(".market-cs, .mr-card.mr-mkt-cs").first();
  // Fallback: look for any mr-card whose h3 contains "比分" or "score"
  if (!$cs.length) {
    $cs = $(".mr-card").filter((_, el) => {
      const h3 = $(el).find("h3").first();
      if (!h3.length) return false;
      const title = h3.text().trim();
      return title.includes("比分") || title.toLowerCase().includes("score");
    }).first();
  }
  if ($cs.length) {
    const topScores = $cs.find(".top-list .item, .mr-cs-toplist .mr-cs-item").map((_, el) => ({
      score: textOf($(el).find(".score, .mr-cs-score")),
      pct: pctNum($(el).find(".pct, .mr-cs-itempct").text()),
      lead: $(el).hasClass("lead"),
    })).get();
    // Extract matrix from table
    const matrix: ScoreMatrix = [];
    const $csTable = $cs.find("table.cs-matrix, .mr-cs-matrix").first();
    $csTable.find("tbody tr").each((_, tr) => {
      const row: ScoreMatrix[number] = [];
      $(tr).find("td").each((__, td) => {
        const t = $(td).text().trim();
        row.push({
          pct: t.endsWith("%") ? pctNum(t) : 0,
          top: $(td).hasClass("top"),
          draw: $(td).hasClass("draw"),
        });
      });
      matrix.push(row);
    });
    correctScore = { topScores, matrix };
  }

  // ── HT/FT ─────────────────────────────────────────────────────────────
  // Legacy: .market-htft table tbody
  // SPA: .mr-card.mr-mkt-htft .mr-htft table
  let htft: MarketData["htft"] = null;
  const $htft = $(".market-htft, .mr-card.mr-mkt-htft").first();
  if ($htft.length) {
    const rows: Array<{ ht: string; cells: number[]; rowSum: number }> = [];
    $htft.find("table tbody tr, .mr-htft tbody tr").each((_, tr) => {
      const ht = textOf($(tr).find("th").first());
      if (!ht || ht === "Σ") return; // skip summary rows
      const tds = $(tr).find("td");
      const cells = tds.slice(0, 3).map((__, td) => pctNum($(td).text())).get();
      if (cells.length < 3) return;
      const rowSum = pctNum($(tds[3]!).text());
      rows.push({ ht, cells, rowSum });
    });
    // Col sums from the summary row
    const colSums = $htft.find("tfoot td.marg, .mr-htft-sum-row th.mr-htft-sum-cell").slice(0, 3)
      .map((_, td) => pctNum($(td).text())).get();
    // Find peak in body
    let peak = { row: 0, col: 0, v: -1 };
    rows.forEach((r, i) => r.cells.forEach((v, j) => { if (v > peak.v) peak = { row: i, col: j, v }; }));
    htft = { rows, colSums, peak: { row: peak.row, col: peak.col } };
  }

  // ── Market signal (v2 「风向标」) ──────────────────────────────────
  // Probability-only view of the odds→probability decomposition table
  // (.mr-od-table) plus the pre-match implied-probability drift parsed from
  // the 盘口解读 finding. We deliberately drop 票面赔率 / 含抽水EV columns and
  // never surface raw odds in any consumer-facing string.
  const marketSignal = extractMarketSignal($);

  // ── Upset ────────────────────────────────────────────────────────────
  // Legacy: .upset-hero, .upset-score-card
  // SPA: .mr-upset-hero, .mr-upset-score
  let upset: MarketData["upset"] = null;
  const $upsetHero = $(".upset-hero, .mr-upset-hero").first();
  if ($upsetHero.length) {
    // The Top-N upset scores and findings live in *sibling* containers within
    // the same upset section (e.g. `.mr-upset-scores-wrap > .mr-upset-scores >
    // .mr-upset-score`), NOT inside the hero. Scoping the score search to the
    // hero returned an empty list; scope it to the enclosing section instead.
    const $section = $upsetHero.closest("section.m-upset, .mr-section");
    const $scope = $section.length ? $section : $upsetHero;

    const probPct = textOf($upsetHero.find(".gauge .value, .mr-upset-value"));
    const favLine = textOf($upsetHero.find(".fav, .mr-upset-narrative p"));

    // SPA narrative form: "模型把 <队名> 视为 <定性>（最被看好概率 <pct>）。…"
    // Legacy form: "<队名> · <pct>" separated by a middle dot.
    let band    = textOf($upsetHero.find(".chip.band, .mr-upset-band"));
    let favTeam = "";
    let favPct  = "";
    const favMatch = (favLine ?? "").match(/模型把\s*(.+?)\s*视为\s*([^（(]+?)\s*[（(][^%]*?(\d+(?:\.\d+)?)\s*%/);
    if (favMatch) {
      favTeam = favMatch[1]!.trim();
      if (!band) band = favMatch[2]!.trim();
      favPct = `${favMatch[3]}%`;
    } else {
      const favParts = (favLine ?? "").split("·").map(s => s.trim());
      favTeam = favParts[0] ?? "";
      favPct  = (favParts[1] ?? "").replace(/^热门概率\s*/, "");
    }

    const complexityNode = $("section.m-upset .findings .finding, .mr-findings .mr-finding").first();
    const complexity = getBlurb(complexityNode); // reuse helper
    const scores = $scope.find(".upset-score-card, .mr-upset-score").map((_, el) => ({
      score: textOf($(el).find(".score, .mr-upset-score-val")),
      pct: pctNum($(el).find(".pct, .mr-upset-score-pct").text()),
      interp: textOf($(el).find(".interp, .mr-upset-interp")),
      top: $(el).hasClass("top"),
    })).get();
    const factors = extractUpsetFactors($, "section.m-upset, .mr-section");
    const complexityMetrics = extractComplexityMetrics($);
    const drivers = extractUpsetDrivers($);
    upset = { probPct, band, favTeam, favPct, complexity, scores, factors, complexityMetrics, drivers };
  }

  // ── Strategy ─────────────────────────────────────────────────────────
  // Legacy: .profile-card .name .head .icon .risk .pick .mkt .lhs
  // SPA: .mr-profile .mr-profile-name .mr-profile-icon .mr-profile-risk .mr-pick .mr-pick-mkt .mr-pick-lhs
  let strategy: MarketData["strategy"] = null;
  // Extract from first .mr-profiles-grid only (strategy section), skip payoff
  const $firstGrid = $(".mr-profiles-grid, .profile-card-wrapper").first();
  const $profiles = $firstGrid.find(".mr-profile").add(".profile-card");
  if ($profiles.length) {
    const profiles: StrategyProfile[] = $profiles.map((_, el) => {
      const $c = $(el);
      const name = textOf($c.find(".name, .mr-profile-name"));
      const icon = textOf($c.find(".head .icon, .mr-profile-icon"));
      const risk = textOf($c.find(".risk, .mr-profile-risk"));
      const tagline = $c.find(".tagline").first().text().replace(/\s+/g, " ").trim();
      const picks = $c.find(".pick, .mr-pick").map((__, p) => {
        const $p = $(p);
        const mkt = textOf($p.find(".mkt, .mr-pick-mkt"));
        const lhsAll = $p.find(".lhs, .mr-pick-lhs").text();
        // Drop the market label prefix, then strip any "（...）" team
        // qualifier so the slide reads `主胜朗斯` not `主胜（朗斯）`.
        const optionRaw = lhsAll.replace(mkt, "").trim();
        const option = optionRaw.replace(/[（(]([^）)]+)[）)]/g, "$1").replace(/\s+/g, "");
        return {
          market: mkt,
          option,
          pp:    textOf($p.find(".pp").first()),
          odds:  textOf($p.find(".pp-odds, .mr-pick-odds")),
          stake: textOf($p.find(".pp-stake, .mr-pick-stake")),
        };
      }).get();
      const totalStake = textOf($c.find(".stake b, .mr-profile-stake b"));
      const rationale = $c.find(".rationale").first().text().replace(/\s+/g, " ").trim();
      return { name, icon, risk, tagline, picks, totalStake, rationale };
    }).get();

    let payoff: PayoffScenario | null = null;
    // Legacy: .payoff-hero .score/.prob .scenario-meta .row .payoff-card
    // SPA: .mr-settle-hero .mr-settle-score/.mr-settle-ht .mr-settle-label .mr-profile (payoff scenario)
    const $payoffHero = $(".payoff-hero, .mr-settle-hero").first();
    if ($payoffHero.length) {
      const score = textOf($payoffHero.find(".score, .mr-settle-score"));
      const probLabel = textOf($payoffHero.find(".prob, .mr-settle-ht"));
      const meta = $(".payoff-hero .scenario-meta .row, .mr-settle-hero > div:first-child > div, .mr-settle-hero > div:first-child").map((_, r) => ({
        k: textOf($(r).find(".k, .mr-settle-label")),
        v: textOf($(r).find(".v, .mr-settle-score")),
      })).get();
      const outcome1x2 = (meta.find(m => /胜平负/.test(m.k))?.v) ?? "";
      const totalGoalsStr = (meta.find(m => /总进球/.test(m.k))?.v) ?? "";

      const cards = $(".payoff-card, .mr-profile.p-conservative, .mr-profile.p-aggressive, .mr-profile.p-hunter, .mr-profile.p-upset").map((_, el) => {
        const $card = $(el);
        const name = textOf($card.find(".name, .mr-profile-name").clone().children().remove().end());
        const hits = textOf($card.find(".stake, .mr-profile-stake"));
        const profit = textOf($card.find(".profit, .mr-settle-pnl").clone().children().remove().end());
        const profitTone: "gain" | "loss" = $card.find(".profit, .mr-settle-pnl").hasClass("loss") ? "loss" : "gain";
        const rows = $card.find(".pick-row, .mr-pick").map((__, r) => {
          const $r = $(r);
          const hit = $r.find(".check, .mr-pick-result.hit").hasClass("hit");
          const pickLabel = textOf($r.find(".pick-label, .mr-pick-lhs"));
          const stake = textOf($r.find(".stake-val, .mr-pick-stake"));
          const delta = textOf($r.find(".delta, .gain, .loss"));
          const deltaTone: "gain" | "loss" = $r.find(".delta, .gain, .loss").hasClass("loss") ? "loss" : "gain";
          return { hit, pick: pickLabel, stake, delta, deltaTone };
        }).get();
        return { name, hits, profit, profitTone, rows };
      }).get();

      payoff = { score, probLabel, outcome1x2, totalGoals: totalGoalsStr, cards };
    }

    strategy = { profiles, payoff };
  }

  return {
    hero: {
      title: heroTitle,
      headline: heroHeadline,
      matchZh: heroTitle.replace(/\s*·.*$/, "").trim(),
      league, kickoff, season,
      homeName, awayName,
    },
    fundamentals: { homeName, awayName, homeStats, awayStats, homeBlurb, awayBlurb, highlights },
    market1x2, totalGoals, correctScore, htft, marketSignal, oddsMovement: extractOddsMovement($), upset, strategy,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────

function textOf(node: cheerio.Cheerio<any>): string {
  return (node?.text?.() ?? "").replace(/\s+/g, " ").trim();
}

function pctNum(s: string): number {
  const m = (s ?? "").match(/(-?\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]!) : 0;
}

/**
 * Heuristic parse of a fundamentals blurb such as:
 *   "弗赖堡 近 12 场 5 胜 4 平 3 负，场均得分 1.58，场均进球 1.67 / 失球 1.42。
 *    主场层面：场均进球 1.86，场均失球 1.86，相对德甲主场平均 1.63 进球的
 *    攻击系数为 1.14、防守系数 1.24。"
 */
function parseTeamStats(blurb: string, label: "主队" | "客队", splitLabel: "主场" | "客场"): TeamStats {
  const recent = matchOne(blurb, /(\d+)\s*胜\s*(\d+)\s*平\s*(\d+)\s*负/);
  const recentStr = recent ? `${recent[1]}胜 ${recent[2]}平 ${recent[3]}负` : "—";
  const ppg = matchOne(blurb, /场均得分[^\d]*(\d+(?:\.\d+)?)/)?.[1] ?? "—";
  const goals = matchOne(blurb, /场均进球[^\d]*(\d+(?:\.\d+)?)/)?.[1] ?? "—";
  const conceded = matchOne(blurb, /失球[^\d]*(\d+(?:\.\d+)?)/)?.[1] ?? "—";

  // Per-side: "主场层面：场均进球 X，场均失球 Y" or "客场样本：…"
  // Use the SECOND occurrence of 场均进球 (the one after the per-side header)
  const splitGoalsMatches = [...blurb.matchAll(/场均进球[^\d]*(\d+(?:\.\d+)?)/g)];
  const splitConcededMatches = [...blurb.matchAll(/(?:场均失球|失球)[^\d]*(\d+(?:\.\d+)?)/g)];
  const splitGoals = splitGoalsMatches[1]?.[1] ?? goals;
  const splitConceded = splitConcededMatches[1]?.[1] ?? conceded;
  const attackCoeff  = matchOne(blurb, /攻击系数[^\d]*(\d+(?:\.\d+)?)/)?.[1];
  const defenseCoeff = matchOne(blurb, /防守系数[^\d]*(\d+(?:\.\d+)?)/)?.[1];

  return {
    label,
    recent: recentStr,
    ppg, goals, conceded,
    splitLabel, splitGoals, splitConceded,
    attackCoeff, defenseCoeff,
  };
}

function matchOne(s: string, re: RegExp): RegExpMatchArray | null {
  return s.match(re);
}

/**
 * Parse the odds→probability decomposition table (.mr-od-table) into a
 * probability-only signal: 隐含 / 公允 / 模型 percentage per outcome plus the
 * model-vs-fair mismatch in percentage points. The 票面赔率 and 含抽水EV columns
 * are intentionally ignored so no raw odds / EV ever leave this module.
 */
function extractMarketSignal($: cheerio.CheerioAPI): MarketSignal | null {
  const $table = $(".mr-od-table, table.mr-od-table").first();
  const rows: MarketSignalRow[] = [];
  if ($table.length) {
    $table.find("tbody tr").each((_, tr) => {
      const role = textOf($(tr).find(".mr-od-c-sel").first());
      if (!role) return;
      const nums = $(tr).find(".mr-od-c-num").map((__, td) => $(td).text().trim()).get();
      // columns: [隐含, 公允, 模型, 错配(pp), 含抽水EV]
      if (nums.length < 3) return;
      const implied = pctNum(nums[0] ?? "");
      const fair    = pctNum(nums[1] ?? "");
      const model   = pctNum(nums[2] ?? "");
      const mismatchPp = nums[3] !== undefined ? pctNum(nums[3]) : Math.round((model - fair) * 10) / 10;
      rows.push({ role, implied, fair, model, mismatchPp });
    });
  }
  const drift = extractMarketDrift($);
  if (rows.length === 0 && !drift) return null;
  return { rows, drift };
}

/**
 * Parse the per-outcome 胜负平 open→last 票面赔率 from the odds-movement block
 * (`.mr-om-odds-line > .mr-om-odds-item`), e.g. 主胜 1.33 → 1.28 / 平局 4.26 →
 * 4.61 / 客胜 7.00 → 7.60. This is the single reliable source for the Act-2
 * 风向标 三柱 (隐含/公允/模型) and 概率漂移 — present in every report regardless of
 * which 概率深度分解 tab the SPA happened to render. Raw odds stay internal;
 * consumers only ever see derived probabilities.
 */
function extractOddsMovement($: cheerio.CheerioAPI): OddsMovement | null {
  const points: OddsMovementPoint[] = [];
  $(".mr-om-odds-line .mr-om-odds-item").each((_, el) => {
    const role = textOf($(el).find(".mr-om-odds-role").first());
    const nums = $(el).find(".num").map((__, n) => parseFloat($(n).text().trim())).get();
    if (!role || nums.length < 2) return;
    const open = nums[0]!;
    const last = nums[1]!;
    if (!isFinite(open) || !isFinite(last) || open <= 0 || last <= 0) return;
    points.push({ role, open, last });
  });
  return points.length ? { points } : null;
}

/**
 * Derive the pre-match implied-probability drift from the 盘口解读 finding,
 * e.g. "开盘法国1.37、平3.95、塞内加尔6.85；最新变为法国1.35、平4.02、塞内加尔7.15".
 * We convert each odds triple to normalised implied probabilities (1/odds,
 * re-based to 100) so the consumer only ever sees probabilities. Returns null
 * when the finding is absent or unparseable.
 */
function extractMarketDrift($: cheerio.CheerioAPI): MarketDriftPoint[] | null {
  let text = "";
  $(".mr-finding, .finding").each((_, el) => {
    const title = textOf($(el).find(".mr-finding-title, .ftitle").first());
    if (/盘口|变盘|赔率\s*\/?\s*概率变化|开盘/.test(title) || /开盘/.test($(el).text())) {
      const body = $(el).text();
      if (/开盘/.test(body) && /最新/.test(body)) text = body;
    }
  });
  if (!text) return null;
  // Split into "开盘 …" and "最新 …" segments.
  const openSeg = text.match(/开盘[^。；]*?([\d.]+[、,，][\s\S]*?)(?:；|;|最新|$)/);
  const lastSeg = text.match(/最新[^。；]*?([\d.]+[、,，][\s\S]*?)(?:。|$)/);
  const openOdds = openSeg ? parseOddsTriple(openSeg[0]) : null;
  const lastOdds = lastSeg ? parseOddsTriple(lastSeg[0]) : null;
  if (!openOdds || !lastOdds || openOdds.length < 3 || lastOdds.length < 3) return null;
  const roles = ["主胜", "平局", "客胜"];
  const open = normaliseImplied(openOdds);
  const last = normaliseImplied(lastOdds);
  return roles.map((role, i) => ({ role, open: open[i]!, last: last[i]! }));
}

function parseOddsTriple(seg: string): number[] {
  const nums = [...seg.matchAll(/(\d+\.\d{1,2})/g)].map(m => parseFloat(m[1]!));
  return nums.slice(0, 3);
}

function normaliseImplied(odds: number[]): number[] {
  const raw = odds.map(o => (o > 0 ? 1 / o : 0));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map(r => Math.round((r / sum) * 1000) / 10);
}

/** Parse the .mr-complexity-metric grid (爆冷压力 / 复杂信号 / 赛果分散度 / …). */
function extractComplexityMetrics($: cheerio.CheerioAPI): ComplexityMetric[] {
  return $(".mr-complexity-metric").map((_, el) => {
    const label = textOf($(el).find(".mr-complexity-label"));
    const value = textOf($(el).find(".mr-complexity-value"));
    const detail = textOf($(el).find(".mr-complexity-detail"));
    const pct = /%/.test(value) ? pctNum(value) : null;
    return { label, value, pct, detail };
  }).get().filter(m => m.label);
}

/** Parse the .mr-complexity-driver bars, de-sensitising 赔率 → 市场 for compliance. */
function extractUpsetDrivers($: cheerio.CheerioAPI): UpsetDriver[] {
  return $(".mr-complexity-driver").map((_, el) => {
    const rawLabel = textOf($(el).find(".mr-complexity-driver-label"));
    const label = rawLabel.replace(/赔率/g, "市场");
    const pct = pctNum(textOf($(el).find(".mr-complexity-driver-value")));
    return { label, pct };
  }).get().filter(d => d.label);
}
/**
 * Extract a curated set of narrative highlight cards from a `.findings`
 * block inside the given section. Each card is built from one `.finding`
 * node: title is taken verbatim, and the body is reduced to 1–2 short
 * bullets keyed off the `<冒号> separator pattern used by the upstream
 * generator ("联赛排名: …, …; 进攻数据: …"). Per-team form findings
 * (titles containing "近期状态") are dropped — the static stat grid above
 * already surfaces those numbers, so highlights focus on narrative angles.
 */
function extractHighlights($: cheerio.CheerioAPI, sectionSel: string): HighlightCard[] {
  const cards: HighlightCard[] = [];
  // Legacy: .findings .finding
  // SPA: .mr-findings .mr-finding
  const finders = `${sectionSel} .findings .finding, ${sectionSel} .mr-findings .mr-finding`;
  $(finders).each((_, el) => {
    const $el = $(el);
    const rawTitle = textOf($el.find(".ftitle, .mr-finding-title"));
    if (!rawTitle) return;
    if (/近期状态/.test(rawTitle)) return; // covered by per-team stat cards

    // Pick icon + tone by title keyword
    const { icon, tone, label } = classifyHighlight(rawTitle);

    // Reduce body to up to 2 short bullets. Preferred path: the source HTML
    // uses a structured <ul><li><strong>label</strong>: value</li></ul>
    // pattern inside .fbody (legacy) or .mr-finding-body (SPA).
    const bullets: string[] = [];
    const lis = $el.find(".fbody li, .mr-finding-body li").toArray();
    if (lis.length > 0) {
      for (const li of lis) {
        if (bullets.length >= 2) break;
        const $li = $(li);
        let lab = textOf($li.find("strong, b").first());
        let body = $li.text().replace(/\s+/g, " ").trim().replace(/&#x27;/g, "'");
        if (lab) {
          // Drop the "label: " prefix from body since we render label separately
          body = body.replace(new RegExp(`^${escapeRe(lab)}\\s*[:：]\\s*`), "");
        }
        if (!body) continue;
        let pretty = lab ? `${lab}: ${body}` : body;
        if (pretty.length > 52) pretty = pretty.slice(0, 50) + "…";
        bullets.push(pretty);
      }
    } else {
      // Fallback: free-text body — pick first sentence/segment up to 40 chars.
      const rawBody = $el.find(".fbody, .mr-finding-body").first().text().replace(/\s+/g, " ").trim().replace(/&#x27;/g, "'");
      if (rawBody) {
        const first = rawBody.split(/[。;；]/)[0]?.trim() ?? rawBody.slice(0, 40);
        bullets.push(first.length > 52 ? first.slice(0, 50) + "…" : first);
      }
    }
    if (bullets.length === 0) return;

    cards.push({ icon, title: label, bullets, tone });
  });

  // Cap at 4 cards to keep the slide breathable on mobile. Prioritise
  // tactics → injury → motivation → venue → others (preserves narrative
  // arc; falls back to insertion order when the curated set is short).
  const priority = ["tactic", "injury", "motivation", "venue", "h2h", "lineup", "context"];
  cards.sort((a, b) => priority.indexOf(toneKey(a)) - priority.indexOf(toneKey(b)));
  return cards.slice(0, 4);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function classifyHighlight(title: string): { icon: string; tone: HighlightCard["tone"]; label: string } {
  const t = title.replace(/\s+/g, "");
  if (/战术|对位|阵型/.test(t))      return { icon: "⚔️", tone: "info", label: "战术对位" };
  if (/伤停|停赛|裁判/.test(t))      return { icon: "🩹", tone: "warn", label: "伤停 · 裁判" };
  if (/动机|赛季|背景/.test(t))      return { icon: "🔥", tone: "good", label: "动机背景" };
  if (/环境|场地|天气/.test(t))      return { icon: "🏟️", tone: "info", label: "场地天气" };
  if (/交锋|H2H/i.test(t))           return { icon: "🆚", tone: "info", label: "近期交锋" };
  if (/首发|阵容/.test(t))           return { icon: "🧩", tone: "info", label: "首发阵容" };
  return { icon: "📌", tone: "info", label: title.length > 14 ? title.slice(0, 12) + "…" : title };
}

function toneKey(c: HighlightCard): string {
  const t = c.title;
  if (/战术|对位/.test(t)) return "tactic";
  if (/伤停|停赛|裁判/.test(t)) return "injury";
  if (/动机/.test(t)) return "motivation";
  if (/环境|场地|天气/.test(t)) return "venue";
  if (/交锋/.test(t)) return "h2h";
  if (/首发|阵容/.test(t)) return "lineup";
  return "context";
}

/**
 * Extract the upset breakdown table from the m-upset / mr-section.
 * Returns up to 5 strongest factors (by weight) so the visual card row
 * stays compact. Each card carries factor label, weight string, and a
 * short interpretation.
 */
function extractUpsetFactors($: cheerio.CheerioAPI, sectionSel: string): UpsetFactor[] {
  const factors: UpsetFactor[] = [];
  // First table inside the section whose first header column matches /因子/
  const tables = $(`${sectionSel} table`);
  const sectionPattern = /因子/;
  for (let i = 0; i < tables.length; i++) {
    const $t = $(tables[i]!);
    const headers = $t.find("thead th, tr").first().find("th").map((_, th) => textOf($(th))).get();
    const isFactor = headers.length >= 3 && /因子/.test(headers[0] ?? "") && /权重/.test(headers[1] ?? "");
    if (!isFactor) continue;
    $t.find("tbody tr").each((__, tr) => {
      const cells = $(tr).find("td").map((___, td) => textOf($(td))).get();
      if (cells.length < 3) return;
      const label = (cells[0] ?? "").replace(/&#x27;/g, "'");
      const weight = cells[1] ?? "";
      const interp = (cells[2] ?? "").replace(/&#x27;/g, "'");
      if (!label || !weight) return;
      factors.push({
        label: label.length > 16 ? label.slice(0, 14) + "…" : label,
        weight,
        interp: interp.length > 42 ? interp.slice(0, 40) + "…" : interp,
      });
    });
    break;
  }
  // Sort by absolute weight value (descending) so the slide leads with
  // the most impactful drivers; cap at 5 cards.
  return factors
    .map(f => ({ ...f, _w: Math.abs(parseFloat(f.weight) || 0) }))
    .sort((a, b) => b._w - a._w)
    .slice(0, 5)
    .map(({ _w, ...rest }) => rest);
}
