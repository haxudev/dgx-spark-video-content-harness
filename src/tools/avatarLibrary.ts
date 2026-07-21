/**
 * Version-controlled digital-human material library (avatar clips).
 *
 * This module is the single source of truth for *resolving and persisting*
 * pre-generated avatar clips. It performs **no network calls** — it only reads
 * and writes local files. The pipeline AVATAR phase consumes clips through
 * `findCachedClip()`; the explicit `avatar-prewarm` command (see
 * `avatarGenerate.ts`) is the only writer that adds new clips.
 *
 * Why a readable, image-bytes-free name?
 *   The legacy shared cache keyed clips by `sha256(imageBytes|res|seg|prompt)`
 *   under the git-ignored `out/_cache/avatar/`. That made the cache portable
 *   only if you also shipped the 2MB source image, and the directory was never
 *   committed. Here clips live in a **version-controlled** dir with
 *   human-readable names like `podcast-480p-seg1.mp4`, so lookup needs no
 *   source image and the library travels with the repo. An `index.json`
 *   manifest records full provenance (image sha, job id, drive-audio source).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ScriptMode } from "./runProfile.js";

/**
 * Directory holding the committed avatar clips + index.json. Default is the
 * repo-relative `assets/avatar-clips/` (tracked by git); override with
 * HARNESS_AVATAR_LIBRARY_DIR (e.g. for a shared NAS mount).
 */
export function avatarLibraryDir(): string {
  const override = process.env.HARNESS_AVATAR_LIBRARY_DIR?.trim();
  if (override) return path.resolve(override);
  return path.resolve("assets", "avatar-clips");
}

/** Legacy shared cache (git-ignored): out/_cache/avatar — read-only fallback. */
export function legacyAvatarCacheDir(): string {
  return path.join(process.env.HARNESS_WORK_DIR ?? "out", "_cache", "avatar");
}

/** The mode-derived default longcat prompt (no env override applied). */
export function defaultAvatarPrompt(mode: ScriptMode): string {
  return mode === "monologue"
    ? "A single Chinese male host speaking to camera in a modern studio, natural head motion, clear lip sync, calm confident delivery."
    : "Two Chinese podcast hosts speaking to camera in a bright modern studio, natural head motion and small gestures, clear lip movements.";
}

/** Active prompt = HARNESS_AVATAR_PROMPT override, else the mode default. */
export function activeAvatarPrompt(mode: ScriptMode): string {
  const override = process.env.HARNESS_AVATAR_PROMPT?.trim();
  return override || defaultAvatarPrompt(mode);
}

function shortHash(s: string, n = 8): string {
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, n);
}

/**
 * Human-readable, deterministic clip filename. The common case (mode default
 * prompt) is clean — `podcast-480p-seg1.mp4`; a custom prompt gets an 8-char
 * suffix so prompt variants don't collide — `podcast-480p-seg1-1a2b3c4d.mp4`.
 */
export function libraryClipName(mode: ScriptMode, resolution: string, segments: number, prompt: string): string {
  const base = `${mode}-${resolution}-seg${segments}`;
  return prompt === defaultAvatarPrompt(mode) ? `${base}.mp4` : `${base}-${shortHash(prompt)}.mp4`;
}

/** Absolute path of the canonical library clip for these parameters. */
export function libraryClipPath(mode: ScriptMode, resolution: string, segments: number, prompt: string): string {
  return path.join(avatarLibraryDir(), libraryClipName(mode, resolution, segments, prompt));
}

/**
 * Legacy image-bytes cache key (kept ONLY for backward-compatible lookup of the
 * old out/_cache/avatar/<key>.mp4 clips). New clips never use this scheme.
 */
export async function legacyCacheKey(imagePath: string, resolution: string, segments: number, prompt: string): Promise<string> {
  const buf = await fs.readFile(imagePath);
  const h = crypto.createHash("sha256");
  h.update(buf);
  h.update(`|${resolution}|${segments}|${prompt}`);
  return h.digest("hex").slice(0, 40);
}

export interface FindResult {
  path: string;
  source: "library" | "legacy";
}

/**
 * Resolve a cached clip for these parameters WITHOUT any network call.
 *   1. canonical library clip (`assets/avatar-clips/<readable>.mp4`)
 *   2. legacy `out/_cache/avatar/<imageHashKey>.mp4` (best-effort, needs the
 *      source image to recompute the hash; silently skipped when absent)
 * Returns null on a miss — the caller decides how to degrade.
 */
export async function findCachedClip(opts: {
  mode: ScriptMode;
  resolution: string;
  segments: number;
  prompt: string;
  imagePath?: string;
  legacyCacheDir?: string;
}): Promise<FindResult | null> {
  const libPath = libraryClipPath(opts.mode, opts.resolution, opts.segments, opts.prompt);
  if (await exists(libPath)) return { path: libPath, source: "library" };

  const legacyDir = opts.legacyCacheDir ?? legacyAvatarCacheDir();
  if (opts.imagePath && (await exists(opts.imagePath))) {
    try {
      const key = await legacyCacheKey(opts.imagePath, opts.resolution, opts.segments, opts.prompt);
      const legacyPath = path.join(legacyDir, `${key}.mp4`);
      if (await exists(legacyPath)) return { path: legacyPath, source: "legacy" };
    } catch {
      /* image unreadable — ignore, treat as miss */
    }
  }
  return null;
}

// ── index.json (self-describing material-library manifest) ─────────────────

export interface LibraryEntry {
  clip: string;          // filename within the library dir
  mode: ScriptMode;
  resolution: string;
  segments: number;
  prompt: string;
  image: string;         // basename of the source image used
  imageSha256: string;   // full sha of the source image (staleness detection)
  bytes: number;
  jobId?: string;
  driveAudioSource?: string;
  createdAt: string;
}

export interface LibraryIndex {
  version: 1;
  entries: LibraryEntry[];
  updatedAt: string;
}

export function indexPath(): string {
  return path.join(avatarLibraryDir(), "index.json");
}

function emptyIndex(): LibraryIndex {
  return { version: 1, entries: [], updatedAt: new Date().toISOString() };
}

export async function readIndex(): Promise<LibraryIndex> {
  try {
    const raw = await fs.readFile(indexPath(), "utf8");
    const j = JSON.parse(raw) as Partial<LibraryIndex>;
    if (!Array.isArray(j.entries)) return emptyIndex();
    return { version: 1, entries: j.entries as LibraryEntry[], updatedAt: j.updatedAt ?? new Date().toISOString() };
  } catch {
    return emptyIndex();
  }
}

/** Insert or replace the entry for `entry.clip` and persist index.json. */
export async function upsertIndexEntry(entry: LibraryEntry): Promise<void> {
  const idx = await readIndex();
  const i = idx.entries.findIndex((e) => e.clip === entry.clip);
  if (i >= 0) idx.entries[i] = entry;
  else idx.entries.push(entry);
  idx.entries.sort((a, b) => a.clip.localeCompare(b.clip));
  idx.updatedAt = new Date().toISOString();
  await fs.mkdir(avatarLibraryDir(), { recursive: true });
  await fs.writeFile(indexPath(), JSON.stringify(idx, null, 2) + "\n", "utf8");
}

export async function fileSha256(p: string): Promise<string> {
  const buf = await fs.readFile(p);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}
