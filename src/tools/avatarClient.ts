/**
 * Client for the LongCat-Video-Avatar service (FRONTEND_GUIDE.md).
 *
 * The service is async, single-job and GPU-bound: a ~3.7s/480p segment takes
 * ~10-12 min, and while a job runs it temporarily stops the co-located qwen LLM
 * (the orchestrator "brain") to free VRAM, bringing it back when the queue
 * drains. The harness therefore treats avatar generation as a self-contained,
 * no-LLM phase and uses `waitForBrainOnline()` as a barrier before continuing.
 *
 * Enable by setting LONGCAT_AVATAR_BASE_URL (mirrors how image-gen is gated on
 * AZURE_OPENAI_IMAGE_DEPLOYMENT). When unset the avatar phase skips cleanly so
 * offline runs / tests never touch the network.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Base URL of the avatar service, or null when not configured. */
export function avatarBaseUrl(): string | null {
  const raw = process.env.LONGCAT_AVATAR_BASE_URL?.trim();
  return raw ? raw.replace(/\/+$/, "") : null;
}

/**
 * Avatar *generation* is enabled when the longcat service is configured and not
 * explicitly skipped. Only the out-of-band `avatar-prewarm` command needs this;
 * the pipeline never generates.
 */
export function isAvatarEnabled(): boolean {
  if (process.env.HARNESS_SKIP_AVATAR === "1") return false;
  return !!avatarBaseUrl();
}

/**
 * Avatar *cache consumption* (the pipeline path) is enabled whenever it is not
 * explicitly skipped. It deliberately does NOT require LONGCAT_AVATAR_BASE_URL:
 * the pipeline only reads committed library clips, so a machine with no longcat
 * access can still ship the presenter from `assets/avatar-clips/`.
 */
export function isAvatarCacheEnabled(): boolean {
  return process.env.HARNESS_SKIP_AVATAR !== "1";
}

function authHeaders(): Record<string, string> {
  const key = process.env.LONGCAT_API_KEY?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
}

export interface HealthStatus {
  ok: boolean;
  queued: number;
  running: number;
  qwen_active: boolean;
}

/** GET /healthz — returns null when unconfigured or unreachable. */
export async function avatarHealth(timeoutMs = 6000): Promise<HealthStatus | null> {
  const base = avatarBaseUrl();
  if (!base) return null;
  try {
    const res = await fetchWithTimeout(`${base}/healthz`, { headers: authHeaders() }, timeoutMs);
    if (!res.ok) return null;
    return (await res.json()) as HealthStatus;
  } catch {
    return null;
  }
}

export interface SubmitOpts {
  imagePath: string;
  audioPath: string;
  prompt?: string;
  stage?: string; // "ai2v" (default)
  resolution?: string; // "480p" | "720p"
  numSegments?: number; // 1
}

/** POST /generate (multipart image + audio) → job_id. */
export async function submitAvatarJob(o: SubmitOpts, timeoutMs = 60_000): Promise<string> {
  const base = requireBase();
  const fd = new FormData();
  const [imgBuf, audBuf] = await Promise.all([fs.readFile(o.imagePath), fs.readFile(o.audioPath)]);
  fd.append("image", new Blob([imgBuf]), path.basename(o.imagePath));
  fd.append("audio", new Blob([audBuf]), path.basename(o.audioPath));
  fd.append("prompt", o.prompt ?? "A person speaking naturally in a podcast, clear lip movements, calm bright studio.");
  fd.append("stage", o.stage ?? "ai2v");
  fd.append("resolution", o.resolution ?? "480p");
  fd.append("num_segments", String(o.numSegments ?? 1));
  const res = await fetchWithTimeout(`${base}/generate`, { method: "POST", headers: authHeaders(), body: fd }, timeoutMs);
  if (!res.ok) throw new Error(`avatar /generate HTTP ${res.status}: ${(await safeText(res)).slice(0, 200)}`);
  const j = (await res.json()) as { job_id?: string };
  if (!j.job_id) throw new Error("avatar /generate returned no job_id");
  return j.job_id;
}

export interface JobStatus {
  id: string;
  status: "queued" | "running" | "done" | "error";
  error?: string | null;
}

/** GET /jobs/{id}. */
export async function getJob(jobId: string, timeoutMs = 15_000): Promise<JobStatus> {
  const base = requireBase();
  const res = await fetchWithTimeout(`${base}/jobs/${encodeURIComponent(jobId)}`, { headers: authHeaders() }, timeoutMs);
  if (!res.ok) throw new Error(`avatar /jobs HTTP ${res.status}`);
  return (await res.json()) as JobStatus;
}

export interface PollOpts {
  pollMs?: number;
  timeoutMs?: number;
  onTick?: (s: JobStatus, elapsedMs: number) => void;
}

/** Poll /jobs/{id} until `done` (resolve) or `error`/timeout (throw). */
export async function pollJob(jobId: string, opts: PollOpts = {}): Promise<JobStatus> {
  const pollMs = opts.pollMs ?? 12_000;
  const timeoutMs = opts.timeoutMs ?? 45 * 60 * 1000;
  const t0 = Date.now();
  for (;;) {
    const s = await getJob(jobId);
    opts.onTick?.(s, Date.now() - t0);
    if (s.status === "done") return s;
    if (s.status === "error") throw new Error(`avatar job ${jobId} error: ${s.error ?? "see /jobs/{id}/log"}`);
    if (Date.now() - t0 > timeoutMs) throw new Error(`avatar job ${jobId} timed out after ${Math.round((Date.now() - t0) / 1000)}s`);
    await sleep(pollMs);
  }
}

/** GET /jobs/{id}/video → write mp4 to outPath. */
export async function downloadVideo(jobId: string, outPath: string, timeoutMs = 180_000): Promise<void> {
  const base = requireBase();
  const res = await fetchWithTimeout(`${base}/jobs/${encodeURIComponent(jobId)}/video`, { headers: authHeaders() }, timeoutMs);
  if (!res.ok) throw new Error(`avatar /video HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("avatar /video returned 0 bytes");
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, buf);
}

/**
 * Barrier: poll /healthz until the co-located qwen brain is back online
 * (`qwen_active === true` and no job running) so subsequent phases / routed
 * retries that might need the LLM don't hit a still-restarting model.
 * Returns false on timeout (non-fatal — caller decides).
 */
export async function waitForBrainOnline(opts: { timeoutMs?: number; pollMs?: number } = {}): Promise<boolean> {
  const base = avatarBaseUrl();
  if (!base) return true;
  const timeoutMs = opts.timeoutMs ?? 5 * 60 * 1000;
  const pollMs = opts.pollMs ?? 8_000;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const h = await avatarHealth();
    if (h && h.qwen_active && h.running === 0) return true;
    await sleep(pollMs);
  }
  return false;
}

function requireBase(): string {
  const base = avatarBaseUrl();
  if (!base) throw new Error("LONGCAT_AVATAR_BASE_URL not configured");
  return base;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}
