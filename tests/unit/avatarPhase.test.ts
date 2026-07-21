import { test } from "node:test";
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { buildRunContext } from "../../src/orchestrator/runContext.js";
import { createRunState } from "../../src/orchestrator/stateMachine.js";
import { avatar } from "../../src/phases/06b-avatar.js";
import { libraryClipName, activeAvatarPrompt } from "../../src/tools/avatarLibrary.js";
import { scriptMode, avatarResolution, avatarSegments } from "../../src/tools/runProfile.js";

const ENV_KEYS = [
  "LONGCAT_AVATAR_BASE_URL",
  "HARNESS_SKIP_AVATAR",
  "HARNESS_REQUIRE_AVATAR",
  "HARNESS_AVATAR_LIBRARY_DIR",
  "HARNESS_AVATAR_IMAGE",
  "HARNESS_AVATAR_PROMPT",
  "HARNESS_SCRIPT_MODE",
  "HARNESS_AVATAR_RESOLUTION",
  "HARNESS_AVATAR_SEGMENTS",
];

async function withEnv(overrides: Record<string, string | undefined>, body: (root: string, libDir: string) => Promise<void>) {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-phase-"));
  const libDir = await fs.mkdtemp(path.join(os.tmpdir(), "avatar-lib-"));
  // Clean slate, then apply overrides.
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.HARNESS_AVATAR_LIBRARY_DIR = libDir;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  // The phase must never hit the network — make fetch explode if it tries.
  const realFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls++;
    throw new Error("network call attempted in cache-only AVATAR phase");
  }) as typeof fetch;
  try {
    await body(root, libDir);
    assert.equal(fetchCalls, 0, "AVATAR phase must not make any network call");
  } finally {
    globalThis.fetch = realFetch;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(libDir, { recursive: true, force: true });
  }
}

function expectedClipName(): string {
  const mode = scriptMode();
  return libraryClipName(mode, avatarResolution(), avatarSegments(), activeAvatarPrompt(mode));
}

test("AVATAR consumes a library clip on a hit (no network, even with LONGCAT unset)", async () => {
  await withEnv({ LONGCAT_AVATAR_BASE_URL: undefined }, async (root, libDir) => {
    // Seed the library with the expected canonical clip.
    await fs.writeFile(path.join(libDir, expectedClipName()), "FAKE_MP4_BYTES");

    const ctx = await buildRunContext(path.join(root, "20260101", "demo.html"), root);
    const state = createRunState(ctx.matchId, ctx.reportPath);

    const res = await avatar(ctx, state, []);
    assert.equal(res.ok, true);
    assert.ok(!res.issues?.some((i) => i.severity === "error"));

    // The clip was copied to composition/avatar.mp4.
    const copied = await fs.readFile(ctx.paths.avatarMp4, "utf8");
    assert.equal(copied, "FAKE_MP4_BYTES");

    const verify = JSON.parse(await fs.readFile(path.join(ctx.paths.verifyDir, "avatar.json"), "utf8"));
    assert.equal(verify.cacheHit, true);
    assert.equal(verify.generated, false);
    assert.equal(verify.cacheOnly, true);
    assert.equal(verify.source, "library");
  });
});

test("AVATAR degrades gracefully on a cache miss (WARN, ships placeholder, no network)", async () => {
  await withEnv(
    { LONGCAT_AVATAR_BASE_URL: "http://example.invalid:8800", HARNESS_AVATAR_IMAGE: "/no/such/image.png" },
    async (root) => {
      const ctx = await buildRunContext(path.join(root, "20260101", "demo.html"), root);
      const state = createRunState(ctx.matchId, ctx.reportPath);

      const res = await avatar(ctx, state, []);
      assert.equal(res.ok, true, "a miss must not fail the pipeline by default");
      const miss = res.issues?.find((i) => i.kind === "avatar-cache-miss");
      assert.ok(miss, "must emit avatar-cache-miss");
      assert.equal(miss?.severity, "warn");
      assert.match(miss!.message, /avatar-prewarm/);

      await assert.rejects(fs.stat(ctx.paths.avatarMp4), "no avatar.mp4 on a miss");
      const verify = JSON.parse(await fs.readFile(path.join(ctx.paths.verifyDir, "avatar.json"), "utf8"));
      assert.equal(verify.skipped, true);
      assert.equal(verify.reason, "cache-miss");
    },
  );
});

test("AVATAR cache miss is a hard error when HARNESS_REQUIRE_AVATAR=1", async () => {
  await withEnv(
    { HARNESS_REQUIRE_AVATAR: "1", HARNESS_AVATAR_IMAGE: "/no/such/image.png" },
    async (root) => {
      const ctx = await buildRunContext(path.join(root, "20260101", "demo.html"), root);
      const state = createRunState(ctx.matchId, ctx.reportPath);

      const res = await avatar(ctx, state, []);
      assert.equal(res.ok, false, "required avatar must fail the pipeline on a miss");
      const miss = res.issues?.find((i) => i.kind === "avatar-cache-miss");
      assert.equal(miss?.severity, "error");
    },
  );
});

test("AVATAR skips cleanly when HARNESS_SKIP_AVATAR=1", async () => {
  await withEnv({ HARNESS_SKIP_AVATAR: "1" }, async (root) => {
    const ctx = await buildRunContext(path.join(root, "20260101", "demo.html"), root);
    const state = createRunState(ctx.matchId, ctx.reportPath);

    const res = await avatar(ctx, state, []);
    assert.equal(res.ok, true);
    assert.ok(res.issues?.some((i) => i.kind === "avatar-disabled" && i.severity === "warn"));

    const verify = JSON.parse(await fs.readFile(path.join(ctx.paths.verifyDir, "avatar.json"), "utf8"));
    assert.equal(verify.skipped, true);
    assert.equal(verify.reason, "disabled");
  });
});

test("AVATAR phase source never references longcat generation (compile-time guarantee)", async () => {
  const src = await fs.readFile(path.resolve("src/phases/06b-avatar.ts"), "utf8");
  for (const banned of ["submitAvatarJob", "pollJob", "downloadVideo", "/generate", "avatarGenerate", "prewarmAvatarClip"]) {
    assert.ok(!src.includes(banned), `AVATAR phase must not reference '${banned}' (cache-only)`);
  }
});
