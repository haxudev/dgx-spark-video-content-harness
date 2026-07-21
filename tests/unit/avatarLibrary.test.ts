import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  avatarLibraryDir,
  libraryClipName,
  libraryClipPath,
  defaultAvatarPrompt,
  activeAvatarPrompt,
  legacyCacheKey,
  findCachedClip,
  readIndex,
  upsertIndexEntry,
  indexPath,
  type LibraryEntry,
} from "../../src/tools/avatarLibrary.js";

function restore(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test("libraryClipName is clean for the default prompt and hashed for a custom one", () => {
  const podDefault = defaultAvatarPrompt("podcast");
  assert.equal(libraryClipName("podcast", "480p", 1, podDefault), "podcast-480p-seg1.mp4");
  assert.equal(libraryClipName("monologue", "720p", 2, defaultAvatarPrompt("monologue")), "monologue-720p-seg2.mp4");

  const custom = libraryClipName("podcast", "480p", 1, "a totally different prompt");
  assert.match(custom, /^podcast-480p-seg1-[0-9a-f]{8}\.mp4$/);
  // Deterministic.
  assert.equal(custom, libraryClipName("podcast", "480p", 1, "a totally different prompt"));
});

test("activeAvatarPrompt honours HARNESS_AVATAR_PROMPT override", () => {
  const prev = process.env.HARNESS_AVATAR_PROMPT;
  try {
    delete process.env.HARNESS_AVATAR_PROMPT;
    assert.equal(activeAvatarPrompt("podcast"), defaultAvatarPrompt("podcast"));
    process.env.HARNESS_AVATAR_PROMPT = "custom studio prompt";
    assert.equal(activeAvatarPrompt("podcast"), "custom studio prompt");
    assert.equal(activeAvatarPrompt("monologue"), "custom studio prompt");
  } finally {
    restore("HARNESS_AVATAR_PROMPT", prev);
  }
});

test("avatarLibraryDir respects HARNESS_AVATAR_LIBRARY_DIR, else assets/avatar-clips", () => {
  const prev = process.env.HARNESS_AVATAR_LIBRARY_DIR;
  try {
    delete process.env.HARNESS_AVATAR_LIBRARY_DIR;
    assert.equal(avatarLibraryDir(), path.resolve("assets", "avatar-clips"));
    process.env.HARNESS_AVATAR_LIBRARY_DIR = "/tmp/my-lib";
    assert.equal(avatarLibraryDir(), path.resolve("/tmp/my-lib"));
    assert.equal(libraryClipPath("podcast", "480p", 1, defaultAvatarPrompt("podcast")), path.resolve("/tmp/my-lib", "podcast-480p-seg1.mp4"));
  } finally {
    restore("HARNESS_AVATAR_LIBRARY_DIR", prev);
  }
});

test("index upsert/read round-trips and dedups by clip name", async () => {
  const prev = process.env.HARNESS_AVATAR_LIBRARY_DIR;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-idx-"));
  try {
    process.env.HARNESS_AVATAR_LIBRARY_DIR = dir;
    assert.deepEqual((await readIndex()).entries, []);

    const base: LibraryEntry = {
      clip: "podcast-480p-seg1.mp4", mode: "podcast", resolution: "480p", segments: 1,
      prompt: "p", image: "two-people.png", imageSha256: "abc", bytes: 100, createdAt: "t1",
    };
    await upsertIndexEntry(base);
    await upsertIndexEntry({ ...base, bytes: 200, createdAt: "t2" }); // same clip → replace
    await upsertIndexEntry({ ...base, clip: "monologue-480p-seg1.mp4", mode: "monologue" });

    const idx = await readIndex();
    assert.equal(idx.entries.length, 2, "same clip replaced, distinct clip appended");
    const pod = idx.entries.find((e) => e.clip === "podcast-480p-seg1.mp4");
    assert.equal(pod?.bytes, 200, "latest write wins");
    // Sorted by clip name.
    assert.deepEqual(idx.entries.map((e) => e.clip), ["monologue-480p-seg1.mp4", "podcast-480p-seg1.mp4"]);
    // Persisted to <dir>/index.json.
    assert.ok((await fs.stat(indexPath())).isFile());
  } finally {
    restore("HARNESS_AVATAR_LIBRARY_DIR", prev);
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("findCachedClip resolves library name first, then legacy hash fallback, else null", async () => {
  const prev = process.env.HARNESS_AVATAR_LIBRARY_DIR;
  const libDir = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-lib-"));
  const legacyDir = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-legacy-"));
  const imgPath = path.join(legacyDir, "img.png");
  try {
    process.env.HARNESS_AVATAR_LIBRARY_DIR = libDir;
    const prompt = defaultAvatarPrompt("podcast");

    // 1. Total miss → null.
    assert.equal(await findCachedClip({ mode: "podcast", resolution: "480p", segments: 1, prompt }), null);

    // 2. Legacy fallback: image present + legacy file at the hashed key.
    await fs.writeFile(imgPath, "IMG_BYTES");
    const key = await legacyCacheKey(imgPath, "480p", 1, prompt);
    await fs.writeFile(path.join(legacyDir, `${key}.mp4`), "LEGACY");
    const legacyHit = await findCachedClip({ mode: "podcast", resolution: "480p", segments: 1, prompt, imagePath: imgPath, legacyCacheDir: legacyDir });
    assert.equal(legacyHit?.source, "legacy");

    // 3. Canonical library name takes precedence over legacy.
    await fs.writeFile(path.join(libDir, "podcast-480p-seg1.mp4"), "LIB");
    const libHit = await findCachedClip({ mode: "podcast", resolution: "480p", segments: 1, prompt, imagePath: imgPath, legacyCacheDir: legacyDir });
    assert.equal(libHit?.source, "library");
    assert.equal(libHit?.path, path.join(libDir, "podcast-480p-seg1.mp4"));
  } finally {
    restore("HARNESS_AVATAR_LIBRARY_DIR", prev);
    await fs.rm(libDir, { recursive: true, force: true });
    await fs.rm(legacyDir, { recursive: true, force: true });
  }
});
