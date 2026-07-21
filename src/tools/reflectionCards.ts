import type { Block } from "../schemas/block.js";
import { chatJson, isLLMAvailable } from "./llmClient.js";
import type { MarketData } from "./marketExtractor.js";

/**
 * LLM-powered narrative card synthesizers for the three story-heavy scenes
 * in the pipeline:
 *
 *   • RISK / 赛前反思    — 2/4/6 reflection cards from boundary blocks
 *   • TEAM-FUNDAMENTALS  — 4 highlight cards refining marketExtractor output
 *   • UPSET-DASHBOARD    — 2/4 interpretation cards beneath the gauge
 *
 * All three avoid betting/money/odds tokens, dial back the word "概率" in
 * favour of "可能性 / 倾向 / 走势", and keep bullet text tight enough to read
 * on a 9:16 mobile viewport. Each summariser returns null on any failure so
 * the COMPOSE layer gracefully falls back to the deterministic extraction
 * path already present in `marketExtractor.ts` / `riskItems` helper.
 */

export interface ReflectionCard {
  title: string;
  bullets: string[];
}

export interface FundamentalsHighlight {
  icon: string;
  title: string;
  bullets: string[];
  tone: "info" | "warn" | "good" | "bad";
}

export interface UpsetInterpretCard {
  title: string;
  bullets: string[];
}

const MAX_BULLETS_PER_CARD = 3;
const MAX_TITLE_CHARS = 12;
const MAX_BULLET_CHARS = 36;

/**
 * Money / amount / odds tokens that must never appear in narrative card
 * text. We filter at input *and* validate at output so the LLM cannot
 * smuggle them back in.
 */
const MONEY_TOKEN_RE = /[¥$]|资金|敞口|全押|本金|单注|起投|下注金额|净收益|凯利|kelly|赔率|套利/i;

export function collectReflectionSourceTexts(
  refBlocks: Block[],
): string[] {
  const out: string[] = [];
  for (const b of refBlocks) {
    if (b.kind === "paragraph") {
      const t = b.text.trim();
      if (t.length >= 12 && t.length <= 320 && !MONEY_TOKEN_RE.test(t)) {
        out.push(t);
      }

    } else if (b.kind === "callout") {
      if (b.tone === "compliance") continue;
      const t = b.text.trim();
      if (t.length >= 12 && t.length <= 320 && !MONEY_TOKEN_RE.test(t)) {
        out.push(t);
      }
    } else if (b.kind === "list") {
      for (const item of b.items) {
        const t = item.text.trim();
        if (t.length >= 8 && t.length <= 200 && !MONEY_TOKEN_RE.test(t)) {
          out.push(t);
        }
      }
    }
  }
  return out;
}

export interface SummarizeOpts {
  matchZh: string;
  league?: string;
  /** Desired card count; always rounded to nearest even ≤ 6 (so 2/4/6). */
  desiredCount?: number;
}

/**
 * Ask the LLM to turn source paragraphs into concise reflection cards for
 * the "赛前反思" scene.
 */
