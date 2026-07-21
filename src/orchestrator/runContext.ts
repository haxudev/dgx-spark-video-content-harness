import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { Phase, RunState } from "./stateMachine.js";

export interface RunContext {
  matchId: string;
  reportPath: string;
  workDir: string;             // out/{date}/{match}
  cacheDir: string;            // shared TTS / parse cache
  paths: {
    state: string;
    blocks: string;
    talkPlan: string;
    dialogue: string;
    audioDir: string;
    audioManifest: string;
    compositionDir: string;
    compositionHtml: string;
    verifyDir: string;
    subtitles: string;
    finalMp4: string;
    deckMp4: string;
    avatarMp4: string;
    avatarCacheDir: string;
    thumbnail: string;
    deliveryManifest: string;
    complianceAudit: string;
    escalation: string;
    marketData: string;
  };
}

export async function buildRunContext(reportPath: string, root: string): Promise<RunContext> {
  const abs = path.resolve(reportPath);
  const base = path.basename(abs, path.extname(abs));
  // parent dir name as bucket (e.g. "20260519")
  const bucket = path.basename(path.dirname(abs));
  const matchId = `${bucket}__${base}`;

  const workDir = path.join(root, bucket, base);
  const cacheDir = path.join(root, "_cache");
  await fs.mkdir(workDir, { recursive: true });
  await fs.mkdir(path.join(workDir, "audio"), { recursive: true });
  await fs.mkdir(path.join(workDir, "composition"), { recursive: true });
  await fs.mkdir(path.join(workDir, "verify"), { recursive: true });
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.mkdir(path.join(cacheDir, "tts"), { recursive: true });
  await fs.mkdir(path.join(cacheDir, "avatar"), { recursive: true });

  return {
    matchId,
    reportPath: abs,
    workDir,
    cacheDir,
    paths: {
      state: path.join(workDir, "state.json"),
      blocks: path.join(workDir, "report.blocks.json"),
      talkPlan: path.join(workDir, "talk-plan.json"),
      dialogue: path.join(workDir, "dialogue.json"),
      audioDir: path.join(workDir, "audio"),
      audioManifest: path.join(workDir, "audio", "manifest.json"),
      compositionDir: path.join(workDir, "composition"),
      compositionHtml: path.join(workDir, "composition", "index.html"),
      verifyDir: path.join(workDir, "verify"),
      subtitles: path.join(workDir, "subtitles.vtt"),
      finalMp4: path.join(workDir, "final.mp4"),
      deckMp4: path.join(workDir, "composition", "deck.mp4"),
      avatarMp4: path.join(workDir, "composition", "avatar.mp4"),
      avatarCacheDir: path.join(cacheDir, "avatar"),
      thumbnail: path.join(workDir, "thumbnail.jpg"),
      deliveryManifest: path.join(workDir, "manifest.json"),
      complianceAudit: path.join(workDir, "compliance.json"),
      escalation: path.join(workDir, "escalation.json"),
      marketData: path.join(workDir, "market.json"),
    },
  };
}

export async function writeJson(p: string, obj: unknown): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, JSON.stringify(obj, null, 2), "utf8");
}

export async function readJson<T>(p: string): Promise<T> {
  const raw = await fs.readFile(p, "utf8");
  return JSON.parse(raw) as T;
}

export async function maybeReadJson<T>(p: string): Promise<T | null> {
  try { return await readJson<T>(p); }
  catch (e: any) { if (e?.code === "ENOENT") return null; throw e; }
}

export async function loadOrInitState(ctx: RunContext, fresh: () => RunState): Promise<RunState> {
  const existing = await maybeReadJson<RunState>(ctx.paths.state);
  if (existing) return existing;
  const s = fresh();
  await writeJson(ctx.paths.state, s);
  return s;
}

export async function persistState(ctx: RunContext, state: RunState): Promise<void> {
  state.updatedAt = new Date().toISOString();
  await writeJson(ctx.paths.state, state);
}

export function sha256(buf: string | Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

export function cacheKey(parts: (string | number)[]): string {
  return sha256(parts.join("\u241f"));
}

export function logPhaseStart(state: RunState, phase: Phase): void {
  state.currentPhase = phase;
  state.phases.push({
    phase,
    startedAt: new Date().toISOString(),
    attempts: 1,
    status: "running",
  });
}

export function logPhaseRetry(state: RunState): void {
  const last = state.phases[state.phases.length - 1];
  if (last) last.attempts += 1;
}

export function logPhaseEnd(state: RunState, ok: boolean, issues?: string[]): void {
  const last = state.phases[state.phases.length - 1];
  if (!last) return;
  last.endedAt = new Date().toISOString();
  last.status = ok ? "ok" : "fail";
  if (issues?.length) last.issues = issues;
}
