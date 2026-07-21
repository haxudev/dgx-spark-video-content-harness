import * as fs from "node:fs/promises";
import { writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import { scriptMode, avatarImagePath, avatarResolution, avatarSegments } from "../tools/runProfile.js";
import { avatarBaseUrl, isAvatarCacheEnabled } from "../tools/avatarClient.js";
import { activeAvatarPrompt, findCachedClip } from "../tools/avatarLibrary.js";

/**
 * AVATAR phase — supply the bottom "presenter" digital-human clip by
 * **consuming the pre-generated material library ONLY**.
 *
 * Placement: after VERIFY_AUDIO, before COMPOSE. This phase performs NO network
 * calls and NEVER triggers a longcat generation job, so a normal `harness run`
 * can never pause the co-located qwen3.6 brain. New clips are produced out of
 * band by the explicit `harness avatar-prewarm` command, which persists them
 * into the version-controlled library at `assets/avatar-clips/`.
 *
 * Resolution (no GPU, no brain impact):
 *   - Look up the clip for (mode, resolution, segments, prompt) via
 *     `findCachedClip` — canonical library name first, legacy
 *     `out/_cache/avatar/<hash>.mp4` as a best-effort fallback.
 *   - HIT  → copy it to composition/avatar.mp4; RENDER ping-pong-loops it.
 *   - MISS → emit `avatar-cache-miss` and ship the framed placeholder band
 *            (WARN), unless HARNESS_REQUIRE_AVATAR=1 (then it's an error).
 *            The message points the operator at `harness avatar-prewarm`.
 */
export const avatar = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const issues: Issue[] = [];
  const mode = scriptMode();
  const required = process.env.HARNESS_REQUIRE_AVATAR === "1";
  const sev: Issue["severity"] = required ? "error" : "warn";

  const writeVerify = (obj: Record<string, unknown>) =>
    writeJson(`${ctx.paths.verifyDir}/avatar.json`, {
      mode,
      cacheOnly: true,
      enabled: isAvatarCacheEnabled(),
      baseUrl: avatarBaseUrl(),
      ...obj,
      at: new Date().toISOString(),
    });

  if (!isAvatarCacheEnabled()) {
    issues.push({
      kind: "avatar-disabled",
      severity: "warn",
      message: "HARNESS_SKIP_AVATAR=1 — avatar skipped (deck ships with framed placeholder)",
    });
    await writeVerify({ skipped: true, reason: "disabled", avatarMp4: null });
    return { ok: true, issues };
  }

  const imagePath = avatarImagePath(mode);
  const resolution = avatarResolution();
  const segments = avatarSegments();
  const prompt = activeAvatarPrompt(mode);

  // Pure cache lookup — never touches the network.
  const found = await findCachedClip({
    mode,
    resolution,
    segments,
    prompt,
    imagePath,
    legacyCacheDir: ctx.paths.avatarCacheDir,
  });

  if (found) {
    await fs.copyFile(found.path, ctx.paths.avatarMp4);
    console.log(`[avatar] cache hit (${found.source}) — reused pre-generated clip (no GPU, no brain impact)`);
    await writeVerify({
      cacheHit: true,
      generated: false,
      source: found.source,
      clip: found.path,
      resolution,
      segments,
      avatarMp4: ctx.paths.avatarMp4,
    });
    return { ok: true, issues };
  }

  // Miss: do NOT generate (that would pause qwen). Degrade gracefully.
  issues.push({
    kind: "avatar-cache-miss",
    severity: sev,
    message:
      `no pre-generated avatar clip for ${mode}/${resolution}/seg${segments} — shipping deck without talking head. ` +
      `Pre-generate it (pauses qwen ~10 min) with: harness avatar-prewarm --mode ${mode}` +
      (required ? "" : " (set HARNESS_REQUIRE_AVATAR=1 to make this a hard failure)"),
  });
  await writeVerify({ skipped: true, reason: "cache-miss", resolution, segments, avatarMp4: null });
  return { ok: !required, issues };
};
