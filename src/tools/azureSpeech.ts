import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { lineToSsml, VOICE, type SpeakerName } from "./ssml.js";
import { ttsProviderPreference } from "./runProfile.js";

/**
 * TTS client provider chain:
 *
 *   1. **Qwen3 TTS** (primary) — local Qwen3-TTS service. Named voices via the
 *      native /v1/tts (text/speaker/language/instruct) and 3-second voice
 *      cloning via /v1/voice_clone (Base model). Env: QWEN_TTS_BASE_URL ·
 *      QWEN_TTS_CLONE_URL · QWEN_TTS_API_KEY · QWEN_TTS_VOICE_* ·
 *      QWEN_TTS_INSTRUCT_* · QWEN_TTS_CLONE_REF_* · QWEN_TTS_SEED[_ROLE]
 *      (fixed by default so a role's voice/style stays consistent across
 *      every segment) · QWEN_TTS_{TEMPERATURE,TOP_P,TOP_K}[_ROLE].
 *
 *   2. **Azure Speech** (fallback) — SSML neural TTS with real word boundaries.
 *      Env: AZURE_SPEECH_KEY · AZURE_SPEECH_REGION.
 *
 *   3. **Stub** (last resort) — sine wave. Keeps the pipeline runnable offline
 *      with no cloud credentials.
 *
 * Cache keys are scoped by `(provider, voice, ssml, text, styleKey)` — the
 * styleKey folds in the qwen instruct + sampling (seed/temperature) so any
 * backend, voice, or style change invalidates the cache automatically.
 */

export type TTSProvider = "qwen" | "azure" | "stub";

export interface SynthResult {
  wavPath: string;
  durSec: number;
  boundaries: { text: string; offsetMs: number; durMs: number }[];
  cacheHit: boolean;
  voice: string;
  stub: boolean;
  /** Which backend actually produced the audio. */
  provider: TTSProvider;
}

export interface SynthRequest {
  ssml: string;
  voice: string;            // Azure neural voice name (e.g. zh-CN-XiaoxiaoNeural)
  text: string;             // plain text — used for stub boundaries
  speaker?: SpeakerName;    // host hint
  outPath: string;
}

const SAMPLE_RATE = 24000;
const CHANNELS = 1;
const BITS = 16;
const CPS = 4.2;

function hasAzure(): boolean {
  return Boolean(process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION);
}

// --------------------------- Qwen3-TTS config --------------------------------

/** Reference describing the cloned voice used for a speaker. */
interface QwenCloneRef {
  /** `data:audio/wav;base64,...` URI (inline) or a server-visible path/URL. */
  refAudio: string;
  /** Optional transcript of the reference (enables higher-fidelity ICL mode). */
  refText?: string;
  /** speaker-embedding only (no transcript needed) vs ICL. */
  xVectorOnly: boolean;
  /** Stable short id of this reference for cache-keying / labelling. */
  label: string;
}

/** Native /v1/tts endpoint for named-voice synthesis (null disables). */
function qwenTtsUrl(): string | null {
  const raw = process.env.QWEN_TTS_BASE_URL;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const base = trimmed.replace(/\/+$/, "");
  return /\/(tts|audio\/speech)$/.test(base) ? base : `${base}/tts`;
}

/** /v1/voice_clone endpoint of the Base service (null disables cloning). */
function qwenCloneUrl(): string | null {
  const raw = process.env.QWEN_TTS_CLONE_URL ?? process.env.QWEN_TTS_BASE_URL;
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const base = trimmed.replace(/\/+$/, "").replace(/\/(tts|audio\/speech)$/, "");
  return /\/voice_clone$/.test(base) ? base : `${base}/voice_clone`;
}

function hasQwen(): boolean {
  return qwenTtsUrl() !== null || qwenCloneUrl() !== null;
}

function qwenApiKey(): string | undefined {
  return process.env.QWEN_TTS_API_KEY?.trim()
    || process.env.API_KEY?.trim();
}

function qwenLanguage(): string {
  return process.env.QWEN_TTS_LANGUAGE?.trim() || "Chinese";
}

/** Named Qwen3-TTS speaker for a role (lower-cased roster name). */
function qwenVoice(speaker?: SpeakerName): string {
  if (speaker === "Analyst") {
    return process.env.QWEN_TTS_VOICE_MALE?.trim() || "Dylan";
  }
  if (speaker === "Narrator") {
    return process.env.QWEN_TTS_VOICE_NARRATOR?.trim()
      || process.env.QWEN_TTS_VOICE_MALE?.trim()
      || "Uncle_Fu";
  }
  return process.env.QWEN_TTS_VOICE_FEMALE?.trim() || "Vivian";
}

