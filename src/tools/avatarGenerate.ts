/**
 * Avatar clip **generation** — the ONLY module that triggers a longcat
 * `/generate` job (which pauses the co-located qwen3.6 brain ~10-12 min).
 *
 * This is invoked exclusively by the explicit `harness avatar-prewarm` command,
 * never by the pipeline. The AVATAR pipeline phase only *consumes* clips via
 * `avatarLibrary.findCachedClip()`, so a normal `harness run` can never stop the
 * brain. New clips are persisted into the version-controlled material library
 * (`assets/avatar-clips/`) with provenance recorded in `index.json`.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ScriptMode } from "./runProfile.js";
import { avatarImagePath, avatarResolution, avatarSegments } from "./runProfile.js";
import { lineToSsml, VOICE, type SpeakerName } from "./ssml.js";
import { synthLine } from "./azureSpeech.js";
import {
  avatarLibraryDir,
  libraryClipName,
  libraryClipPath,
  activeAvatarPrompt,
  upsertIndexEntry,
  fileSha256,
} from "./avatarLibrary.js";
import type { AudioManifest } from "../schemas/audioManifest.js";
import {
  isAvatarEnabled,
  avatarBaseUrl,
  avatarHealth,
  submitAvatarJob,
  pollJob,
  downloadVideo,
  waitForBrainOnline,
} from "./avatarClient.js";

export interface PrewarmOpts {
  mode: ScriptMode;
  imagePath?: string;
  resolution?: string;
  segments?: number;
  prompt?: string;
  /** Pinned driving audio (else auto-discovered from prior runs' opening TTS). */
  driveAudio?: string;
  /** Regenerate even when the library clip already exists. */
  force?: boolean;
  onLog?: (msg: string) => void;
}

export interface PrewarmResult {
  mode: ScriptMode;
  clip: string;          // absolute path in the library
  clipName: string;      // canonical filename
  generated: boolean;    // false ⇒ skipped because already present
  resolution: string;
  segments: number;
  jobId?: string;
  driveAudioSource?: string;
}

/**
 * Generate (or reuse) the avatar clip for `opts` and persist it into the
 * version-controlled library. Honours `--force`. Throws on hard failure — the
 * prewarm CLI reports it; the pipeline is unaffected because it never calls
 * this routine.
 */
