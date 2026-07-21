import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { RunContext } from "../orchestrator/runContext.js";
import { writeJson, readJson } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import type { AudioManifest } from "../schemas/audioManifest.js";
import { renderFps, renderQuality, scriptMode } from "../tools/runProfile.js";
import { avatarOverlayRect, type Rect } from "../tools/avatarLayout.js";
import { freezeEnableExpr, distinctSpeakers } from "../tools/avatarSpeakerTimeline.js";

/**
 * Pinned hyperframes version. The composition template (hfmlBuilder.ts) targets
 * a specific hyperframes timeline contract (`window.__hyperframes_render` +
 * `window.__timelines[id]`). Newer hyperframes majors dropped that global and
 * changed timeline discovery, which silently produces a blank body (only the
 * persistent chrome renders) because the GSAP master timeline is never seeked.
 * Pinning keeps `npx` from resolving an incompatible latest. Override with
 * HARNESS_HYPERFRAMES_VERSION if you intentionally upgrade the template too.
 */
const HYPERFRAMES_VERSION = process.env.HARNESS_HYPERFRAMES_VERSION?.trim() || "0.6.25";

/**
 * RENDER phase — render the deck to `composition/deck.mp4` via hyperframes, then
 * composite the bottom avatar presenter clip into the framed band and mux the
 * deck's TTS audio → `final.mp4`.
 *
 * The avatar is a SHORT clip (key-segment + loop): RENDER builds a seamless
 * ping-pong (forward+reverse) "boomerang", `-stream_loop`s it to the full deck
 * length, and overlays it at `avatarOverlayRect()` (same geometry the deck card
 * is drawn from). When no avatar.mp4 exists (skipped/degraded) the deck IS the
 * final video (framed placeholder band).
 *
 * In environments without hyperframes / chrome, this gracefully skips (warn).
 * Set HARNESS_SKIP_RENDER=1 to always skip.
 */
export const render = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  if (process.env.HARNESS_SKIP_RENDER === "1") {
    return { ok: true, issues: [{
      kind: "render-skipped", severity: "warn",
      message: "HARNESS_SKIP_RENDER=1 — skipping hyperframes render",
    }] };
  }

  const compDir = path.resolve(ctx.paths.compositionDir);
  const deckMp4 = path.resolve(ctx.paths.deckMp4);
  const finalMp4 = path.resolve(ctx.paths.finalMp4);
  const avatarMp4 = path.resolve(ctx.paths.avatarMp4);

  // 1. Render the deck (no subtitles) to deck.mp4.
  const args = [
    "-y",
    `hyperframes@${HYPERFRAMES_VERSION}`, "render", compDir,
    "--output", deckMp4,
    "--fps", String(renderFps()),
    "--quality", renderQuality(),
    "--quiet",
  ];
  try {
    const res = await runSpawn("npx", args, { timeoutMs: 60 * 60 * 1000 });
    if (res.code !== 0) {
      return { ok: false, issues: [{
        kind: "render-failed", severity: "error",
        message: `hyperframes render exit=${res.code}: ${res.stderr.slice(-400)}`,
      }] };
    }
  } catch (e: any) {
    return { ok: true, issues: [{
      kind: "render-unavailable", severity: "warn",
      message: `hyperframes unavailable (${e?.message ?? e}); skipped render. Install via 'npx hyperframes init' or set HARNESS_SKIP_RENDER=1.`,
    }] };
  }

  // 2. Composite the avatar presenter (or ship deck as-is).
  const issues: Issue[] = [];
  const rect = avatarOverlayRect();
  let avatarComposited = false;
  let avatarOverlayMode: "podcast-split" | "loop" | "none" = "none";

  if (await exists(avatarMp4)) {
    try {
      const dur = await ffprobeDuration(deckMp4);
      const cropBias = parseBias(process.env.HARNESS_AVATAR_CROP_BIAS, 0.12);
      const loopMp4 = path.join(compDir, "avatar-loop.mp4");
      await runFfmpeg(buildBoomerangArgs(avatarMp4, rect, cropBias, loopMp4));

      // Dual-host podcast: drive per-speaker lip-sync by freezing the idle half
      // to a still whenever that host is silent (no extra GPU). Monologue and
      // single-side fallbacks keep the plain ping-pong loop.
      const plan = await speakerBandPlan(ctx, dur);
      if (plan) {
        const stillPng = path.join(compDir, "avatar-still.png");
        await runFfmpeg(buildStillArgs(loopMp4, stillPng));
        await runFfmpeg(buildSpeakerOverlayArgs(deckMp4, loopMp4, stillPng, rect, dur, plan, finalMp4));
        avatarOverlayMode = "podcast-split";
      } else {
        await runFfmpeg(buildOverlayArgs(deckMp4, loopMp4, rect, dur, finalMp4));
        avatarOverlayMode = "loop";
      }
      avatarComposited = true;
    } catch (e: any) {
      await fs.copyFile(deckMp4, finalMp4);
      issues.push({
        kind: "render-avatar-overlay-failed", severity: "warn",
        message: `avatar overlay failed (${e?.message ?? e}); shipped deck without talking head`,
      });
    }
  } else {
    await fs.copyFile(deckMp4, finalMp4);
    issues.push({
      kind: "render-no-avatar", severity: "warn",
      message: "no composition/avatar.mp4 — final.mp4 = deck (framed placeholder band)",
    });
  }

  await writeJson(`${ctx.paths.verifyDir}/render.json`, {
    deckMp4, finalMp4, avatarComposited, avatarOverlayMode, overlayRect: rect,
    fps: renderFps(), quality: renderQuality(),
    issues, at: new Date().toISOString(),
  });
  return { ok: true, issues };
};

