import OpenAI from "openai";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { llmProviderPreference } from "./runProfile.js";
import { postJsonWithCurl } from "./curlHttp.js";

/**
 * LLM client with two-tier provider chain:
 *
 *   1. **GX10** (primary)  — local qwen3.x deployment, OpenAI-compatible
 *      Env: GX10_OPENAI_BASE_URL · GX10_OPENAI_API_KEY · GX10_MODEL_NAME
 *           GX10_THINKING_EFFORT (default "low")
 *
 *   2. **Azure OpenAI** (fallback) — OpenAI-compatible /openai/v1 surface
 *      Env: AZURE_OPENAI_ENDPOINT · AZURE_OPENAI_KEY · azure_openai_chat_model
 *
 * `isLLMAvailable()` returns true if either tier is configured, so phases
 * keep their "can run without LLM" deterministic-template fallback.
 *
 * The GX10 path goes through the OpenAI SDK with `thinking_effort` injected
 * as an extra body field (Qwen-family reasoning models). When `thinking_effort`
 * is "low"/"medium"/"high" the server emits a non-empty `reasoning` field in
 * the message — we always read `content` (not `reasoning`).
 */

interface Provider {
  name: "gx10" | "azure";
  client?: OpenAI;
  model: string;
  extra?: Record<string, unknown>;
  azure?: AzureProviderConfig;
}

interface AzureProviderConfig {
  endpoint: string;
  apiKey: string;
  apiVersion: string;
  mode: "v1" | "deployment";
}

let _providers: Provider[] | null = null;

function buildProviders(): Provider[] {
  const gx10: Provider[] = [];
  const azure: Provider[] = [];

  // GX10 — primary
  if (process.env.GX10_OPENAI_BASE_URL && process.env.GX10_OPENAI_API_KEY && process.env.GX10_MODEL_NAME) {
    const thinkingEffort = (process.env.GX10_THINKING_EFFORT ?? "low").toLowerCase();
    gx10.push({
      name: "gx10",
      client: new OpenAI({
        baseURL: process.env.GX10_OPENAI_BASE_URL,
        apiKey:  process.env.GX10_OPENAI_API_KEY,
      }),
      model: process.env.GX10_MODEL_NAME,
      extra: { thinking_effort: thinkingEffort },
    });
  }

  // Azure OpenAI — fallback
  const azureRoot = azureEndpoint();
  const azureKey = azureApiKey();
  const azureModel = azureChatModel();
  if (azureRoot && azureKey && azureModel) {
    const mode = /\/openai\/v1$/i.test(azureRoot) ? "v1" : "deployment";
    azure.push({
      name: "azure",
      client: mode === "v1"
        ? new OpenAI({
            baseURL: azureRoot,
            apiKey: azureKey,
            defaultHeaders: { "api-key": azureKey },
          })
        : undefined,
      model: azureModel,
      azure: {
        endpoint: azureRoot,
        apiKey: azureKey,
        apiVersion: azureApiVersion(),
        mode,
      },
    });
  }

  const pref = llmProviderPreference();
  if (pref === "gx10") return [...gx10, ...azure];
  if (pref === "auto") return [...gx10, ...azure];
  return [...azure, ...gx10];
}

function getProviders(): Provider[] {
  if (_providers) return _providers;
  _providers = buildProviders();
  return _providers;
}

function azureEndpoint(): string | undefined {
  const raw = process.env.AZURE_OPENAI_ENDPOINT?.trim();
  if (!raw) return undefined;
  return raw.replace(/\/+$/, "");
}

function azureApiKey(): string | undefined {
  return process.env.AZURE_OPENAI_KEY?.trim()
    || process.env.AZURE_OPENAI_API_KEY?.trim()
    || undefined;
}

function azureChatModel(): string | undefined {
  return process.env.azure_openai_chat_model?.trim()
    || process.env.AZURE_OPENAI_CHAT_MODEL?.trim()
    || process.env.AZURE_OPENAI_DEPLOYMENT?.trim()
    || undefined;
}

function azureApiVersion(): string {
  return process.env.AZURE_OPENAI_API_VERSION?.trim() || "2025-04-01-preview";
}

