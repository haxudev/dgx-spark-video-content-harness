export type HarnessProfile = "fast" | "draft" | "final";
export type ScriptMode = "podcast" | "monologue";

import * as os from "node:os";
import * as path from "node:path";

export function applyRunProfile(input?: string): HarnessProfile {
  const profile = parseProfile(input ?? process.env.HARNESS_PROFILE ?? "final");
  process.env.HARNESS_PROFILE = profile;

  if (profile === "fast") {
    setDefault("HARNESS_SKIP_RENDER", "1");
    setDefault("HARNESS_VISUAL_AUDIT_LLM", "0");
    setDefault("HARNESS_RENDER_FPS", "24");
    setDefault("HARNESS_RENDER_QUALITY", "draft");
    // The avatar GPU job is far too slow (~10-12 min) for fast iteration.
    setDefault("HARNESS_SKIP_AVATAR", "1");
  } else if (profile === "draft") {
    setDefault("HARNESS_VISUAL_AUDIT_LLM", "0");
    setDefault("HARNESS_RENDER_FPS", "24");
    setDefault("HARNESS_RENDER_QUALITY", "draft");
    setDefault("HARNESS_SKIP_AVATAR", "1");
  } else {
    setDefault("HARNESS_VISUAL_AUDIT_LLM", "0");
    setDefault("HARNESS_RENDER_FPS", "30");
    setDefault("HARNESS_RENDER_QUALITY", "draft");
  }

  setDefault("HARNESS_LLM_PROVIDER", "azure");
  setDefault("HARNESS_TTS_PARALLEL", "6");
  setDefault("HARNESS_WRITE_PARALLEL", "3");
  setDefault("HARNESS_CARD_PARALLEL", "3");
  return profile;
}

export function activeHarnessProfile(): HarnessProfile {
  return parseProfile(process.env.HARNESS_PROFILE ?? "final");
}

export function renderFps(): number {
  return clampInt(process.env.HARNESS_RENDER_FPS, activeHarnessProfile() === "final" ? 30 : 24, 12, 60);
}

export function renderQuality(): string {
  return process.env.HARNESS_RENDER_QUALITY ?? "draft";
}

export function shouldUseVisualAuditLLM(): boolean {
  return process.env.HARNESS_VISUAL_AUDIT_LLM === "1";
}

/** Avatar (LongCat digital-human) render resolution — 480p default. */
export function avatarResolution(): string {
  const raw = (process.env.HARNESS_AVATAR_RESOLUTION ?? "480p").toLowerCase();
  return raw === "720p" ? "720p" : "480p";
}

/** Avatar continuation segments (each ≈3.7s, ≈10 min). Key-segment+loop ⇒ 1. */
export function avatarSegments(): number {
  return clampInt(process.env.HARNESS_AVATAR_SEGMENTS, 1, 1, 8);
}

/** Directory holding the avatar source images (two-people / single-people). */
export function avatarAssetDir(): string {
  return (
    process.env.HARNESS_AVATAR_ASSET_DIR?.trim() ||
    path.join(os.homedir(), "openclaw-artifacts", "podcast_avator")
  );
}

/**
 * Source avatar image for the active script mode. Overridable per-mode
 * (HARNESS_AVATAR_IMAGE_PODCAST / _MONOLOGUE) or globally (HARNESS_AVATAR_IMAGE).
 *   - podcast (dual-host)  → two-people.png
 *   - monologue (解局人)    → single-people.png
 */
export function avatarImagePath(mode: ScriptMode): string {
  const generic = process.env.HARNESS_AVATAR_IMAGE?.trim();
  if (generic) return generic;
  if (mode === "monologue") {
    return process.env.HARNESS_AVATAR_IMAGE_MONOLOGUE?.trim() || path.join(avatarAssetDir(), "single-people.png");
  }
  return process.env.HARNESS_AVATAR_IMAGE_PODCAST?.trim() || path.join(avatarAssetDir(), "two-people.png");
}

export function ttsParallel(): number {
  return clampInt(process.env.HARNESS_TTS_PARALLEL, 6, 1, 8);
}

export function writeParallel(): number {
  return clampInt(process.env.HARNESS_WRITE_PARALLEL, 3, 1, 8);
}

export function cardParallel(): number {
  return clampInt(process.env.HARNESS_CARD_PARALLEL, 3, 1, 6);
}

