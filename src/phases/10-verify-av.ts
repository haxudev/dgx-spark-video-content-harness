import * as fs from "node:fs/promises";
import { spawn } from "node:child_process";
import type { RunContext } from "../orchestrator/runContext.js";
import { readJson, writeJson } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import type { AudioManifest } from "../schemas/audioManifest.js";

/**
 * VERIFY_AV — ensures the rendered MP4 (if present) matches AudioManifest timing.
 *
 * If no MP4 was rendered (RENDER skipped), report a single 'render-skipped' info
 * note and pass; downstream POST will mirror that.
 */
export const verifyAv = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const mani = await readJson<AudioManifest>(ctx.paths.audioManifest);
  const issues: Issue[] = [];

  let mp4Exists = false;
  try { await fs.stat(ctx.paths.finalMp4); mp4Exists = true; } catch {}

  if (!mp4Exists) {
    issues.push({
      kind: "verify-av-skipped-no-mp4",
      severity: "warn",
      message: `final.mp4 not present (render skipped); AV sync verification deferred`,
    });
    await writeJson(`${ctx.paths.verifyDir}/verify-av.json`, {
      ok: true, mp4Exists: false, issues, at: new Date().toISOString(),
    });
    return { ok: true, issues };
  }

  // ffprobe duration
  const probed = await ffprobeDurationSec(ctx.paths.finalMp4);
  const tolerance = 0.5; // half second
  const drift = Math.abs(probed - mani.totalSec);
  if (drift > tolerance) issues.push({
    kind: "verify-av-duration-drift",
    severity: "error",
    message: `mp4 duration ${probed.toFixed(2)}s vs manifest ${mani.totalSec.toFixed(2)}s (drift ${drift.toFixed(2)}s > ${tolerance}s)`,
  });

  await writeJson(`${ctx.paths.verifyDir}/verify-av.json`, {
    ok: !issues.some(i => i.severity === "error"),
    mp4Exists, mp4DurationSec: probed, manifestTotalSec: mani.totalSec,
    issues, at: new Date().toISOString(),
  });
  return { ok: !issues.some(i => i.severity === "error"), issues };
};

async function ffprobeDurationSec(file: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    let out = "";
    p.stdout.on("data", d => out += d.toString());
    p.on("error", reject);
    p.on("exit", () => resolve(parseFloat(out.trim())));
  });
}
