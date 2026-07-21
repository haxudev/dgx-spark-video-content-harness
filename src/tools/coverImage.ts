import { generateImage, imageConfigured } from "./backgroundImage.js";
import { COMPLIANCE_POLICY } from "./compliancePolicy.js";
import { chatJson, isLLMAvailable } from "./llmClient.js";
import type { Outcome } from "./marketExtractor.js";

export interface CoverScore {
  score: string;
  pct: number;
  lead?: boolean;
}

export interface CoverGoals {
  goals: string;   // "2" / "3" / "1"
  pct: number;
}

export interface CoverPromptContext {
  matchZh?: string | null;
  league?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
  outcomes?: Outcome[] | null;
  topScores?: CoverScore[] | null;
  topGoals?: CoverGoals[] | null;
}

export interface CoverProbability {
  role: string;
  team: string;
  pct: number;
  lead: boolean;
}

export interface CoverBrief {
  brand: string;
  fixture: string;
  league?: string;
  homeTeam?: string;
  awayTeam?: string;
  probabilities: CoverProbability[];
  topScores: CoverScore[];
  topGoals: CoverGoals[];
}

/** True when an Azure image deployment is configured and cover generation is not disabled. */
export function isCoverGenAvailable(): boolean {
  if (process.env.HARNESS_SKIP_COVER === "1") return false;
  return imageConfigured();
}

export function coverDurationSec(): number {
  const n = Number.parseFloat(process.env.HARNESS_COVER_SEC ?? "");
  if (!Number.isFinite(n)) return 3.2;
  return Math.min(8, Math.max(1, n));
}

export function buildCoverBrief(ctx: CoverPromptContext): CoverBrief {
  const split = splitTeams(ctx.matchZh);
  const homeTeam = (ctx.homeTeam || split.home || "").trim();
  const awayTeam = (ctx.awayTeam || split.away || "").trim();
  const fixture = homeTeam && awayTeam
    ? `${homeTeam} vs ${awayTeam}`
    : (ctx.matchZh?.trim() || "本场比赛");

  return {
    brand: COMPLIANCE_POLICY.brand,
    fixture,
    league: ctx.league?.trim() || undefined,
    homeTeam: homeTeam || undefined,
    awayTeam: awayTeam || undefined,
    probabilities: fair1x2Probabilities(ctx.outcomes),
    topScores: top3Scores(ctx.topScores),
    topGoals: top3Goals(ctx.topGoals),
  };
}

/** Convert source 1x2 percentages to integer fair probabilities summing to 100. */
export function fair1x2Probabilities(outcomes?: Outcome[] | null): CoverProbability[] {
  const rows = orderOutcomes(outcomes ?? [])
    .filter(o => Number.isFinite(o.pct) && o.pct > 0);
  if (rows.length === 0) return [];

  const sum = rows.reduce((acc, o) => acc + o.pct, 0);
  if (sum <= 0) return [];

  const exact = rows.map(o => (o.pct / sum) * 100);
  const ints = exact.map(Math.floor);
  let left = 100 - ints.reduce((acc, n) => acc + n, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac);
  for (const item of order) {
    if (left <= 0) break;
    ints[item.i] += 1;
    left -= 1;
  }

  return rows.map((o, i) => ({
    role: o.role,
    team: o.team,
    pct: ints[i],
    lead: o.lead,
  }));
}

export function top3Scores(scores?: CoverScore[] | null): CoverScore[] {
  return (scores ?? [])
    .filter(s => s.score && Number.isFinite(s.pct))
    .slice(0, 3)
    .map(s => ({ score: s.score, pct: s.pct, lead: s.lead }));
}

export function top3Goals(goals?: CoverGoals[] | null): CoverGoals[] {
  return (goals ?? [])
    .filter(g => g.goals !== undefined && g.goals !== null && Number.isFinite(g.pct))
    .slice(0, 3)
    .map(g => ({ goals: String(g.goals), pct: g.pct }));
}