/**
 * Decide whether to use the dual-host speaker-aware band. Returns the per-half
 * freeze predicates, or null to fall back to the plain looped overlay (monologue,
 * missing manifest, single speaker, or HARNESS_AVATAR_NO_SPLIT=1). Side mapping
 * defaults to Anchor=left / Analyst=right (overridable for a mirrored image).
 */
async function speakerBandPlan(
  ctx: RunContext,
  durationSec: number,
): Promise<{ leftFreeze: string; rightFreeze: string; leftSpeaker: string; rightSpeaker: string } | null> {
  if (process.env.HARNESS_AVATAR_NO_SPLIT === "1") return null;
  if (scriptMode() !== "podcast") return null;
  let mani: AudioManifest;
  try { mani = await readJson<AudioManifest>(ctx.paths.audioManifest); } catch { return null; }
  const speakers = distinctSpeakers(mani);
  const leftSpeaker = process.env.HARNESS_AVATAR_LEFT_SPEAKER?.trim() || "Anchor";
  const rightSpeaker = process.env.HARNESS_AVATAR_RIGHT_SPEAKER?.trim() || "Analyst";
  if (!speakers.includes(leftSpeaker) || !speakers.includes(rightSpeaker)) return null;
  const pad = parseBias(process.env.HARNESS_AVATAR_LIPSYNC_PAD, 0.12);
  return {
    leftSpeaker, rightSpeaker,
    leftFreeze: freezeEnableExpr(mani, leftSpeaker, durationSec, pad),
    rightFreeze: freezeEnableExpr(mani, rightSpeaker, durationSec, pad),
  };
}

/**
 * ffmpeg args that turn the short avatar clip into a seamless ping-pong loop
 * unit scaled+cropped to the presenter band (heads biased toward the top).
 */
export function buildBoomerangArgs(avatarMp4: string, rect: Rect, cropBias: number, outPath: string): string[] {
  const { w, h } = rect;
  const yoff = `(ih-${h})*${clamp01(cropBias)}`;
  const vf =
    `scale=${w}:${h}:force_original_aspect_ratio=increase,` +
    `crop=${w}:${h}:(iw-${w})/2:${yoff},setsar=1,split[a][b];` +
    `[b]reverse[r];[a][r]concat=n=2:v=1:a=0,format=yuv420p[v]`;
  return ["-y", "-i", avatarMp4, "-filter_complex", vf, "-map", "[v]", "-an", outPath];
}