/** Optional natural-language style control for a role. */
function qwenInstruct(speaker?: SpeakerName): string | undefined {
  if (speaker === "Analyst") {
    return process.env.QWEN_TTS_INSTRUCT_MALE?.trim() || undefined;
  }
  if (speaker === "Narrator") {
    return process.env.QWEN_TTS_INSTRUCT_NARRATOR?.trim()
      || process.env.QWEN_TTS_INSTRUCT_MALE?.trim() || undefined;
  }
  return process.env.QWEN_TTS_INSTRUCT_FEMALE?.trim() || undefined;
}

/**
 * Sampling controls sent to the Qwen3-TTS server.
 *
 * Qwen3-TTS is a *generative* model: with no `seed` it draws an independent
 * random "take" for every request, so the same line can vary wildly in pacing,
 * timbre and emotion between segments (measured ≈57% length swing on identical
 * text; the "活泼/lively" female voice drifts about twice as much as the steadier
 * male). Pinning a **fixed seed** anchors that sampling, so every segment of a
 * role renders with the same voice character and delivery style — which is what
 * keeps a multi-segment podcast sounding like one consistent host.
 *
 * The seed defaults ON (fixed) so consistency needs no configuration. Opt out
 * per role or globally with `QWEN_TTS_SEED[_ROLE]=off` (or `random` / `-1`).
 * `temperature` / `top_p` / `top_k` stay unset unless explicitly configured.
 */
interface QwenSampling {
  seed?: number;
  temperature?: number;
  top_p?: number;
  top_k?: number;
}

/** Default fixed seed — keeps every segment's voice/style consistent. */
const DEFAULT_QWEN_SEED = 7;

function roleSuffix(speaker?: SpeakerName): "MALE" | "FEMALE" | "NARRATOR" {
  if (speaker === "Analyst") return "MALE";
  if (speaker === "Narrator") return "NARRATOR";
  return "FEMALE";
}

/** First finite number found among env vars, else undefined. */
function envNum(...names: string[]): number | undefined {
  for (const n of names) {
    const raw = process.env[n];
    if (raw === undefined) continue;
    const t = raw.trim();
    if (!t) continue;
    const v = Number(t);
    if (Number.isFinite(v)) return v;
  }
  return undefined;
}

function qwenSampling(speaker?: SpeakerName): QwenSampling {
  const role = roleSuffix(speaker);
  const seedRaw = process.env[`QWEN_TTS_SEED_${role}`]?.trim()
    ?? process.env.QWEN_TTS_SEED?.trim();
  let seed: number | undefined;
  if (seedRaw === undefined) {
    seed = DEFAULT_QWEN_SEED;                       // default: consistency ON
  } else if (/^(off|none|random|-1)$/i.test(seedRaw)) {
    seed = undefined;                               // explicit opt-out
  } else {
    const v = Number(seedRaw);
    seed = Number.isFinite(v) ? Math.trunc(v) : DEFAULT_QWEN_SEED;
  }
  const temperature = envNum(`QWEN_TTS_TEMPERATURE_${role}`, "QWEN_TTS_TEMPERATURE");
  const topP = envNum(`QWEN_TTS_TOP_P_${role}`, "QWEN_TTS_TOP_P");
  const topKRaw = envNum(`QWEN_TTS_TOP_K_${role}`, "QWEN_TTS_TOP_K");
  const out: QwenSampling = {};
  if (seed !== undefined) out.seed = seed;
  if (temperature !== undefined) out.temperature = temperature;
  if (topP !== undefined) out.top_p = topP;
  if (topKRaw !== undefined) out.top_k = Math.trunc(topKRaw);
  return out;
}

/** Stable cache-key fragment for the qwen style (instruct + sampling). */
function qwenStyleKey(speaker: SpeakerName | undefined, extra: Record<string, unknown>): string {
  return JSON.stringify({ instruct: qwenInstruct(speaker) ?? "", ...qwenSampling(speaker), ...extra });
}

const _refUriCache = new Map<string, string>();

