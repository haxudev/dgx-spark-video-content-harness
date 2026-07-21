import * as path from "node:path";
import * as crypto from "node:crypto";
import pLimit from "p-limit";
import { readJson, writeJson, type RunContext } from "../orchestrator/runContext.js";
import type { Issue } from "../orchestrator/supervisor.js";
import type { RunState } from "../orchestrator/stateMachine.js";
import type { DialogueFile, DialogueLine } from "../schemas/dialogue.js";
import {
  AudioManifestSchema,
  type AudioLine,
  type AudioManifest,
  type AudioScene,
} from "../schemas/audioManifest.js";
import { synthLine, wavDurationSec, activeTTSProvider, voicesForProvider, type TTSProvider } from "../tools/azureSpeech.js";
import { VOICE } from "../tools/ssml.js";
import { ttsParallel } from "../tools/runProfile.js";

const INTER_LINE_GAP_MS = 150;
const INTER_SPEAKER_GAP_MS = 250;

export const tts = async (
  ctx: RunContext,
  state: RunState,
  _priorIssues: Issue[],
): Promise<{ ok: boolean; issues?: Issue[] }> => {
  const dlg = await readJson<DialogueFile>(ctx.paths.dialogue);
  const provider = activeTTSProvider();
  const reuse = await tryReuseManifest(ctx, dlg, provider);
  if (reuse) {
    state.ttsCacheHits = reuse.lines.length;
    state.ttsCacheMisses = 0;
    return { ok: true, issues: provider === "stub" ? [stubIssue(reuse.lines.length, reuse.lines.length)] : [] };
  }

  const parallel = ttsParallel();
  const limit = pLimit(parallel);
  const cacheDir = path.join(ctx.cacheDir, "tts");

  // Synth in parallel pool
  const lineMap = new Map<string, AudioLine>();
  const actualProviders = new Set<TTSProvider>();
  await Promise.all(dlg.scenes.flatMap(sd =>
    sd.lines.map((l) => limit(async () => {
      const voice = VOICE[l.speaker];
      const out = path.join(ctx.paths.audioDir, `${l.id}.wav`);
      const res = await synthLine({ ssml: l.ssml, voice, text: l.text, speaker: l.speaker, outPath: out }, cacheDir);
      actualProviders.add(res.provider);
      const measured = await wavDurationSec(out);
      const durSec = Number.isFinite(measured) ? measured : res.durSec;

      lineMap.set(l.id, {
        id: l.id,
        sceneId: l.sceneId,
        speaker: l.speaker,
        wavPath: path.relative(path.dirname(ctx.paths.audioManifest), out),
        startSec: 0,           // populated below
        durSec: round(durSec, 3),
        trackIndex: l.speaker === "Anchor" ? 0 : 1,
        boundaries: res.boundaries,
        cacheHit: res.cacheHit,
        provider: res.provider,
      });
    })),
  ));
  const manifestProvider = actualProviders.size === 1 ? [...actualProviders][0] : "mixed";

  // Build linear timeline scene-by-scene
  const lines: AudioLine[] = [];
  const scenes: AudioScene[] = [];
  let cursor = 0;

  for (const sd of dlg.scenes) {
    const sceneStart = cursor;
    const lineIds: string[] = [];
    let prevSpeaker: AudioLine["speaker"] | null = null;
    for (const l of sd.lines) {
      const al = lineMap.get(l.id);
      if (!al) continue;
      if (prevSpeaker !== null) {
        const gapMs = prevSpeaker === al.speaker ? INTER_LINE_GAP_MS : INTER_SPEAKER_GAP_MS;
        cursor += gapMs / 1000;
      }
      al.startSec = round(cursor, 3);
      cursor += al.durSec;
      prevSpeaker = al.speaker;
      lines.push(al);
      lineIds.push(al.id);
    }
    scenes.push({
      sceneId: sd.sceneId,
      startSec: round(sceneStart, 3),
      endSec: round(cursor, 3),
      durSec: round(cursor - sceneStart, 3),
      lineIds,
    });
    // Inter-scene padding
    cursor += 0.3;
  }
  // Remove trailing inter-scene gap from total
  const totalSec = round(cursor - 0.3, 3);

  const manifest: AudioManifest = AudioManifestSchema.parse({
    matchId: dlg.matchId,
    totalSec,
    sampleRate: 24000,
    channels: 1,
    lines,
    scenes,
    interLineGapMs: INTER_LINE_GAP_MS,
    interSpeakerGapMs: INTER_SPEAKER_GAP_MS,
    createdAt: new Date().toISOString(),
    dialogueHash: dialogueHash(dlg),
    provider: manifestProvider,
    voices: voicesForProvider(manifestProvider === "mixed" ? activeTTSProvider() : manifestProvider),
  });

  await writeJson(ctx.paths.audioManifest, manifest);

  const cacheHits = lines.filter(l => l.cacheHit).length;
  state.ttsCacheHits = cacheHits;
  state.ttsCacheMisses = lines.length - cacheHits;
  const issues: Issue[] = [];
  if (actualProviders.has("stub")) {
    issues.push(stubIssue(lines.length, cacheHits));
  }
  return { ok: true, issues };
};

function round(x: number, p: number): number {
  const f = Math.pow(10, p);
  return Math.round(x * f) / f;
}

async function tryReuseManifest(ctx: RunContext, dlg: DialogueFile, provider: TTSProvider): Promise<AudioManifest | null> {
  try {
    const existing = await readJson<AudioManifest & { dialogueHash?: string; provider?: string; voices?: typeof VOICE }>(ctx.paths.audioManifest);
    if (existing.dialogueHash !== dialogueHash(dlg)) return null;
    if (existing.provider !== provider) return null;
    if (JSON.stringify(existing.voices ?? {}) !== JSON.stringify(voicesForProvider(provider))) return null;
    for (const line of existing.lines) {
      const wav = path.resolve(path.dirname(ctx.paths.audioManifest), line.wavPath);
      const measured = await wavDurationSec(wav);
      if (!Number.isFinite(measured) || measured <= 0) return null;
    }
    return existing;
  } catch {
    return null;
  }
}

function dialogueHash(dlg: DialogueFile): string {
  return crypto.createHash("sha256").update(JSON.stringify({
    matchId: dlg.matchId,
    scenes: dlg.scenes.map(s => ({
      sceneId: s.sceneId,
      lines: s.lines.map(l => ({ id: l.id, speaker: l.speaker, text: l.text, ssml: l.ssml })),
    })),
  })).digest("hex");
}

function stubIssue(lineCount: number, cacheHits: number): Issue {
  return {
    kind: "tts-using-stub",
    severity: "warn",
    message: `No TTS provider configured — used sine-wave stub for ${lineCount} lines (cache hits: ${cacheHits})`,
  };
}