export function isLLMAvailable(): boolean {
  return getProviders().length > 0;
}

export interface ChatJsonOpts {
  systemPrompt: string;
  userPrompt: string;
  /** Soft cap for response. Default 1600. */
  maxTokens?: number;
  /** 0..2 temperature; default 0.7 (we want lively, not deterministic). */
  temperature?: number;
  /** Max retry attempts on transient errors per provider. Default 2. */
  retries?: number;
  /** Force a specific model name (e.g. for the active provider). */
  model?: string;
  /**
   * Hard per-request timeout in ms. When omitted, a provider default applies
   * (Azure: HARNESS_LLM_TIMEOUT_MS or 120s; GX10: GX10_LLM_TIMEOUT_MS or 300s).
   * This is the guard that keeps a slow/hung reasoning model (e.g. the GX10 35B)
   * from stalling WRITE forever — on timeout the call aborts and the caller
   * falls back to its deterministic generator.
   */
  timeoutMs?: number;
}

/**
 * Resolve the hard per-request timeout for a provider. GX10 reasoning models
 * need more head-room (hidden chain-of-thought) than the Azure flash model.
 */
function providerTimeoutMs(p: Provider, opts: ChatJsonOpts): number {
  if (opts.timeoutMs && opts.timeoutMs > 0) return opts.timeoutMs;
  if (p.name === "gx10") return intEnv("GX10_LLM_TIMEOUT_MS", 300_000, 10_000, 1_800_000);
  return intEnv("HARNESS_LLM_TIMEOUT_MS", 120_000, 5_000, 1_800_000);
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export interface ChatImage {
  /** Absolute or relative image path. */
  path: string;
  /** MIME type, defaults to image/jpeg. */
  mimeType?: "image/jpeg" | "image/png" | "image/webp";
}

export interface ChatJsonWithImagesOpts extends ChatJsonOpts {
  images: ChatImage[];
}

/**
 * Call Chat Completions with JSON-object response_format and parse the result.
 * Tries each configured provider in order (GX10 → Azure). Throws on persistent
 * failure across all providers; caller is expected to fall back gracefully.
 */
export async function chatJson<T = unknown>(opts: ChatJsonOpts): Promise<T> {
  const providers = getProviders();
  if (providers.length === 0) throw new Error("No LLM provider configured (GX10_* or AZURE_OPENAI_*)");
  const retries = opts.retries ?? 2;

  let lastErr: unknown = null;
  for (const p of providers) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const cached = await readLLMCache(p, opts, false);
        if (cached) return JSON.parse(cached) as T;
        const text = await callProvider(p, opts);
        if (!text) throw new Error(`${p.name}: empty content`);
        const clean = stripCodeFences(text);
        const parsed = JSON.parse(clean) as T;
        await writeLLMCache(p, opts, false, clean);
        return parsed;
      } catch (e: any) {
        lastErr = e;
        const msg = String(e?.message ?? e);
        const status = e?.status ?? e?.response?.status;
        // 4xx (non-rate-limit) — skip remaining retries on this provider
        const fatal = status && status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (process.env.HARNESS_DBG) {
          console.error(`[llm] ${p.name} attempt ${attempt + 1}/${retries + 1} failed: ${msg}${fatal ? " (fatal, skipping retries)" : ""}`);
        }
        if (fatal) break;
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
          continue;
        }
      }
    }
    if (process.env.HARNESS_DBG) console.error(`[llm] provider ${p.name} exhausted; trying next`);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export async function chatJsonWithImages<T = unknown>(opts: ChatJsonWithImagesOpts): Promise<T> {
  const providers = getProviders();
  if (providers.length === 0) throw new Error("No LLM provider configured (GX10_* or AZURE_OPENAI_*)");
  const retries = opts.retries ?? 1;

  let lastErr: unknown = null;
  for (const p of providers) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const cached = await readLLMCache(p, opts, true);
        if (cached) return JSON.parse(cached) as T;
        const text = await callProviderWithImages(p, opts);
        if (!text) throw new Error(`${p.name}: empty content`);
        const clean = stripCodeFences(text);
        const parsed = JSON.parse(clean) as T;
        await writeLLMCache(p, opts, true, clean);
        return parsed;
      } catch (e: any) {
        lastErr = e;
        const status = e?.status ?? e?.response?.status;
        const fatal = status && status >= 400 && status < 500 && status !== 408 && status !== 429;
        if (process.env.HARNESS_DBG) {
          console.error(`[llm-image] ${p.name} attempt ${attempt + 1}/${retries + 1} failed: ${String(e?.message ?? e)}${fatal ? " (fatal, skipping retries)" : ""}`);
        }
        if (fatal) break;
        if (attempt < retries) {
          await new Promise(r => setTimeout(r, 500 * Math.pow(2, attempt)));
          continue;
        }
      }
    }
    if (process.env.HARNESS_DBG) console.error(`[llm-image] provider ${p.name} exhausted; trying next`);
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

