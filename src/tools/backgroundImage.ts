import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { chatJson, isLLMAvailable } from "./llmClient.js";
import { getBufferWithCurl, postJsonWithCurl } from "./curlHttp.js";

/**
 * Agent-authored persistent background image for the composition.
 *
 * The image-generation prompt is **authored by the LLM agent** (so it reflects
 * the actual fixture — e.g. the two teams' colours / stadium atmosphere) and the
 * pixels are produced by Azure OpenAI `gpt-image-2`. Everything here is best-
 * effort and optional:
 *
 *   - `isImageGenAvailable()` is false unless the image deployment is configured
 *     (and `HARNESS_SKIP_BGIMAGE` is not set), so offline tests / credential-less
 *     runs simply skip it and COMPOSE falls back to the gradient/aurora backdrop.
 *   - prompt authoring falls back to a deterministic template when no chat LLM is
 *     configured (kept tiny + JSON-only so a 35B operator model returns it
 *     reliably).
 *   - generation failures are swallowed by the caller (non-fatal).
 *
 * Env (image-specific first, then user-friendly aliases):
 *   AZURE_OPENAI_IMAGE_DEPLOYMENT / AZURE_OPENAI_image_model   (required to enable)
 *   AZURE_OPENAI_IMAGE_ENDPOINT   / AZURE_OPENAI_ENDPOINT
 *   AZURE_OPENAI_IMAGE_API_KEY    / AZURE_OPENAI_KEY / AZURE_OPENAI_API_KEY
 *   AZURE_OPENAI_IMAGE_API_VERSION (default 2025-04-01-preview)
 *   AZURE_OPENAI_IMAGE_SIZE        (default 1024x1536 — portrait)
 *   AZURE_OPENAI_IMAGE_QUALITY     (default medium)
 *   HARNESS_BGIMAGE_MAX_RETRIES    (default 2)
 *   HARNESS_BGIMAGE_TIMEOUT_MS     (default 240000)
 *   HARNESS_SKIP_BGIMAGE=1         (force-disable even when configured)
 */

export interface BgPromptContext {
  /** "曼联 vs 利物浦" or similar. */
  matchZh?: string | null;
  league?: string | null;
  homeTeam?: string | null;
  awayTeam?: string | null;
}

function imageEndpoint(): string | undefined {
  return process.env.AZURE_OPENAI_IMAGE_ENDPOINT?.trim() || process.env.AZURE_OPENAI_ENDPOINT?.trim();
}
function imageApiKey(): string | undefined {
  return process.env.AZURE_OPENAI_IMAGE_API_KEY?.trim()
    || process.env.AZURE_OPENAI_KEY?.trim()
    || process.env.AZURE_OPENAI_API_KEY?.trim();
}
function imageDeployment(): string | undefined {
  return process.env.AZURE_OPENAI_IMAGE_DEPLOYMENT?.trim()
    || process.env.AZURE_OPENAI_image_model?.trim()
    || undefined;
}

/** True when an Azure gpt-image-2 deployment is configured (endpoint + key + deployment). */
export function imageConfigured(): boolean {
  return Boolean(imageEndpoint() && imageApiKey() && imageDeployment());
}

/** True when an Azure image deployment is configured and bg-image is not disabled. */
export function isImageGenAvailable(): boolean {
  if (process.env.HARNESS_SKIP_BGIMAGE === "1") return false;
  return imageConfigured();
}

/** Split a "A vs B" / "A 对 B" match label into the two team names. */
function splitTeams(matchZh?: string | null): { home?: string; away?: string } {
  if (!matchZh) return {};
  const cleaned = matchZh.replace(/\s*[·|].*$/, "").trim();
  const m = cleaned.split(/\s*(?:vs\.?|VS|对阵|对|-|—|：|:)\s*/i).filter(Boolean);
  if (m.length >= 2) return { home: m[0]!.trim(), away: m[1]!.trim() };
  return {};
}

/**
 * Ask the LLM agent to author an English gpt-image-2 prompt for a dark,
 * cinematic, vertical (9:16) background that evokes the two teams without
 * reproducing any trademarked crest/logo or readable text. Kept short + strictly
 * JSON so a small (≈35B) operator model returns it reliably. Falls back to a
 * deterministic prompt when no chat LLM is configured or the call fails.
 */