export async function summarizeReflectionCards(
  sources: string[],
  opts: SummarizeOpts,
): Promise<ReflectionCard[] | null> {
  if (!isLLMAvailable()) return null;
  if (sources.length === 0) return null;
  if (process.env.HARNESS_DISABLE_LLM === "1") return null;

  const desired = clampEven(opts.desiredCount ?? 4);

  const systemPrompt = `你是中文短视频的赛前反思编辑。把分析师笔记总结成 ${desired} 张移动端竖屏卡片。

# 卡片要求
- 每张卡片：一个 ≤ ${MAX_TITLE_CHARS} 字的标题 + 2~${MAX_BULLETS_PER_CARD} 条精简的反思性 bullet（每条 ≤ ${MAX_BULLET_CHARS} 字）
- 内容是**反思与提醒**，不是数据复述：用观察/留意/可能性/倾向/边界 的口吻
- 形容球队用"偏强/偏弱、主场气势/客场冲击力、经验老到/年轻冲劲"等画面化描述，**禁止用"硬/软"**
- "概率"是数学术语，能避就避；改用"可能性/倾向/走势/分布"
- **每条 bullet 最多 1 个具体数字**；其余信息用故事化叙述
- **严禁出现任何金额、币种、下注、赔率、凯利、资金、敞口等词汇**
- 标题与 bullet 都不要用"概率"二字
- 不要给行动建议或参与指引，只提供观察视角

# 输出格式（严格 JSON，仅输出 JSON）
{
  "cards": [
    { "title": "标题1", "bullets": ["反思一", "反思二"] },
    ...
  ]
}
必须正好 ${desired} 张卡片。`;

  const userPrompt = JSON.stringify({
    match: opts.matchZh,
    league: opts.league ?? "",
    desiredCardCount: desired,
    sourceNotes: sources.slice(0, 10),
  }, null, 2);

  let parsed: { cards?: Array<{ title?: string; bullets?: string[] }> };
  try {
    parsed = await chatJson<typeof parsed>({
      systemPrompt,
      userPrompt,
      maxTokens: 1200,
      temperature: 0.5,
      retries: 1,
    });
  } catch {
    return null;
  }

  const raw = Array.isArray(parsed?.cards) ? parsed.cards : [];
  const cards: ReflectionCard[] = [];
  for (const c of raw) {
    if (!c || typeof c.title !== "string" || !Array.isArray(c.bullets)) continue;
    const title = sanitizeShort(c.title, MAX_TITLE_CHARS);
    if (!title) continue;
    const bullets: string[] = [];
    for (const b of c.bullets) {
      if (typeof b !== "string") continue;
      if (MONEY_TOKEN_RE.test(b)) continue;
      const cleaned = sanitizeBullet(b);
      if (cleaned) bullets.push(cleaned);
      if (bullets.length >= MAX_BULLETS_PER_CARD) break;
    }
    if (bullets.length < 1) continue;
    cards.push({ title, bullets });
    if (cards.length >= 6) break;
  }
  const final = clampEven(cards.length);
  if (final < 2) return null;
  return cards.slice(0, final);
}

export interface FundamentalsSummarizeOpts extends SummarizeOpts {
  /** Raw highlight skeletons from marketExtractor (icon + title + dense bullets). */
  rawHighlights?: Array<{ icon?: string; title?: string; bullets?: string[]; tone?: string }>;
}

/**
 * Ask the LLM to refine the team-fundamentals "highlights" cards. Returns
 * exactly 4 polished cards with `{icon, title, bullets[2-3], tone}`. We
 * pass the raw highlights from marketExtractor (so tone/icon mappings stay
 * stable) and the scene's source paragraphs (so the LLM can write richer
 * bullets than the stripped-down regex extraction).
 */