async function callProvider(p: Provider, opts: ChatJsonOpts): Promise<string> {
  if (p.name === "azure" && p.azure?.mode === "deployment") {
    return callAzureDeployment(p, opts);
  }
  if (!p.client) throw new Error(`${p.name}: OpenAI client not configured`);
  const model = opts.model ?? p.model;
  // For reasoning-capable models with thinking_effort, the response budget
  // is shared with hidden chain-of-thought. Pad the budget so `content`
  // still fits after reasoning.
  const baseTokens = opts.maxTokens ?? 1600;
  const tokens = p.name === "gx10" ? Math.max(baseTokens, baseTokens * 2 + 400) : baseTokens;

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user",   content: opts.userPrompt },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: tokens,
    ...(shouldSetTemperature(model) ? { temperature: opts.temperature ?? 0.7 } : {}),
    ...(p.extra ?? {}),
  };

  const res = await p.client.chat.completions.create(body as any, {
    timeout: providerTimeoutMs(p, opts),
    maxRetries: 0,
  });
  return extractContent(res);
}

async function callProviderWithImages(p: Provider, opts: ChatJsonWithImagesOpts): Promise<string> {
  if (p.name === "azure" && p.azure?.mode === "deployment") {
    return callAzureDeploymentWithImages(p, opts);
  }
  if (!p.client) throw new Error(`${p.name}: OpenAI client not configured`);
  const model = opts.model ?? p.model;
  const baseTokens = opts.maxTokens ?? 1600;
  const tokens = p.name === "gx10" ? Math.max(baseTokens, baseTokens * 2 + 400) : baseTokens;
  const content: any[] = [{ type: "text", text: opts.userPrompt }];
  for (const img of opts.images) {
    const data = await imageDataUrl(img);
    content.push({ type: "image_url", image_url: { url: data } });
  }

  const body: Record<string, unknown> = {
    model,
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: tokens,
    ...(shouldSetTemperature(model) ? { temperature: opts.temperature ?? 0.2 } : {}),
    ...(p.extra ?? {}),
  };

  const res = await p.client.chat.completions.create(body as any, {
    timeout: providerTimeoutMs(p, opts),
    maxRetries: 0,
  });
  return extractContent(res);
}

async function callAzureDeployment(p: Provider, opts: ChatJsonOpts): Promise<string> {
  const body = chatBodyWithoutModel(p, opts);
  const res = await fetchAzureDeployment(p, opts.model ?? p.model, body, providerTimeoutMs(p, opts));
  return extractContent(res);
}

async function callAzureDeploymentWithImages(p: Provider, opts: ChatJsonWithImagesOpts): Promise<string> {
  const content: any[] = [{ type: "text", text: opts.userPrompt }];
  for (const img of opts.images) {
    const data = await imageDataUrl(img);
    content.push({ type: "image_url", image_url: { url: data } });
  }
  const body = chatBodyWithoutModel(p, opts, content);
  const res = await fetchAzureDeployment(p, opts.model ?? p.model, body, providerTimeoutMs(p, opts));
  return extractContent(res);
}

function chatBodyWithoutModel(
  p: Provider,
  opts: ChatJsonOpts,
  userContent: string | any[] = opts.userPrompt,
): Record<string, unknown> {
  const model = opts.model ?? p.model;
  const body: Record<string, unknown> = {
    messages: [
      { role: "system", content: opts.systemPrompt },
      { role: "user", content: userContent },
    ],
    response_format: { type: "json_object" },
    max_completion_tokens: opts.maxTokens ?? 1600,
    ...(shouldSetTemperature(model) ? { temperature: opts.temperature ?? 0.7 } : {}),
  };
  return body;
}