export async function buildBackgroundPrompt(ctx: BgPromptContext): Promise<string> {
  const split = splitTeams(ctx.matchZh);
  const home = (ctx.homeTeam || split.home || "").trim();
  const away = (ctx.awayTeam || split.away || "").trim();
  const fixture = home && away ? `${home} vs ${away}` : (ctx.matchZh ?? "a European football fixture");

  if (isLLMAvailable()) {
    try {
      // 35B-friendly: one short instruction block + a tiny fixed JSON schema.
      const system = [
        "你为足球短视频写一句英文绘图提示词(image prompt)，交给 gpt-image-2 出竖屏(9:16)背景图。",
        "要求：",
        "- 强烈的足球比赛氛围：夜晚球场草皮、看台灯光、足球、球员剪影等元素至少出现一部分；",
        "- 把对阵两队的识别元素融入画面：先判断是国家队还是俱乐部，再用各自的代表色 / 球衣配色 / 国旗或城市色系 / 球迷氛围来体现，让画面两侧分别呼应两队；",
        "- 暗调电影感，画面中部和下部压暗、低细节，方便叠加字幕卡片；",
        "- 不要绘制任何真实受商标保护的队徽 / logo，不要出现任何文字、字母、数字、水印；不出现商业导流或行动建议元素；适合全年龄。",
        '只输出 JSON：{"prompt":"<一句英文绘图提示词>"}。',
      ].join("\n");
      const teamKind = inferTeamKind(ctx.league);
      const user = [
        `比赛: ${fixture}`,
        ctx.league ? `联赛: ${ctx.league}` : "",
        home ? `主队: ${home}` : "",
        away ? `客队: ${away}` : "",
        teamKind ? `队伍类型: ${teamKind}` : "",
      ].filter(Boolean).join("\n");

      const res = await chatJson<{ prompt?: string }>({
        systemPrompt: system,
        userPrompt: user,
        maxTokens: 400,
        temperature: 0.7,
        // Keep prompt authoring snappy — the deterministic prompt is a fine
        // fallback, so a slow operator model must not stall COMPOSE.
        retries: 1,
        timeoutMs: 60_000,
      });
      const prompt = (res?.prompt ?? "").trim();
      if (prompt.length >= 20) return prompt;
    } catch {
      // fall through to deterministic prompt
    }
  }

  return deterministicPrompt(home, away);
}

/**
 * Ordered list of background-prompt candidates: the agent-authored prompt first
 * (when a chat LLM is available), then the deterministic template as a safe
 * fallback. {@link generateImageWithFallback} walks this list so a prompt that
 * the gpt-image-2 content filter rejects (HTTP 400, not retried) still degrades
 * to the conservative deterministic prompt instead of dropping the image
 * entirely. Used by COMPOSE to keep the persistent background image mandatory.
 */
export async function buildBackgroundPromptCandidates(ctx: BgPromptContext): Promise<string[]> {
  const split = splitTeams(ctx.matchZh);
  const home = (ctx.homeTeam || split.home || "").trim();
  const away = (ctx.awayTeam || split.away || "").trim();
  const deterministic = deterministicPrompt(home, away);
  const authored = await buildBackgroundPrompt(ctx);
  const out = [authored];
  if (!out.includes(deterministic)) out.push(deterministic);
  return out;
}

/** Coarse national-team vs club hint from the league name (helps the agent pick team elements). */
function inferTeamKind(league?: string | null): string | undefined {
  if (!league) return undefined;
  if (/世界杯|欧洲杯|欧国联|美洲杯|亚洲杯|国家|联合会杯|世预赛|欧预赛|国际友谊/.test(league)) return "国家队（用国旗色系/国家队球衣配色）";
  return "俱乐部（用俱乐部代表色/球衣配色/城市氛围）";
}

function deterministicPrompt(home: string, away: string): string {
  const teams = home && away
    ? `with abstract color fields and light streaks on the two sides evoking the identities of ${home} and ${away} through their team color tones`
    : "with two contrasting team color tones on each side";
  return [
    "Cinematic, moody, dark vertical 9:16 football match atmosphere:",
    "a night football pitch under stadium floodlights, blurred crowd in the stands, a football on the grass and distant player silhouettes,",
    `${teams},`,
    "no logos, no crests, no text, no letters, no numbers, no watermark,",
    "the central and lower area kept dark and low-detail for overlay subtitles,",
    "photographic, high quality, subtle film grain.",
  ].join(" ");
}

function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function retryDelayMs(attempt: number): number {
  return Math.min(8_000, 1_000 * Math.pow(2, attempt));
}

