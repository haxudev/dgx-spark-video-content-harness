import { readJson, writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import type { AudioManifest } from "../schemas/audioManifest.js";
import type { TalkPlan } from "../schemas/talkPlan.js";

const SCENE_TOL = 0.08;     // 8% drift triggers re-TTS suggestion

export const verifyAudio = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const plan = await readJson<TalkPlan>(ctx.paths.talkPlan);
  const mani = await readJson<AudioManifest>(ctx.paths.audioManifest);

  const issues: Issue[] = [];

  // Total duration sanity
  if (mani.totalSec < 150) issues.push({
    kind: "audio-total-too-short", severity: "warn",
    message: `total audio ${mani.totalSec}s < 150s`,
  });
  if (mani.totalSec > 380) issues.push({
    kind: "audio-total-too-long", severity: "warn",
    message: `total audio ${mani.totalSec}s > 380s`,
  });

  // Per-scene drift
  for (const sc of plan.scenes) {
    const a = mani.scenes.find(s => s.sceneId === sc.id);
    if (!a) { issues.push({ kind: "audio-scene-missing", severity: "error", message: `audio missing for scene ${sc.id}` }); continue; }
    const drift = (a.durSec - sc.targetSec) / sc.targetSec;
    if (Math.abs(drift) > SCENE_TOL) {
      issues.push({
        kind: "audio-scene-drift", severity: "warn",
        message: `scene ${sc.id} audio ${a.durSec.toFixed(2)}s vs target ${sc.targetSec}s (drift ${(drift * 100).toFixed(1)}%)`,
      });
    }
  }

  // Continuity: each scene end should be ≤ next scene start (with up to 0.4s inter-scene gap allowed)
  for (let i = 1; i < mani.scenes.length; i++) {
    const prev = mani.scenes[i - 1]!;
    const cur = mani.scenes[i]!;
    if (cur.startSec < prev.endSec) {
      issues.push({
        kind: "audio-overlap", severity: "error",
        message: `scene ${cur.sceneId} starts at ${cur.startSec} before previous end ${prev.endSec}`,
      });
    }
    if (cur.startSec - prev.endSec > 0.6) {
      issues.push({
        kind: "audio-gap-too-large", severity: "warn",
        message: `gap between ${prev.sceneId} and ${cur.sceneId} = ${(cur.startSec - prev.endSec).toFixed(2)}s`,
      });
    }
  }

  await writeJson(`${ctx.paths.verifyDir}/verify-audio.json`, {
    ok: !issues.some(i => i.severity === "error"),
    totalSec: mani.totalSec,
    sceneCount: mani.scenes.length,
    lineCount: mani.lines.length,
    issues,
    at: new Date().toISOString(),
  });

  return { ok: !issues.some(i => i.severity === "error"), issues };
};