export async function prewarmAvatarClip(o: PrewarmOpts): Promise<PrewarmResult> {
  const log = o.onLog ?? (() => {});
  const mode = o.mode;
  const imagePath = o.imagePath ?? avatarImagePath(mode);
  const resolution = o.resolution ?? avatarResolution();
  const segments = o.segments ?? avatarSegments();
  const prompt = o.prompt ?? activeAvatarPrompt(mode);
  const clipName = libraryClipName(mode, resolution, segments, prompt);
  const clipPath = libraryClipPath(mode, resolution, segments, prompt);

  if (!isAvatarEnabled()) {
    throw new Error(
      "avatar generation requires LONGCAT_AVATAR_BASE_URL (and HARNESS_SKIP_AVATAR unset). " +
        "The pipeline never generates; only `harness avatar-prewarm` does.",
    );
  }
  if (!(await exists(imagePath))) {
    throw new Error(`avatar source image not found: ${imagePath}`);
  }

  if (!o.force && (await exists(clipPath))) {
    log(`[prewarm] ${clipName} already in library — skipping (use --force to regenerate)`);
    return { mode, clip: clipPath, clipName, generated: false, resolution, segments };
  }

  const health = await avatarHealth();
  if (!health) throw new Error(`avatar service unreachable at ${avatarBaseUrl()} — cannot prewarm`);

  await fs.mkdir(avatarLibraryDir(), { recursive: true });
  const lockDir = path.join(avatarLibraryDir(), ".lock");
  let jobId: string | undefined;
  let driveAudioSource: string | undefined;
  let tmpDir: string | undefined;
  try {
    await acquireLock(lockDir, log);
    // Re-check after winning the lock — a parallel prewarm may have just made it.
    if (!o.force && (await exists(clipPath))) {
      log(`[prewarm] ${clipName} appeared while waiting for the lock — skipping`);
      return { mode, clip: clipPath, clipName, generated: false, resolution, segments };
    }

    const drv = await buildPrewarmDrivingAudio(mode, segments, o.driveAudio, log);
    tmpDir = drv.tmpDir;
    driveAudioSource = drv.source;

    log(`[prewarm] submitting ${mode} job (${resolution}, ${segments} seg) — qwen brain pauses ~10 min`);
    jobId = await submitAvatarJob({ imagePath, audioPath: drv.wav, prompt, resolution, numSegments: segments });
    let lastMin = -1;
    await pollJob(jobId, {
      onTick: (s, el) => {
        const min = Math.round(el / 60000);
        if (min !== lastMin) {
          lastMin = min;
          log(`[prewarm] job ${jobId!.slice(0, 8)} ${s.status} (${min} min)`);
        }
      },
    });
    await downloadVideo(jobId, clipPath);
    log(`[prewarm] generated + persisted ${clipName}`);

    const back = await waitForBrainOnline();
    if (!back) log("[prewarm] WARN qwen brain not confirmed back online after the job (continuing)");
  } finally {
    await releaseLock(lockDir);
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  const [bytes, imageSha256] = await Promise.all([
    fs.stat(clipPath).then((s) => s.size),
    fileSha256(imagePath),
  ]);
  await upsertIndexEntry({
    clip: clipName,
    mode,
    resolution,
    segments,
    prompt,
    image: path.basename(imagePath),
    imageSha256,
    bytes,
    jobId,
    driveAudioSource,
    createdAt: new Date().toISOString(),
  });

  return { mode, clip: clipPath, clipName, generated: true, resolution, segments, jobId, driveAudioSource };
}

interface DriveAudio {
  wav: string;
  source: string;
  tmpDir: string;
}

/**
 * Build the short driving wav for ONE generation. Per the project owner, prefer
 * reusing a prior run's **opening** TTS (the match structure is similar across
 * fixtures), so the looped clip's mouth motion matches the real product:
 *   1. explicit `--drive-audio` / HARNESS_AVATAR_DRIVE_AUDIO,
 *   2. opening line wavs of the most recent prior match (prefer same mode),
 *   3. last resort: synthesize a neutral opening line (stub-safe).
 */
export async function buildPrewarmDrivingAudio(
  mode: ScriptMode,
  segments: number,
  explicit: string | undefined,
  log: (m: string) => void,
): Promise<DriveAudio> {
  const driveSec = round(segments * 3.7 + 1.2, 2);
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-prewarm-"));
  const outWav = path.join(tmpDir, "drive.wav");

  // 1. explicit / env-pinned reference
  const pinned = explicit?.trim() || process.env.HARNESS_AVATAR_DRIVE_AUDIO?.trim();
  if (pinned) {
    if (!(await exists(pinned))) throw new Error(`drive audio not found: ${pinned}`);
    await ffmpeg(["-y", "-i", pinned, "-t", String(driveSec), "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", outWav]);
    log(`[prewarm] driving audio: pinned ${path.basename(pinned)}`);
    return { wav: outWav, source: `pinned:${path.basename(pinned)}`, tmpDir };
  }

  // 2. prior run's opening TTS (prefer same mode)
  const prior = await discoverPriorOpeningWavs(mode, 8);
  if (prior && prior.wavs.length > 0) {
    const listPath = path.join(tmpDir, "list.txt");
    await fs.writeFile(listPath, prior.wavs.map((w) => `file '${w.replace(/'/g, "'\\''")}'`).join("\n") + "\n", "utf8");
    await ffmpeg(["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-t", String(driveSec), "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", outWav]);
    log(`[prewarm] driving audio: ${prior.wavs.length} opening lines from ${prior.matchId} (${prior.mode})`);
    return { wav: outWav, source: `prior:${prior.matchId}`, tmpDir };
  }

  // 3. last resort: synthesize a neutral opening line
  log("[prewarm] no prior TTS found — synthesizing a neutral opening sample");
  const synthWav = await synthNeutralOpening(mode, tmpDir);
  await ffmpeg(["-y", "-i", synthWav, "-t", String(driveSec), "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", outWav]);
  return { wav: outWav, source: "synth:neutral", tmpDir };
}

interface PriorOpening {
  matchId: string;
  mode: string;
  wavs: string[];
}

/**
 * Scan `out/<bucket>/<base>/audio/manifest.json` for prior runs and return the
 * opening line wavs of the most recent one, preferring a manifest whose match
 * was the same script `mode` (read from the sibling dialogue.json). Returns null
 * when no usable prior TTS exists.
 */
async function discoverPriorOpeningWavs(mode: ScriptMode, maxLines: number): Promise<PriorOpening | null> {
  const root = process.env.HARNESS_WORK_DIR ?? "out";
  let buckets: string[];
  try {
    buckets = await fs.readdir(root);
  } catch {
    return null;
  }

  interface Candidate { matchId: string; mode: string; manifestPath: string; mtime: number; sameMode: boolean; }
  const candidates: Candidate[] = [];
  for (const bucket of buckets) {
    if (bucket.startsWith("_")) continue; // skip _cache
    const bucketDir = path.join(root, bucket);
    let bases: string[];
    try {
      bases = await fs.readdir(bucketDir);
    } catch {
      continue;
    }
    for (const base of bases) {
      const manifestPath = path.join(bucketDir, base, "audio", "manifest.json");
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(manifestPath);
      } catch {
        continue;
      }
      const dlgMode = await readDialogueMode(path.join(bucketDir, base, "dialogue.json"));
      candidates.push({
        matchId: `${bucket}__${base}`,
        mode: dlgMode ?? "unknown",
        manifestPath,
        mtime: stat.mtimeMs,
        sameMode: dlgMode === mode,
      });
    }
  }
  if (candidates.length === 0) return null;

  // Prefer same-mode, then most recently produced.
  candidates.sort((a, b) => (Number(b.sameMode) - Number(a.sameMode)) || (b.mtime - a.mtime));

  for (const c of candidates) {
    try {
      const mani = JSON.parse(await fs.readFile(c.manifestPath, "utf8")) as AudioManifest;
      const maniDir = path.dirname(c.manifestPath);
      const wavs: string[] = [];
      for (const l of mani.lines) {
        const abs = path.resolve(maniDir, l.wavPath);
        if (await exists(abs)) wavs.push(abs);
        if (wavs.length >= maxLines) break;
      }
      if (wavs.length > 0) return { matchId: c.matchId, mode: c.mode, wavs };
    } catch {
      continue;
    }
  }
  return null;
}