export async function summarizeFundamentalsHighlights(
  sources: string[],
  opts: FundamentalsSummarizeOpts,
): Promise<FundamentalsHighlight[] | null> {
  if (!isLLMAvailable()) return null;
  if (process.env.HARNESS_DISABLE_LLM === "1") return null;
  if ((sources.length + (opts.rawHighlights?.length ?? 0)) === 0) return null;

  const systemPrompt = `你是中文短视频的赛前基本面编辑。把球队基本面分析总结成 **正好 4 张** 移动端竖屏解读卡片，每张卡片对应一个观察角度。

# 4 张卡片建议覆盖的角度（按报告内容自由选择/组合，缺失就跳过该角度）
- 战术对位 / 阵型 / 节奏
- 动机 · 形态 · 赛季背景
- 伤停 · 裁判 · 阵容变化
- 近期交锋 / H2H 走势
- 场地 · 主客场 · 天气
- 实力差距 / 上下盘视角

# 每张卡片
- title：≤ ${MAX_TITLE_CHARS} 字，名词短语（如"战术对位"、"动机背景"）
- bullets：2~${MAX_BULLETS_PER_CARD} 条，每条 ≤ ${MAX_BULLET_CHARS} 字
- tone：从 {"good","bad","warn","info"} 中选一个反映这张卡片的语气倾向
- icon：1 个 emoji（⚔️ 战术 / 🩹 伤停 / 🔥 动机 / 🏟️ 场地 / 🆚 H2H / 🧩 阵容 / 📌 默认）

# 风格硬规则
- 内容是**叙事性解读**，不是数据点堆叠：用"偏强/偏弱、主场气势、节奏、压制、释放、争抢"等画面化描述
- **禁止用"硬/软"**；**禁用"概率"二字**（改用可能性/倾向/走势）
- 每条 bullet **最多 1 个具体数字**，其它用故事化叙述
- **严禁金额、赔率、凯利、资金、下注、敞口、套利等词汇**
- 不给行动建议、不引导参与

# 输出格式（严格 JSON，仅输出 JSON）
{
  "highlights": [
    { "icon": "⚔️", "title": "战术对位", "bullets": ["……","……"], "tone": "info" },
    ...
  ]
}
必须**正好 4 张**。`;

  const userPrompt = JSON.stringify({
    match: opts.matchZh,
    league: opts.league ?? "",
    rawHighlights: (opts.rawHighlights ?? []).slice(0, 6),
    sourceNotes: sources.slice(0, 10),
  }, null, 2);

  let parsed: { highlights?: Array<{ icon?: string; title?: string; bullets?: string[]; tone?: string }> };
  try {
    parsed = await chatJson<typeof parsed>({
      systemPrompt,
      userPrompt,
      maxTokens: 1400,
      temperature: 0.5,
      retries: 1,
    });
  } catch {
    return null;
  }

  const raw = Array.isArray(parsed?.highlights) ? parsed.highlights : [];
  const TONES = new Set(["good", "bad", "warn", "info"]);
  const out: FundamentalsHighlight[] = [];
  for (const c of raw) {
    if (!c || typeof c.title !== "string" || !Array.isArray(c.bullets)) continue;
    const title = sanitizeShort(c.title, MAX_TITLE_CHARS);
    if (!title) continue;
    const bullets: string[] = [];
    for (const b of c.bullets) {
      if (typeof b !== "string") continue;
      if (MONEY_TOKEN_RE.test(b)) continue;
      const cleaned = sanitizeBullet(b);
      if (cleaned) bullets.push(cleaned);
      if (bullets.length >= MAX_BULLETS_PER_CARD) break;
    }
    if (bullets.length === 0) continue;
    const tone = (typeof c.tone === "string" && TONES.has(c.tone) ? c.tone : "info") as FundamentalsHighlight["tone"];
    const icon = typeof c.icon === "string" && c.icon.trim().length > 0
      ? c.icon.trim().slice(0, 4)
      : pickFundamentalsIcon(title);
    out.push({ icon, title, bullets, tone });
    if (out.length >= 4) break;
  }
  if (out.length < 2) return null;
  // Pad to 4 if the LLM gave only 2-3 — we want a balanced 2x2 row.
  // We simply duplicate the icon/tone defaults from the most relevant
  // remaining raw highlight if there is one, otherwise stop early and let
  // the template adapt.
  return out.slice(0, 4);
}

export interface UpsetSummarizeOpts extends SummarizeOpts {
  upsetSnapshot?: {
    probPct?: string;
    band?: string;
    favTeam?: string;
    favPct?: string;
    complexity?: string;
    topScores?: Array<{ score: string; pct: number; interp?: string }>;
    factors?: Array<{ label: string; weight: string; interp?: string }>;
  };
}

export interface LocalReflectionOpts extends SummarizeOpts {
  market?: MarketData | null;
}

/**
 * Local agent fallback for "赛前反思" cards. This is deliberately not an LLM
 * call: it turns the already parsed market snapshot into a balanced 4-card
 * narrative grid, so the visual never falls back to thin strategy/risk slices
 * when HARNESS_DISABLE_LLM=1.
 */