/** Read a local wav and memoise it as a base64 data URI. */
function refAudioUri(refPath: string): string {
  const cached = _refUriCache.get(refPath);
  if (cached) return cached;
  const expanded = refPath.startsWith("~/")
    ? path.join(process.env.HOME || "", refPath.slice(2))
    : refPath;
  // A server-visible container path or URL is passed through untouched.
  if (/^https?:\/\//.test(refPath) || refPath.startsWith("/refs/") || refPath.startsWith("data:")) {
    _refUriCache.set(refPath, refPath);
    return refPath;
  }
  const b64 = readFileSync(expanded).toString("base64");
  const uri = `data:audio/wav;base64,${b64}`;
  _refUriCache.set(refPath, uri);
  return uri;
}

/** Clone reference configured for a role, or null to use the named voice. */
function qwenCloneRef(speaker?: SpeakerName): QwenCloneRef | null {
  const pick = (...names: string[]): string | undefined => {
    for (const n of names) { const v = process.env[n]?.trim(); if (v) return v; }
    return undefined;
  };
  let refPath: string | undefined;
  let refText: string | undefined;
  if (speaker === "Analyst") {
    refPath = pick("QWEN_TTS_CLONE_REF_MALE", "QWEN_TTS_CLONE_REF");
    refText = pick("QWEN_TTS_CLONE_REF_TEXT_MALE", "QWEN_TTS_CLONE_REF_TEXT");
  } else if (speaker === "Narrator") {
    refPath = pick("QWEN_TTS_CLONE_REF_NARRATOR", "QWEN_TTS_CLONE_REF");
    refText = pick("QWEN_TTS_CLONE_REF_TEXT_NARRATOR", "QWEN_TTS_CLONE_REF_TEXT");
  } else {
    refPath = pick("QWEN_TTS_CLONE_REF_FEMALE", "QWEN_TTS_CLONE_REF");
    refText = pick("QWEN_TTS_CLONE_REF_TEXT_FEMALE", "QWEN_TTS_CLONE_REF_TEXT");
  }
  if (!refPath) return null;
  const xVectorOnly = !(refText && refText.trim());
  const label = "clone:" + crypto.createHash("sha256")
    .update(refPath + "\u241f" + (refText ?? "") + "\u241f" + (xVectorOnly ? "x" : "i"))
    .digest("hex").slice(0, 12);
  return { refAudio: refAudioUri(refPath), refText, xVectorOnly, label };
}

/** Label of the voice a role will actually be heard in (named or clone id). */
function qwenVoiceLabel(speaker?: SpeakerName): string {
  const clone = qwenCloneRef(speaker);
  return clone ? clone.label : qwenVoice(speaker);
}

function qwenRetries(): number {
  const n = Number(process.env.QWEN_TTS_RETRIES);
  return Number.isFinite(n) && n >= 0 ? n : 2;
}

/** Exposed so the post phase can label the audio backend correctly. */
export function activeTTSProvider(): TTSProvider {
  const pref = ttsProviderPreference();
  if (pref === "azure") return hasAzure() ? "azure" : "stub";
  // qwen / auto: local Qwen first, then Azure, then stub.
  if (hasQwen()) return "qwen";
  return hasAzure() ? "azure" : "stub";
}

/**
 * The actual host voices for a given backend. Qwen uses Qwen3-TTS voices
 * (Vivian/Dylan, or a `clone:*` id when cloning), while Azure/stub use the
 * Azure neural `VOICE` map. The TTS phase records this in the manifest so
 * downstream metadata reflects the voices the audience actually hears.
 */
export function voicesForProvider(provider: TTSProvider): { Anchor: string; Analyst: string; Narrator: string } {
  if (provider === "qwen") {
    return { Anchor: qwenVoiceLabel("Anchor"), Analyst: qwenVoiceLabel("Analyst"), Narrator: qwenVoiceLabel("Narrator") };
  }
  return { Anchor: VOICE.Anchor, Analyst: VOICE.Analyst, Narrator: VOICE.Narrator };
}

async function withRetry<T>(label: string, attempts: number, fn: () => Promise<T>, baseDelayMs = 0): Promise<T> {
  let lastErr: unknown = null;
  for (let i = 0; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      lastErr = e;
      if (process.env.HARNESS_DBG) console.error(`[tts] ${label} attempt ${i + 1}/${attempts + 1} failed: ${e?.message ?? e}`);
      if (i < attempts && baseDelayMs > 0) {
        // Exponential backoff with jitter — neural TTS throttling (429) needs a pause.
        const wait = baseDelayMs * Math.pow(2, i) + Math.floor(Math.random() * 250);
        await new Promise(r => setTimeout(r, wait));
      }
    }
  }
  throw lastErr;
}