export function llmProviderPreference(): "azure" | "gx10" | "auto" {
  const raw = (process.env.HARNESS_LLM_PROVIDER ?? "azure").toLowerCase();
  if (raw === "gx10" || raw === "auto") return raw;
  return "azure";
}

/**
 * TTS backend preference (env: HARNESS_TTS_PROVIDER):
 *   - "qwen":  the local Qwen3-TTS service — named voices (/v1/tts) and 3-second
 *              voice cloning (/v1/voice_clone, Base model); then Azure, then stub
 *   - "azure"  (default): only Azure Speech (then stub) — reliable neural voices
 *   - "auto":  try local Qwen first, then Azure, then stub
 *
 * Default is "azure": the local Qwen host is not always reachable and a silent
 * stub fallback for a missed line is worse than always using Azure.
 */
export function ttsProviderPreference(): "qwen" | "azure" | "auto" {
  const raw = (process.env.HARNESS_TTS_PROVIDER ?? "azure").toLowerCase();
  if (raw === "qwen" || raw === "auto") return raw;
  return "azure";
}

/**
 * Script mode (env: HARNESS_SCRIPT_MODE):
 *   - "podcast"   (default): dual-host 男女对谈 (Anchor + Analyst)
 *   - "monologue": single-host first-person 口播稿 (Narrator), 阴谋论式解读
 *
 * The CLI `--mode` flag, when present, is written into HARNESS_SCRIPT_MODE by
 * the run action before any phase executes, so this accessor is the single
 * source of truth for the active mode.
 */
export function scriptMode(): ScriptMode {
  const raw = (process.env.HARNESS_SCRIPT_MODE ?? "podcast").toLowerCase();
  return raw === "monologue" ? "monologue" : "podcast";
}

export function parseScriptMode(raw: string): ScriptMode {
  const v = raw.toLowerCase();
  if (v === "podcast" || v === "monologue") return v;
  throw new Error(`Invalid HARNESS script mode '${raw}' (expected podcast or monologue)`);
}

export interface VoiceOverrides {
  /** Generic shorthand: mode-aware base applied to the active host(s). */
  voice?: string;
  /** Analyst 小帅 (QWEN_TTS_VOICE_MALE). */
  voiceMale?: string;
  /** Anchor 小美 (QWEN_TTS_VOICE_FEMALE). */
  voiceFemale?: string;
  /** Narrator 解局人 (QWEN_TTS_VOICE_NARRATOR). */
  voiceNarrator?: string;
}

/**
 * Qwen3-TTS (CustomVoice) ships a FIXED named speaker roster — you *select* one
 * of these for the `--voice*` overrides. (Cloning an arbitrary voice is a
 * separate path: a reference wav via QWEN_TTS_CLONE_REF_* / `--clone-ref`, which
 * is NOT validated against this roster.) Passing an unsupported name makes the
 * server return HTTP 400, which would otherwise silently fall through to Azure /
 * the stub beep, so we validate up front and fail loud instead.
 *
 * The roster is overridable via `QWEN_TTS_SPEAKERS` (comma list) in case the
 * server's speaker set changes. Matching is case-insensitive (the server
 * accepts both `uncle_fu` and `Uncle_Fu`).
 */
const DEFAULT_QWEN_SPEAKERS = [
  "aiden", "dylan", "eric", "ono_anna", "ryan", "serena", "sohee", "uncle_fu", "vivian",
];

export function qwenSpeakers(): string[] {
  const raw = process.env.QWEN_TTS_SPEAKERS?.trim();
  if (raw) return raw.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
  return DEFAULT_QWEN_SPEAKERS;
}

export function assertQwenVoice(name: string, label: string): void {
  const allow = qwenSpeakers();
  if (!allow.includes(name.trim().toLowerCase())) {
    throw new Error(
      `Unsupported Qwen3-TTS voice for ${label}: '${name}'. The named CustomVoice `
      + `roster is: ${allow.join(", ")}. To clone a custom voice instead, pass a `
      + `reference wav via --clone-ref / QWEN_TTS_CLONE_REF_*. `
      + `Set QWEN_TTS_SPEAKERS to override the roster if the server changed.`,
    );
  }
}