async function readDialogueMode(dialoguePath: string): Promise<string | null> {
  try {
    const j = JSON.parse(await fs.readFile(dialoguePath, "utf8")) as { mode?: string };
    return typeof j.mode === "string" ? j.mode : null;
  } catch {
    return null;
  }
}

/** Synthesize a short neutral opening line via the existing TTS provider chain. */
async function synthNeutralOpening(mode: ScriptMode, tmpDir: string): Promise<string> {
  const speaker: SpeakerName = mode === "monologue" ? "Narrator" : "Anchor";
  const text = "大家好，欢迎一起观察这场比赛的概率与基本面。";
  const outPath = path.join(tmpDir, "neutral.wav");
  const res = await synthLine(
    { ssml: lineToSsml(text, speaker), voice: VOICE[speaker], text, speaker, outPath },
    path.join(tmpDir, "tts-cache"),
  );
  return res.wavPath;
}

// ── mkdir-based global lock — serialises real generations across parallel
//    prewarm invocations so only one longcat job runs at a time. ─────────────
async function acquireLock(lockDir: string, log: (m: string) => void, timeoutMs = 60 * 60 * 1000, staleMs = 60 * 60 * 1000): Promise<void> {
  const infoPath = path.join(lockDir, "info.json");
  const t0 = Date.now();
  let warned = false;
  for (;;) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(infoPath, JSON.stringify({ pid: process.pid, at: Date.now() }), "utf8");
      return;
    } catch {
      try {
        const info = JSON.parse(await fs.readFile(infoPath, "utf8")) as { at: number };
        if (Date.now() - info.at > staleMs) {
          await fs.rm(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        /* info missing/partial — treat as transient */
      }
      if (Date.now() - t0 > timeoutMs) throw new Error("avatar prewarm lock acquire timeout");
      if (!warned) {
        warned = true;
        log("[prewarm] another prewarm job holds the lock — waiting…");
      }
      await sleep(3000);
    }
  }
}

async function releaseLock(lockDir: string): Promise<void> {
  try {
    await fs.rm(lockDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

function ffmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`))));
  });
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function round(x: number, p: number): number {
  const f = Math.pow(10, p);
  return Math.round(x * f) / f;
}