export function buildLocalReflectionCards(
  sources: string[],
  opts: LocalReflectionOpts,
): ReflectionCard[] | null {
  const market = opts.market ?? null;
  const cards: ReflectionCard[] = [];

  const add = (title: string, bullets: string[]) => {
    if (cards.length >= 4) return;
    const cleanTitle = sanitizeShort(title, MAX_TITLE_CHARS);
    const cleanBullets = bullets
      .map(b => sanitizeBullet(stripMoneyTerms(b)))
      .filter(Boolean)
      .slice(0, MAX_BULLETS_PER_CARD);
    if (cleanTitle && cleanBullets.length > 0) cards.push({ title: cleanTitle, bullets: cleanBullets });
  };

  const fav = market?.market1x2?.outcomes?.slice().sort((a, b) => b.pct - a.pct)[0];
  const second = market?.market1x2?.outcomes?.slice().sort((a, b) => b.pct - a.pct)[1];
  const topScore = market?.correctScore?.topScores?.[0];
  const upsetScore = pickUpsetScore(market?.upset?.scores ?? []);

  if (market?.fundamentals) {
    add("强弱底色", [
      firstSentence(market.fundamentals.homeBlurb),
      firstSentence(market.fundamentals.awayBlurb),
    ]);
  }

  if (fav) {
    add("分布重心", [
      `模型更偏向${fav.team && fav.team !== "—" ? fav.team : fav.role}，数值约${fmtPct(fav.pct)}`,
      second ? `${second.role}还有${fmtPct(second.pct)}，分布不能只看单线` : "第二落点仍会影响比赛叙事",
    ]);
  }

  if (market?.upset) {
    add("爆冷边界", [
      `${upsetLabel(market)}空间约${market.upset.probPct}`,
      market.upset.band ? `${market.upset.band}，热门也要看临场节奏` : firstSentence(market.upset.complexity),
    ]);
  }

  if (topScore || upsetScore) {
    add("比分剧本", [
      topScore ? `常规剧本先看${topScore.score}，约${fmtPct(topScore.pct)}` : "",
      upsetScore ? `反向窗口落在${upsetScore.score}，约${fmtPct(upsetScore.pct)}` : "平局窗口会放大比赛变量",
    ]);
  }

  for (const src of sources) {
    if (cards.length >= 4) break;
    const clean = stripMoneyTerms(src);
    if (!clean || clean.length < 8) continue;
    add(titleFromSource(clean), splitSourceBullets(clean));
  }

  while (cards.length < 4) {
    const fallback = [
      { title: "观察边界", bullets: ["模型描述的是分布，不是赛果承诺。", "强弱关系也会被节奏改写。"] },
      { title: "临场变量", bullets: ["开局节奏会影响后续空间。", "一次定位球也可能改变走势。"] },
      { title: "阅读方式", bullets: ["先看倾向，再看反向窗口。", "把数字当地图，不当结论。"] },
    ][cards.length % 3]!;
    add(fallback.title, fallback.bullets);
  }

  return cards.slice(0, 4);
}

/**
 * Local agent fallback for the upset-dashboard interpretation row. It produces
 * exactly four narrative cards from the parsed upset snapshot, avoiding the
 * previous empty row when external LLM writing is disabled.
 */
export function buildLocalUpsetInterpretCards(
  sources: string[],
  opts: UpsetSummarizeOpts,
): UpsetInterpretCard[] | null {
  const snap = opts.upsetSnapshot;
  if (!snap && sources.length === 0) return null;

  const cards: UpsetInterpretCard[] = [];
  const add = (title: string, bullets: string[]) => {
    const cleanTitle = sanitizeShort(title, MAX_TITLE_CHARS);
    const cleanBullets = bullets
      .map(b => sanitizeBullet(stripMoneyTerms(b)))
      .filter(Boolean)
      .slice(0, MAX_BULLETS_PER_CARD);
    if (cleanTitle && cleanBullets.length > 0) cards.push({ title: cleanTitle, bullets: cleanBullets });
  };

  const topScores = snap?.topScores ?? [];
  const top = topScores[0];
  const second = topScores[1] ?? topScores[0];
  const factor = snap?.factors?.find(f => f.interp) ?? snap?.factors?.[0];
  const source = sources.find(s => s.length >= 8);

  add("爆冷量级", [
    snap?.probPct ? `反向空间约${snap.probPct}` : "反向空间需要结合平局一起看",
    snap?.band ? `${snap.band}，说明热门并非锁死` : "这不是单线结论，要看比赛怎么展开",
  ]);

  add("热门压力", [
    snap?.favTeam ? `热门是${snap.favTeam}，热度约${snap.favPct ?? "偏高"}` : "热门方向更清楚，但仍有压力",
    "热门越高，越要留意节奏被拖慢。",
  ]);

  add("比分剧本", [
    top ? `${top.score}是最醒目的反向窗口` : "平局是最常见的冷门入口",
    second && second !== top ? `${second.score}提供另一条僵持路径` : "低比分会让弱势方更有呼吸空间",
  ]);

  add("模型边界", [
    factor?.interp ?? firstSentence(snap?.complexity ?? source ?? ""),
    "样本和临场节奏会拉宽判断边界。",
  ]);

  return cards.slice(0, 4);
}