/** Azure Speech retry budget (transient throttle / 5xx). Default 3 → 4 attempts. */
function azureRetries(): number {
  const n = Number(process.env.AZURE_TTS_RETRIES);
  return Number.isFinite(n) && n >= 0 ? n : 3;
}

export async function synthLine(req: SynthRequest, cacheDir: string): Promise<SynthResult> {
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(path.dirname(req.outPath), { recursive: true });
  const candidates = providerCandidates(req);
  let lastErr: unknown = null;

  for (const candidate of candidates) {
    const cached = await tryReadCache(candidate, req, cacheDir);
    if (cached) return cached;

    try {
      const result = await candidate.synth();
      if (!(await isValidWav(result.wavPath))) {
        throw new Error(`${candidate.provider} produced an invalid wav`);
      }
      await writeCache(candidate, req, cacheDir, result);
      return { ...result, cacheHit: false };
    } catch (e: any) {
      lastErr = e;
      if (process.env.HARNESS_DBG) console.error(`[tts] ${candidate.provider} synth failed: ${e?.message ?? e}`);
    }
  }

  if (lastErr && process.env.HARNESS_DBG) {
    console.error(`[tts] all configured providers failed. Last error: ${String((lastErr as any)?.message ?? lastErr)}`);
  }
  const result = await stubSynth(req);
  await writeCache({ provider: "stub", voice: req.voice, synth: () => stubSynth(req) }, req, cacheDir, result);
  return { ...result, cacheHit: false };
}

type ProviderCandidate = {
  provider: TTSProvider;
  voice: string;
  /** Extra cache-key material for style that isn't captured by voice/text
   *  (qwen instruct + seed/temperature); empty for azure/stub. */
  styleKey?: string;
  synth: () => Promise<Omit<SynthResult, "cacheHit">>;
};

function providerCandidates(req: SynthRequest): ProviderCandidate[] {
  const pref = ttsProviderPreference();
  const out: ProviderCandidate[] = [];
  const addQwen = () => {
    const clone = qwenCloneRef(req.speaker);
    if (clone) {
      const cloneUrl = qwenCloneUrl();
      if (cloneUrl) {
        out.push({ provider: "qwen", voice: clone.label, styleKey: qwenStyleKey(req.speaker, { clone: clone.label }), synth: () => withRetry("qwen-clone", qwenRetries(), () => qwenCloneSynth(req, cloneUrl, clone)) });
        return;
      }
    }
    const ttsUrl = qwenTtsUrl();
    if (ttsUrl) {
      const voice = qwenVoice(req.speaker);
      out.push({ provider: "qwen", voice, styleKey: qwenStyleKey(req.speaker, {}), synth: () => withRetry("qwen", qwenRetries(), () => qwenSynth(req, ttsUrl, voice)) });
    }
  };
  const addAzure = () => {
    if (!hasAzure()) return;
    out.push({
      provider: "azure",
      voice: req.voice,
      synth: () => withRetry("azure", azureRetries(), () => azureSynth(req, process.env.AZURE_SPEECH_KEY!, process.env.AZURE_SPEECH_REGION!), 400),
    });
  };
  if (pref === "azure") {
    addAzure();
  } else {
    // qwen / auto: local Qwen first, then Azure.
    addQwen();
    addAzure();
  }
  // Stub is always the final safety net so offline runs still produce audio.
  out.push({ provider: "stub", voice: req.voice, synth: () => stubSynth(req) });
  return out;
}

async function tryReadCache(candidate: ProviderCandidate, req: SynthRequest, cacheDir: string): Promise<SynthResult | null> {
  const { cachedWav, cachedMeta } = cachePaths(cacheDir, candidate.provider, candidate.voice, req.ssml, req.text, candidate.styleKey);
  // Cache hit — but only trust a cached wav that is a structurally valid RIFF
  // file. Interrupted prior runs can leave truncated/headerless wavs in the
  // cache that mux as pure silence. Treat those as misses.
  try {
    const meta = JSON.parse(await fs.readFile(cachedMeta, "utf8"));
    if (await isValidWav(cachedWav)) {
      await fs.copyFile(cachedWav, req.outPath);
      return {
        wavPath: req.outPath,
        durSec: meta.durSec,
        boundaries: meta.boundaries,
        cacheHit: true,
        voice: meta.voice ?? candidate.voice,
        stub: !!meta.stub,
        provider: meta.provider ?? candidate.provider,
      };
    }
    if (process.env.HARNESS_DBG) console.error(`[tts] ignoring corrupt cached wav: ${cachedWav}`);
  } catch {}
  return null;
}

