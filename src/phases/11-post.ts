import * as fs from "node:fs/promises";
import * as crypto from "node:crypto";
import * as path from "node:path";
import type { RunContext } from "../orchestrator/runContext.js";
import { readJson, writeJson } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import type { AudioManifest } from "../schemas/audioManifest.js";
import type { DialogueFile } from "../schemas/dialogue.js";
import type { TalkPlan } from "../schemas/talkPlan.js";
import type { BlocksFile } from "../schemas/block.js";
import { compliancePhrasesByPlacement } from "../tools/configLoader.js";
import { VOICE } from "../tools/ssml.js";
import { activeTTSProvider } from "../tools/azureSpeech.js";
import { activeLLMProvider } from "../tools/llmClient.js";
import { COMPLIANCE_POLICY, uniqueRestrictedTerms } from "../tools/compliancePolicy.js";
import { activeHarnessProfile, renderFps, renderQuality, ttsParallel, writeParallel } from "../tools/runProfile.js";

/**
 * POST — emit delivery manifest, compliance audit, thumbnail (best-effort).
 * Idempotent and safe to re-run.
 */
export const post = async (
  ctx: RunContext,
  _state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const issues: Issue[] = [];

  const blocks = await readJson<BlocksFile>(ctx.paths.blocks);
  const plan = await readJson<TalkPlan>(ctx.paths.talkPlan);
  const dlg = await readJson<DialogueFile>(ctx.paths.dialogue);
  const mani = await readJson<AudioManifest>(ctx.paths.audioManifest);

  // Hashes for audit
  const sha = async (p: string) => {
    try {
      const buf = await fs.readFile(p);
      return crypto.createHash("sha256").update(buf).digest("hex");
    } catch { return null; }
  };
  const artifactHashes = {
    blocks:          await sha(ctx.paths.blocks),
    talkPlan:        await sha(ctx.paths.talkPlan),
    dialogue:        await sha(ctx.paths.dialogue),
    audioManifest:   await sha(ctx.paths.audioManifest),
    compositionHtml: await sha(ctx.paths.compositionHtml),
    subtitles:       await sha(ctx.paths.subtitles),
    talkTrackAudit:  await sha(`${ctx.paths.verifyDir}/talk-track-audit.json`),
    visualFrameAudit: await sha(`${ctx.paths.verifyDir}/visual-frame-audit.json`),
    finalMp4:        await sha(ctx.paths.finalMp4),
  };

  // Compliance audit: where do required phrases appear in dialogue?
  const open = compliancePhrasesByPlacement("opening");
  const close = compliancePhrasesByPlacement("closing");
  const findPhrase = (kw: string[]) => {
    const hits: { sceneId: string; lineId: string; startSec: number; durSec: number }[] = [];
    for (const sd of dlg.scenes) {
      for (const l of sd.lines) {
        if (kw.every(k => l.text.includes(k))) {
          const al = mani.lines.find(a => a.id === l.id);
          if (al) hits.push({ sceneId: sd.sceneId, lineId: l.id, startSec: al.startSec, durSec: al.durSec });
        }
      }
    }
    return hits;
  };

  const audit = {
    matchId: plan.matchId,
    totalSec: mani.totalSec,
    policyMentionCount: dlg.scenes.flatMap(s => s.lines).filter(l => /赛前概率观察|体育数据讨论/.test(l.text)).length,
    compliancePolicy: COMPLIANCE_POLICY.version,
    restrictedTerms: uniqueRestrictedTerms(dlg.scenes.flatMap(s => s.lines).map(l => l.text).join(" ")),
    opening: open.map(p => ({ id: p.id, text: p.text, hits: findPhrase(p.keywords ?? [p.text]) })),
    closing: close.map(p => ({ id: p.id, text: p.text, hits: findPhrase(p.keywords ?? [p.text]) })),
    auditAt: new Date().toISOString(),
  };
  await writeJson(ctx.paths.complianceAudit, audit);

  // Verify each required phrase actually appears
  for (const p of [...open, ...close]) {
    const hits = findPhrase(p.keywords ?? [p.text]);
    if (hits.length === 0) issues.push({
      kind: "post-compliance-missing",
      severity: "error",
      message: `Required compliance phrase '${p.id}' never spoken: ${p.text}`,
    });
  }
  if (audit.restrictedTerms.length > 0) issues.push({
    kind: "post-restricted-compliance-terms",
    severity: "error",
    message: `restricted ${COMPLIANCE_POLICY.version} terms found: ${audit.restrictedTerms.join(", ")}`,
    data: audit.restrictedTerms,
  });

  // Thumbnail (best-effort: ffmpeg from final.mp4 if present; else skip)
  try {
    await fs.stat(ctx.paths.finalMp4);
    // Best-effort; ignore errors
    await spawnAsync("ffmpeg", ["-y", "-ss", "1.5", "-i", ctx.paths.finalMp4, "-frames:v", "1", ctx.paths.thumbnail]);
  } catch {}

  const deliveryManifest = {
    matchId: plan.matchId,
    reportPath: ctx.reportPath,
    sceneCount: plan.scenes.length,
    totalSec: mani.totalSec,
    lineCount: mani.lines.length,
    artifactHashes,
    artifacts: {
      blocks: rel(ctx, ctx.paths.blocks),
      talkPlan: rel(ctx, ctx.paths.talkPlan),
      dialogue: rel(ctx, ctx.paths.dialogue),
      audioManifest: rel(ctx, ctx.paths.audioManifest),
      compositionHtml: rel(ctx, ctx.paths.compositionHtml),
      subtitles: rel(ctx, ctx.paths.subtitles),
      finalMp4: rel(ctx, ctx.paths.finalMp4),
      thumbnail: rel(ctx, ctx.paths.thumbnail),
      complianceAudit: rel(ctx, ctx.paths.complianceAudit),
      talkTrackAudit: rel(ctx, `${ctx.paths.verifyDir}/talk-track-audit.json`),
      visualFrameAudit: rel(ctx, `${ctx.paths.verifyDir}/visual-frame-audit.json`),
    },
    versions: {
      harness: "0.1.0",
      voices: { Anchor: VOICE.Anchor, Analyst: VOICE.Analyst, Narrator: VOICE.Narrator },
      ttsBackend: mani.provider ?? activeTTSProvider(),
      llmBackend: activeLLMProvider(),
      profile: activeHarnessProfile(),
      renderFps: renderFps(),
      renderQuality: renderQuality(),
      ttsParallel: ttsParallel(),
      writeParallel: writeParallel(),
      visualAuditLLM: process.env.HARNESS_VISUAL_AUDIT_LLM === "1",
    },
    generatedAt: new Date().toISOString(),
  };
  await writeJson(ctx.paths.deliveryManifest, deliveryManifest);

  return { ok: !issues.some(i => i.severity === "error"), issues };
};

function rel(ctx: RunContext, p: string): string {
  return path.relative(ctx.workDir, p);
}

import { spawn } from "node:child_process";
function spawnAsync(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: "ignore" });
    p.on("error", rej);
    p.on("exit", () => res());
  });
}