/**
 * ffmpeg args that `-stream_loop` the boomerang under the deck, overlay it at
 * the band position, keep the deck's audio, and bound the output to the deck
 * duration.
 */
export function buildOverlayArgs(deckMp4: string, loopMp4: string, rect: Rect, durationSec: number, outMp4: string): string[] {
  const { x, y } = rect;
  const fc = `[1:v]setpts=N/FRAME_RATE/TB[av];[0:v][av]overlay=${x}:${y}:shortest=1[v]`;
  return [
    "-y",
    "-i", deckMp4,
    "-stream_loop", "-1", "-i", loopMp4,
    "-filter_complex", fc,
    "-map", "[v]", "-map", "0:a?",
    "-t", durationSec.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart",
    outMp4,
  ];
}

/** Grab a single frame from the boomerang loop to use as the frozen idle pose. */
export function buildStillArgs(loopMp4: string, outPng: string): string[] {
  return ["-y", "-i", loopMp4, "-frames:v", "1", "-update", "1", outPng];
}

/**
 * Dual-host overlay: split the band at the vertical centre and freeze the idle
 * half to the still whenever that host is silent, so only the talking host's
 * mouth moves. Inputs: [0] deck, [1] looped boomerang (moving, both heads),
 * [2] still PNG (idle pose). Audio = deck's TTS track.
 */
export function buildSpeakerOverlayArgs(
  deckMp4: string,
  loopMp4: string,
  stillPng: string,
  rect: Rect,
  durationSec: number,
  plan: { leftFreeze: string; rightFreeze: string },
  outMp4: string,
): string[] {
  const { x, y, w, h } = rect;
  const cw = even(Math.floor(w / 2)); // left (female) half width — even for yuv420
  const rw = w - cw;                  // right (male) half width — even since w is even
  const fc =
    `[1:v]setpts=N/FRAME_RATE/TB[mv];` +
    `[2:v]format=yuv420p,setsar=1,split=2[sa][sb];` +
    `[sa]crop=${cw}:${h}:0:0[stL];` +
    `[sb]crop=${rw}:${h}:${cw}:0[stR];` +
    `[mv][stL]overlay=0:0:enable='${plan.leftFreeze}'[b1];` +
    `[b1][stR]overlay=${cw}:0:enable='${plan.rightFreeze}'[band];` +
    `[0:v][band]overlay=${x}:${y}:shortest=1[v]`;
  return [
    "-y",
    "-i", deckMp4,
    "-stream_loop", "-1", "-i", loopMp4,
    "-loop", "1", "-i", stillPng,
    "-filter_complex", fc,
    "-map", "[v]", "-map", "0:a?",
    "-t", durationSec.toFixed(3),
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p",
    "-c:a", "copy", "-movflags", "+faststart",
    outMp4,
  ];
}

function even(n: number): number {
  const r = Math.round(n);
  return r % 2 === 0 ? r : r - 1;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.12;
  return Math.max(0, Math.min(1, n));
}

function parseBias(raw: string | undefined, fallback: number): number {
  const n = Number.parseFloat(raw ?? "");
  return Number.isFinite(n) ? clamp01(n) : fallback;
}

async function exists(p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr?.on("data", (d) => (err += d.toString()));
    p.on("error", reject);
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${err.slice(-300)}`))));
  });
}

function ffprobeDuration(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("error", reject);
    p.on("exit", () => {
      const n = parseFloat(out.trim());
      Number.isFinite(n) ? resolve(n) : reject(new Error("ffprobe could not read deck duration"));
    });
  });
}

interface SpawnResult { code: number; stdout: string; stderr: string; }
function runSpawn(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    p.stdout?.on("data", d => stdout += d.toString());
    p.stderr?.on("data", d => stderr += d.toString());
    const t = opts.timeoutMs ? setTimeout(() => { p.kill("SIGKILL"); reject(new Error("timeout")); }, opts.timeoutMs) : null;
    p.on("error", (e) => { if (t) clearTimeout(t); reject(e); });
    p.on("exit", (code) => { if (t) clearTimeout(t); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