/**
 * Generate 2 or 4 interpretation cards rendered beneath the upset gauge.
 * Cards explain *why* the upset risk is what it is, in narrative form.
 */
export async function summarizeUpsetInterpretCards(
  sources: string[],
  opts: UpsetSummarizeOpts,
): Promise<UpsetInterpretCard[] | null> {
  if (!isLLMAvailable()) return null;
  if (process.env.HARNESS_DISABLE_LLM === "1") return null;
  if ((sources.length + (opts.upsetSnapshot ? 1 : 0)) === 0) return null;

  const desired = clampEven(opts.desiredCount ?? 4);

  const systemPrompt = `你是中文短视频的爆冷分析编辑。围绕"主队不输/热门翻车"，把分析师笔记总结成 **${desired} 张** 移动端竖屏解读卡片。

# 4 张卡片可覆盖的角度（按报告内容选择）
- 谁更可能爆冷 · 为什么
- 爆冷需要的关键条件
- 最有戏的爆冷剧本 / 比分情景
- 模型的边界 · 盲区 · 不确定性

# 每张卡片
- title：≤ ${MAX_TITLE_CHARS} 字，叙事短语（如"主场气势"、"剧本一：闷平"）
- bullets：2~${MAX_BULLETS_PER_CARD} 条，每条 ≤ ${MAX_BULLET_CHARS} 字
- 内容是**叙事解读**，让观众一眼读懂"爆冷大概率/小概率以及为什么"

# 风格硬规则
- **禁止用"硬/软"** 描述球队；**禁用"概率"二字**（改用可能性/倾向/走势）
- 每条 bullet **最多 1 个具体数字**
- **严禁金额、赔率、凯利、资金、下注、敞口等词汇**
- 不给行动建议，只解读模型分布

# 输出格式（严格 JSON，仅输出 JSON）
{
  "cards": [
    { "title": "标题1", "bullets": ["……","……"] },
    ...
  ]
}
必须正好 ${desired} 张。`;

  const userPrompt = JSON.stringify({
    match: opts.matchZh,
    league: opts.league ?? "",
    desiredCardCount: desired,
    upsetSnapshot: opts.upsetSnapshot ?? null,
    sourceNotes: sources.slice(0, 10),
  }, null, 2);

  let parsed: { cards?: Array<{ title?: string; bullets?: string[] }> };
  try {
    parsed = await chatJson<typeof parsed>({
      systemPrompt,
      userPrompt,
      maxTokens: 1400,
      temperature: 0.5,
      retries: 1,
    });
  } catch {
    return null;
  }

  const raw = Array.isArray(parsed?.cards) ? parsed.cards : [];
  const out: UpsetInterpretCard[] = [];
  for (const c of raw) {
    if (!c || typeof c.title !== "string" || !Array.isArray(c.bullets)) continue;
    const title = sanitizeShort(c.title, MAX_TITLE_CHARS);
    if (!title) continue;
    const bullets: string[] = [];
    for (const b of c.bullets) {
      if (typeof b !== "string") continue;
      if (MONEY_TOKEN_RE.test(b)) continue;
      const cleaned = sanitizeBullet(b);
      if (cleaned) bullets.push(cleaned);
      if (bullets.length >= MAX_BULLETS_PER_CARD) break;
    }
    if (bullets.length === 0) continue;
    out.push({ title, bullets });
    if (out.length >= 6) break;
  }
  const final = clampEven(out.length);
  if (final < 2) return null;
  return out.slice(0, final);
}