async function writeCache(candidate: ProviderCandidate, req: SynthRequest, cacheDir: string, result: Omit<SynthResult, "cacheHit">): Promise<void> {
  const { cachedWav, cachedMeta } = cachePaths(cacheDir, candidate.provider, candidate.voice, req.ssml, req.text, candidate.styleKey);
  await fs.copyFile(result.wavPath, cachedWav);
  await fs.writeFile(cachedMeta, JSON.stringify({
    durSec: result.durSec,
    boundaries: result.boundaries,
    voice: result.voice,
    stub: result.stub,
    provider: result.provider,
  }, null, 2));
}

function cachePaths(cacheDir: string, provider: TTSProvider, voice: string, ssml: string, text: string, styleKey = ""): { cachedWav: string; cachedMeta: string } {
  const key = crypto.createHash("sha256")
    .update(provider + "\u241f" + voice + "\u241f" + ssml + "\u241f" + text + (styleKey ? "\u241f" + styleKey : ""))
    .digest("hex").slice(0, 32);
  return {
    cachedWav: path.join(cacheDir, `${key}.wav`),
    cachedMeta: path.join(cacheDir, `${key}.json`),
  };
}

function uniformBoundaries(text: string, durSec: number): { text: string; offsetMs: number; durMs: number }[] {
  const chars = [...text].filter(c => /[\u4e00-\u9fffA-Za-z0-9]/.test(c));
  if (chars.length === 0 || !Number.isFinite(durSec) || durSec <= 0) return [];
  const step = (durSec * 1000) / chars.length;
  return chars.map((c, i) => ({
    text: c,
    offsetMs: Math.round(i * step),
    durMs: Math.round(step),
  }));
}

// --------------------------- Hosted provider paths ---------------------------