async function fetchAzureDeployment(
  p: Provider,
  deployment: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<any> {
  const azure = p.azure;
  if (!azure) throw new Error("azure: provider config missing");
  const url = `${azure.endpoint}/openai/deployments/${encodeURIComponent(deployment)}/chat/completions?api-version=${encodeURIComponent(azure.apiVersion)}`;
  const text = await postJsonWithCurl(url, {
    "Content-Type": "application/json",
    "api-key": azure.apiKey,
  }, body, timeoutMs);
  return JSON.parse(text);
}

async function imageDataUrl(img: ChatImage): Promise<string> {
  const fs = await import("node:fs/promises");
  const buf = await fs.readFile(img.path);
  const mime = img.mimeType ?? "image/jpeg";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

function shouldSetTemperature(model: string): boolean {
  // GPT-5 reasoning models only support default temperature=1.
  return !/^gpt-5/i.test(model);
}

/**
 * Pull the assistant text out of a chat completion. Reasoning models (the GX10
 * 35B family) expose hidden chain-of-thought in a separate `reasoning` /
 * `reasoning_content` field and put the answer in `content` — but some builds
 * still leak a `<think>…</think>` block into `content`. Strip it defensively so
 * the downstream JSON.parse sees only the answer.
 */
function extractContent(res: any): string {
  const msg = res?.choices?.[0]?.message ?? {};
  let text = String(msg.content ?? "");
  // Drop any leading reasoning block.
  text = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
  text = text.replace(/^[\s\S]*?<\/think>/i, "");
  return text.trim();
}

/**
 * Some models wrap JSON output in markdown fences (```json ... ```). Even
 * with response_format=json_object set, we've seen this on rare occasions.
 * Strip them defensively before JSON.parse.
 */
function stripCodeFences(text: string): string {
  const t = text.trim();
  if (t.startsWith("```")) {
    return t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  }
  return t;
}

/** Diagnostic helper for the post-phase manifest. */
export function activeLLMProvider(): "gx10" | "azure" | "none" {
  const ps = getProviders();
  return ps[0]?.name ?? "none";
}

async function readLLMCache(p: Provider, opts: ChatJsonOpts | ChatJsonWithImagesOpts, withImages: boolean): Promise<string | null> {
  if (process.env.HARNESS_LLM_CACHE === "0") return null;
  try {
    const file = await llmCachePath(p, opts, withImages);
    return await fs.readFile(file, "utf8");
  } catch {
    return null;
  }
}

async function writeLLMCache(p: Provider, opts: ChatJsonOpts | ChatJsonWithImagesOpts, withImages: boolean, text: string): Promise<void> {
  if (process.env.HARNESS_LLM_CACHE === "0") return;
  try {
    const file = await llmCachePath(p, opts, withImages);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text, "utf8");
  } catch {}
}

async function llmCachePath(p: Provider, opts: ChatJsonOpts | ChatJsonWithImagesOpts, withImages: boolean): Promise<string> {
  const root = process.env.HARNESS_WORK_DIR ?? "out";
  const imageHashes = withImages && "images" in opts
    ? await Promise.all(opts.images.map(async img => {
      try {
        const buf = await fs.readFile(img.path);
        return crypto.createHash("sha256").update(buf).digest("hex");
      } catch {
        return img.path;
      }
    }))
    : [];
  const key = crypto.createHash("sha256").update(JSON.stringify({
    provider: p.name,
    endpoint: p.name === "gx10" ? process.env.GX10_OPENAI_BASE_URL : azureEndpoint(),
    model: opts.model ?? p.model,
    extra: p.extra ?? null,
    systemPrompt: opts.systemPrompt,
    userPrompt: opts.userPrompt,
    maxTokens: opts.maxTokens ?? 1600,
    temperature: opts.temperature ?? (withImages ? 0.2 : 0.7),
    withImages,
    imageHashes,
  })).digest("hex");
  return path.join(root, "_cache", "llm", `${key}.json`);
}