/**
 * Apply per-run named-voice overrides — Qwen3-TTS `qwen` backend only.
 *
 * These write into the QWEN_TTS_VOICE_* env vars that `qwenVoice()` reads at
 * synth time; Azure voices (AZURE_VOICE_*) are intentionally left untouched.
 * Each requested name is validated against the Qwen speaker roster (see
 * `assertQwenVoice`) and throws on an unsupported value, so a typo / a
 * hoped-for custom-cloned voice fails immediately instead of silently shipping
 * the wrong voice via the Azure/stub fallback. (Use `--clone-ref` to clone.)
 *
 * Precedence: the generic `voice` seeds a mode-aware base first, then the
 * per-role overrides win. In `monologue` the generic value sets the Narrator;
 * in `podcast` it seeds BOTH hosts (use voiceMale/voiceFemale for distinct
 * dual-host voices).
 *
 * Must be called AFTER the script mode is resolved (HARNESS_SCRIPT_MODE) so the
 * generic-flag routing sees the correct mode.
 */
export function applyVoiceOverrides(o: VoiceOverrides): void {
  const set = (name: string, value: string | undefined, label: string) => {
    const v = value?.trim();
    if (!v) return;
    assertQwenVoice(v, label);
    process.env[name] = v;
  };
  const generic = o.voice?.trim();
  if (generic) {
    assertQwenVoice(generic, "--voice");
    if (scriptMode() === "monologue") {
      process.env.QWEN_TTS_VOICE_NARRATOR = generic;
    } else {
      process.env.QWEN_TTS_VOICE_MALE = generic;
      process.env.QWEN_TTS_VOICE_FEMALE = generic;
    }
  }
  // Per-role flags take precedence over the generic base.
  set("QWEN_TTS_VOICE_MALE", o.voiceMale, "--voice-male");
  set("QWEN_TTS_VOICE_FEMALE", o.voiceFemale, "--voice-female");
  set("QWEN_TTS_VOICE_NARRATOR", o.voiceNarrator, "--voice-narrator");
}

export interface CloneRefOverrides {
  /** Generic reference wav: mode-aware base applied to the active host(s). */
  cloneRef?: string;
  /** Analyst 小帅 reference wav. */
  cloneRefMale?: string;
  /** Anchor 小美 reference wav. */
  cloneRefFemale?: string;
  /** Narrator 解局人 reference wav. */
  cloneRefNarrator?: string;
  /** Optional transcript for the generic reference (enables ICL mode). */
  cloneRefText?: string;
}

/**
 * Apply per-run voice-clone reference overrides — Qwen3-TTS `qwen` backend only.
 *
 * These write into the QWEN_TTS_CLONE_REF_* env vars that `qwenCloneRef()` reads
 * at synth time. A reference is a local wav path (the harness inlines it as a
 * base64 data URI), an http(s) URL, or a server-visible `/refs/...` path. Unlike
 * named voices these are NOT validated against the speaker roster — the whole
 * point is to clone an arbitrary voice.
 *
 * Precedence mirrors applyVoiceOverrides: the generic `cloneRef` seeds a
 * mode-aware base (Narrator in monologue, both hosts in podcast), then per-role
 * refs win. Must be called AFTER the script mode is resolved.
 */
export function applyCloneRefOverrides(o: CloneRefOverrides): void {
  const set = (name: string, value: string | undefined) => {
    const v = value?.trim();
    if (v) process.env[name] = v;
  };
  const generic = o.cloneRef?.trim();
  if (generic) {
    if (scriptMode() === "monologue") {
      process.env.QWEN_TTS_CLONE_REF_NARRATOR = generic;
    } else {
      process.env.QWEN_TTS_CLONE_REF_MALE = generic;
      process.env.QWEN_TTS_CLONE_REF_FEMALE = generic;
    }
  }
  set("QWEN_TTS_CLONE_REF_MALE", o.cloneRefMale);
  set("QWEN_TTS_CLONE_REF_FEMALE", o.cloneRefFemale);
  set("QWEN_TTS_CLONE_REF_NARRATOR", o.cloneRefNarrator);
  set("QWEN_TTS_CLONE_REF_TEXT", o.cloneRefText);
}

function parseProfile(raw: string): HarnessProfile {
  const v = raw.toLowerCase();
  if (v === "fast" || v === "draft" || v === "final") return v;
  throw new Error(`Invalid HARNESS profile '${raw}' (expected fast, draft, or final)`);
}

function setDefault(name: string, value: string): void {
  if (process.env[name] === undefined) process.env[name] = value;
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