async function qwenPostWav(url: string, body: unknown, label: string): Promise<Buffer> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = qwenApiKey();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const timeoutMs = Number(process.env.QWEN_TTS_TIMEOUT_MS || 180_000);
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`${label} error ${res.status}: ${detail.slice(0, 300)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

async function qwenSynth(req: SynthRequest, ttsUrl: string, voice: string): Promise<Omit<SynthResult, "cacheHit">> {
  const instruct = qwenInstruct(req.speaker);
  const wav = await qwenPostWav(ttsUrl, {
    text: req.text,
    speaker: voice,
    language: qwenLanguage(),
    ...(instruct ? { instruct } : {}),
    ...qwenSampling(req.speaker),
    format: "wav",
  }, "Qwen TTS");
  await fs.writeFile(req.outPath, wav);
  const durSec = await wavDurationSec(req.outPath);
  if (!Number.isFinite(durSec) || durSec <= 0) throw new Error("Qwen TTS returned an unreadable wav");
  return { wavPath: req.outPath, durSec, boundaries: uniformBoundaries(req.text, durSec), voice, stub: false, provider: "qwen" };
}

async function qwenCloneSynth(req: SynthRequest, cloneUrl: string, ref: QwenCloneRef): Promise<Omit<SynthResult, "cacheHit">> {
  const wav = await qwenPostWav(cloneUrl, {
    text: req.text,
    ref_audio: ref.refAudio,
    ...(ref.refText ? { ref_text: ref.refText } : {}),
    x_vector_only_mode: ref.xVectorOnly,
    language: qwenLanguage(),
    ...qwenSampling(req.speaker),
    format: "wav",
  }, "Qwen voice_clone");
  await fs.writeFile(req.outPath, wav);
  const durSec = await wavDurationSec(req.outPath);
  if (!Number.isFinite(durSec) || durSec <= 0) throw new Error("Qwen voice_clone returned an unreadable wav");
  return { wavPath: req.outPath, durSec, boundaries: uniformBoundaries(req.text, durSec), voice: ref.label, stub: false, provider: "qwen" };
}

async function azureSynth(req: SynthRequest, key: string, region: string): Promise<Omit<SynthResult, "cacheHit">> {
  // Lazy import to avoid loading the SDK when running stub-only.
  const sdk = await import("microsoft-cognitiveservices-speech-sdk");
  const cfg = sdk.SpeechConfig.fromSubscription(key, region);
  cfg.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm;
  const audioCfg = sdk.AudioConfig.fromAudioFileOutput(req.outPath);
  const synth = new sdk.SpeechSynthesizer(cfg, audioCfg);

  const azureSsml = req.ssml;
  const azureVoice = req.voice;

  const boundaries: { text: string; offsetMs: number; durMs: number }[] = [];
  synth.wordBoundary = (_s, e) => {
    boundaries.push({
      text: e.text,
      offsetMs: Number(e.audioOffset) / 10_000,
      durMs: Number(e.duration) / 10_000,
    });
  };

  return new Promise((resolve, reject) => {
    synth.speakSsmlAsync(azureSsml,
      (r) => {
        synth.close();
        if (r.errorDetails) {
          return reject(new Error(`Azure TTS error: ${r.errorDetails}`));
        }
        const durSec = Number(r.audioDuration) / 10_000_000;
        resolve({
          wavPath: req.outPath,
          durSec,
          boundaries,
          voice: azureVoice,
          stub: false,
          provider: "azure",
        });
      },
      (err) => { synth.close(); reject(err); });
  });
}

// --------------------------- Stub path --------------------------------------

async function stubSynth(req: SynthRequest): Promise<Omit<SynthResult, "cacheHit">> {
  // Generate a low-amplitude tone at ~220Hz, duration matched to estimated speech length.
  const durSec = estimateDuration(req.text);
  const numSamples = Math.round(durSec * SAMPLE_RATE);
  const wav = makeSineWav(numSamples, 220, 0.05);
  await fs.writeFile(req.outPath, wav);
  const boundaries = uniformBoundaries(req.text, durSec);
  return {
    wavPath: req.outPath,
    durSec,
    boundaries,
    voice: req.voice,
    stub: true,
    provider: "stub",
  };
}

function estimateDuration(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) n += 1;
    else if (/[A-Za-z0-9]/.test(ch)) n += 0.5;
  }
  return Math.max(0.5, Math.round((n / CPS) * 100) / 100);
}

// --------------------------- WAV writer --------------------------------------

function makeSineWav(numSamples: number, hz: number, amp: number): Buffer {
  const byteRate = SAMPLE_RATE * CHANNELS * (BITS / 8);
  const dataLen = numSamples * CHANNELS * (BITS / 8);
  const buf = Buffer.alloc(44 + dataLen);

  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(CHANNELS, 22);
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(CHANNELS * (BITS / 8), 32);
  buf.writeUInt16LE(BITS, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataLen, 40);

  const peak = Math.round(amp * 32767);
  for (let i = 0; i < numSamples; i++) {
    const sample = Math.round(Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE) * peak);
    buf.writeInt16LE(sample, 44 + i * 2);
  }
  return buf;
}

/**
 * Read a WAV file's duration from header bytes (no ffmpeg dep).
 * Returns seconds (float). Returns NaN if not a valid PCM WAV.
 */
export async function wavDurationSec(file: string): Promise<number> {
  const fh = await fs.open(file, "r");
  try {
    const header = Buffer.alloc(44);
    await fh.read(header, 0, 44, 0);
    const riff = header.subarray(0, 4).toString("ascii");
    const wave = header.subarray(8, 12).toString("ascii");
    if (riff !== "RIFF" || wave !== "WAVE") return NaN;
    const sampleRate = header.readUInt32LE(24);
    const byteRate = header.readUInt32LE(28);
    const dataLen = header.readUInt32LE(40);
    if (!byteRate || !sampleRate) return NaN;
    return dataLen / byteRate;
  } finally {
    await fh.close();
  }
}

export { lineToSsml };

/**
 * Structural validity check for a synthesised wav. Verifies the RIFF/WAVE
 * envelope and a non-trivial data chunk so truncated/headerless files (which
 * mux to pure silence) are rejected before they reach the cache or the mixer.
 */
async function isValidWav(file: string): Promise<boolean> {
  let fh: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    const st = await fs.stat(file);
    if (st.size < 64) return false;
    fh = await fs.open(file, "r");
    const header = Buffer.alloc(44);
    await fh.read(header, 0, 44, 0);
    if (header.subarray(0, 4).toString("ascii") !== "RIFF") return false;
    if (header.subarray(8, 12).toString("ascii") !== "WAVE") return false;
    const byteRate = header.readUInt32LE(28);
    const dataLen = header.readUInt32LE(40);
    if (!byteRate) return false;
    // Require at least ~50ms of audio payload.
    if (dataLen < byteRate * 0.05) return false;
    return true;
  } catch {
    return false;
  } finally {
    if (fh) await fh.close();
  }
}