export async function buildCoverPrompt(ctx: CoverPromptContext): Promise<string> {
  const brief = buildCoverBrief(ctx);
  if (process.env.HARNESS_DISABLE_LLM !== "1" && isLLMAvailable()) {
    try {
      const res = await chatJson<{ prompt?: string }>({
        systemPrompt: [
          "你为足球短视频封面写一句英文 gpt-image-2 绘图提示词，输出竖屏 9:16 电影感封面背景图。",
          "画面风格：写实电影质感（photorealistic cinematic sports photography），鲜明体现双方球队特征——左右两侧分别展示各自国旗与队伍主色、一名写实球星气质的足球运动员（动态拼抢/奔跑姿态）、以及该队的队徽/纹章徽标元素；强对比深色背景、体育场灯光。",
          "排版构图：画面上中部留给两名球员与队伍元素；**下方三分之一压暗、低细节、留白**，便于叠加比赛数据字幕卡片。",
          "防侵权：球员用写实但虚构的通用运动员，不画可辨识的真实人物肖像、不写真实球员姓名或球衣号码；队徽用该队配色的纹章风格徽标，不照搬真实商标 logo。",
          "**不要在图里渲染任何概率、比分、百分比数字或大段文字**（这些会由后期叠加），最多只允许出现两队队名；不得出现购买、推荐、前瞻、赔率、下注等词。",
          '只输出 JSON：{"prompt":"<English image prompt>"}。',
        ].join("\n"),
        userPrompt: JSON.stringify(toPromptPayload(brief), null, 2),
        maxTokens: 500,
        temperature: 0.7,
        // Prompt authoring is a nice-to-have over the deterministic template;
        // keep it snappy so COMPOSE never stalls on a slow operator model.
        retries: 1,
        timeoutMs: 60_000,
      });
      const prompt = (res?.prompt ?? "").trim();
      if (prompt.length >= 40) return prompt;
    } catch {
      // fall through to deterministic fallback
    }
  }

  return deterministicCoverPrompt(brief);
}

/**
 * Ordered list of cover-prompt candidates: the agent-authored two-team poster
 * prompt first (when a chat LLM is available), then the deterministic template
 * as a safe fallback. {@link generateImageWithFallback} walks this list so a
 * content-filter rejection on the richer authored prompt still degrades to the
 * conservative deterministic prompt instead of dropping the Act-1 cover image.
 */
export async function buildCoverPromptCandidates(ctx: CoverPromptContext): Promise<string[]> {
  const deterministic = deterministicCoverPrompt(buildCoverBrief(ctx));
  const authored = await buildCoverPrompt(ctx);
  const out = [authored];
  if (!out.includes(deterministic)) out.push(deterministic);
  return out;
}

export async function generateCover(prompt: string, outPath: string): Promise<boolean> {
  return generateImage(prompt, outPath);
}

function toPromptPayload(brief: CoverBrief): Record<string, unknown> {
  return {
    brand: brief.brand,
    fixture: brief.fixture,
    league: brief.league,
    homeTeam: brief.homeTeam,
    awayTeam: brief.awayTeam,
    note: "Cinematic two-team poster BACKDROP only. Render two realistic footballers with each nation's flag, team colors and a crest emblem; generic athletes only, no real-person likeness, no real player names or numbers, no real-brand logos. Do NOT render any probabilities, scorelines, percentages or long text — the data is overlaid later. Keep the lower third dark and uncluttered for a caption overlay.",
  };
}

function deterministicCoverPrompt(brief: CoverBrief): string {
  const fixture = brief.fixture;
  const teamLine = brief.homeTeam && brief.awayTeam
    ? `evoke "${brief.homeTeam}" on the left and "${brief.awayTeam}" on the right`
    : `evoke the fixture "${fixture}"`;

  return [
    "Premium photorealistic cinematic vertical 9:16 football match-preview cover BACKDROP, realistic sports photography style, dramatic stadium floodlights, dark high-contrast design,",
    `split the frame into two sides — ${teamLine} — each side showing that team's national flag, dominant team colors, a heraldic crest/badge emblem in those colors, and one realistic dynamic footballer in matching kit (running/challenging pose),`,
    "footballers are generic fictional athletes — no recognizable real-person likeness, no real player names or shirt numbers, crests are stylized (not real-brand logos),",
    "do NOT render any probabilities, scorelines, percentages, odds, or long text; at most the two team names may appear,",
    "keep the lower third dark and low-detail for an overlaid data card,",
    "no purchase or recommendation wording, no word 前瞻, no watermark, mobile-first composition.",
  ].filter(Boolean).join(" ");
}

function probabilityText(brief: CoverBrief): string {
  return brief.probabilities
    .map(p => `${p.role}${p.pct}%`)
    .join("  ");
}

function scoreText(brief: CoverBrief): string {
  return brief.topScores
    .map(s => `${s.score} ${Math.round(s.pct)}%`)
    .join("  ");
}

function goalsText(brief: CoverBrief): string {
  return brief.topGoals
    .map(g => `${g.goals}球 ${Math.round(g.pct)}%`)
    .join("  ");
}

function orderOutcomes(outcomes: Outcome[]): Outcome[] {
  const order = ["主胜", "平局", "客胜"];
  return [...outcomes].sort((a, b) => {
    const ai = order.indexOf(a.role);
    const bi = order.indexOf(b.role);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    return 0;
  });
}

function splitTeams(matchZh?: string | null): { home?: string; away?: string } {
  if (!matchZh) return {};
  const cleaned = matchZh.replace(/\s*[·|].*$/, "").trim();
  const parts = cleaned.split(/\s*(?:vs\.?|VS|对阵|对|-|—|：|:)\s*/i).filter(Boolean);
  if (parts.length >= 2) return { home: parts[0]!.trim(), away: parts[1]!.trim() };
  return {};
}