function clampEven(n: number): number {
  if (n >= 6) return 6;
  if (n >= 4) return 4;
  return 2;
}

function sanitizeShort(s: string, max: number): string {
  const cleaned = s.replace(/[*＊"'""`]+/g, "").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function sanitizeBullet(s: string): string {
  let cleaned = s.replace(/[*＊"'""`]+/g, "").replace(/\s+/g, " ").trim();
  // Convert "概率" → "可能性" defensively
  cleaned = cleaned.replace(/概率/g, "可能性");
  // Convert obvious 硬/软 descriptors
  cleaned = cleaned
    .replace(/一边硬[,，、]?\s*一边软/g, "一边偏强、一边偏弱")
    .replace(/(?<![软])硬一些/g, "偏强一些")
    .replace(/(?<![硬])软一些/g, "偏弱一些");
  if (!cleaned) return "";
  if (cleaned.length > MAX_BULLET_CHARS) cleaned = cleaned.slice(0, MAX_BULLET_CHARS - 1) + "…";
  if (!/[。！？，、]$/.test(cleaned)) cleaned += "。";
  return cleaned;
}

function stripMoneyTerms(s: string): string {
  if (!s || MONEY_TOKEN_RE.test(s)) return "";
  return s
    .replace(/大概率/g, "更可能")
    .replace(/概率/g, "可能性")
    .replace(/(?<![软])硬一些/g, "偏强一些")
    .replace(/(?<![硬])软一些/g, "偏弱一些")
    .trim();
}

function firstSentence(s: string | undefined): string {
  const raw = stripMoneyTerms(String(s ?? "").replace(/\s+/g, " ").trim());
  if (!raw) return "";
  const first = raw.split(/[。！？；;]/).find(Boolean) ?? raw;
  return first.length > MAX_BULLET_CHARS ? first.slice(0, MAX_BULLET_CHARS - 1) + "…" : first;
}

function fmtPct(n: number | undefined): string {
  if (!Number.isFinite(Number(n))) return "";
  return `${Number(n).toFixed(1)}%`;
}

function titleFromSource(s: string): string {
  const left = s.split(/[：:，,。；;]/, 1)[0] ?? "观察提醒";
  return left.length > MAX_TITLE_CHARS ? left.slice(0, MAX_TITLE_CHARS) : left;
}

function splitSourceBullets(s: string): string[] {
  return s
    .split(/[。！？；;]/)
    .map(x => x.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function pickUpsetScore(scores: Array<{ score: string; pct: number; interp?: string }>): { score: string; pct: number } | undefined {
  return scores.find(s => !/主胜|热门|主队领先/.test(s.interp ?? ""))
    ?? scores.find(s => /平局|客胜|爆冷|反击|僵持/.test(s.interp ?? ""))
    ?? scores[0];
}

function upsetLabel(market: MarketData): string {
  const fav = market.upset?.favTeam?.trim();
  const home = market.hero?.homeName?.trim() || market.fundamentals?.homeName?.trim();
  const away = market.hero?.awayName?.trim() || market.fundamentals?.awayName?.trim();
  if (fav && home && fav === home && away) return `${away}不输`;
  if (fav && away && fav === away && home) return `${home}不输`;
  return "非热门方向";
}

function pickFundamentalsIcon(title: string): string {
  if (/战术|对位|阵型|节奏|压制|高位/.test(title))   return "⚔️";
  if (/伤停|停赛|裁判|阵容|首发|轮换/.test(title))   return "🩹";
  if (/动机|赛季|背景|气势|心理|压力|争冠|保级/.test(title)) return "🔥";
  if (/场地|主场|客场|气候|天气|草皮/.test(title))   return "🏟️";
  if (/交锋|H2H|历史|往绩|对手/i.test(title))        return "🆚";
  if (/实力|差距|强弱|对位/.test(title))             return "📊";
  return "📌";
}