function shouldRetryImageError(status?: number): boolean {
  if (!status) return true;
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Build the Azure OpenAI images endpoint URL + auth headers. Supports both the
 * classic per-deployment surface (`https://<res>.openai.azure.com` →
 * `/openai/deployments/<dep>/images/generations?api-version=…`) and the newer
 * `/openai/v1` surface (`…/openai/v1/images/generations`).
 */
function imageRequest(): { url: string; headers: Record<string, string>; model: string; includeModel: boolean } | null {
  const endpoint = imageEndpoint();
  const apiKey = imageApiKey();
  const model = imageDeployment();
  if (!endpoint || !apiKey || !model) return null;

  const base = endpoint.replace(/\/+$/, "");
  const apiVersion = process.env.AZURE_OPENAI_IMAGE_API_VERSION?.trim() || "2025-04-01-preview";

  if (/\/openai\/v1$/.test(base)) {
    return {
      url: `${base}/images/generations`,
      headers: { "Content-Type": "application/json", "api-key": apiKey, Authorization: `Bearer ${apiKey}` },
      model,
      includeModel: true,
    };
  }
  return {
    url: `${base}/openai/deployments/${encodeURIComponent(model)}/images/generations?api-version=${encodeURIComponent(apiVersion)}`,
    headers: { "Content-Type": "application/json", "api-key": apiKey },
    model,
    includeModel: false,
  };
}

/**
 * Generate an image with Azure OpenAI gpt-image-2 and write it to `outPath`
 * (PNG). Results are cached by (model, size, quality, prompt) hash so retries
 * don't re-bill the image API. Returns true on success.
 *
 * Generic over the caller's intent — used for both the cinematic background
 * (`generateBackground`) and the title/cover poster (`coverImage.ts`).
 */
export async function generateImage(prompt: string, outPath: string): Promise<boolean> {
  const req = imageRequest();
  if (!req) return false;

  const size = process.env.AZURE_OPENAI_IMAGE_SIZE?.trim() || "1024x1536";
  const quality = process.env.AZURE_OPENAI_IMAGE_QUALITY?.trim() || "medium";

  const cacheDir = path.join(process.cwd(), ".cache", "bgimage");
  const cacheFile = path.join(cacheDir, `${sha1(`${req.model}\u241f${size}\u241f${quality}\u241f${prompt}`)}.png`);

  // Cache hit → copy and return.
  try {
    await fs.access(cacheFile);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.copyFile(cacheFile, outPath);
    return true;
  } catch { /* miss */ }

  const body = { ...(req.includeModel ? { model: req.model } : {}), prompt, n: 1, size, quality };
  const retries = intEnv("HARNESS_BGIMAGE_MAX_RETRIES", 4, 0, 10);
  const timeoutMs = intEnv("HARNESS_BGIMAGE_TIMEOUT_MS", 240_000, 30_000, 900_000);
  let json: { data?: Array<{ b64_json?: string; url?: string }> } | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const text = await postJsonWithCurl(req.url, req.headers, body, timeoutMs);
      json = JSON.parse(text) as { data?: Array<{ b64_json?: string; url?: string }> };
      break;
    } catch (e: any) {
      lastErr = e;
      const status = e?.status ?? e?.response?.status;
      if (!shouldRetryImageError(status) || attempt >= retries) break;
      await sleep(retryDelayMs(attempt));
    }
  }
  if (!json) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  let buf: Buffer | null = null;
  const b64 = json.data?.[0]?.b64_json;
  if (b64) {
    buf = Buffer.from(b64, "base64");
  } else if (json.data?.[0]?.url) {
    buf = await getBufferWithCurl(json.data[0]!.url!, timeoutMs);
  }
  if (!buf) return false;

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
  try {
    await fs.mkdir(cacheDir, { recursive: true });
    await fs.writeFile(cacheFile, buf);
  } catch { /* cache write best-effort */ }
  return true;
}

/**
 * Backwards-compatible alias for the cinematic background. Identical behaviour
 * to {@link generateImage}; kept so existing call sites (COMPOSE) keep working.
 */
export async function generateBackground(prompt: string, outPath: string): Promise<boolean> {
  return generateImage(prompt, outPath);
}

/**
 * Try each prompt in order until gpt-image-2 produces an image. Each individual
 * `generateImage` call already retries transient network / 429 / 5xx errors;
 * this wrapper additionally walks a list of *prompt* candidates so a content-
 * filter rejection (HTTP 400 — not retried) on the agent-authored prompt falls
 * back to the conservative deterministic prompt. Returns true on the first
 * success; re-throws the last error only if every candidate threw without ever
 * succeeding (so COMPOSE can treat a hard failure as a blocking issue).
 */
export async function generateImageWithFallback(prompts: string[], outPath: string): Promise<boolean> {
  let lastErr: unknown = null;
  for (const prompt of prompts) {
    if (!prompt || prompt.trim().length < 10) continue;
    try {
      if (await generateImage(prompt, outPath)) return true;
    } catch (e) {
      lastErr = e;
      // try the next, safer candidate prompt
    }
  }
  if (lastErr) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  return false;
}
