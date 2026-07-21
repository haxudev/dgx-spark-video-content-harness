import { z } from "zod";

export const WordBoundarySchema = z.object({
  text: z.string(),
  offsetMs: z.number(),
  durMs: z.number(),
});
export type WordBoundary = z.infer<typeof WordBoundarySchema>;

export const AudioLineSchema = z.object({
  id: z.string(),                       // matches DialogueLine.id
  sceneId: z.string(),
  speaker: z.enum(["Anchor", "Analyst", "Narrator"]),
  wavPath: z.string(),                  // relative to manifest dir
  startSec: z.number(),                 // absolute start in final video
  durSec: z.number(),                   // measured
  trackIndex: z.literal(0).or(z.literal(1)), // 0=Anchor, 1=Analyst/Narrator
  boundaries: z.array(WordBoundarySchema).default([]),
  cacheHit: z.boolean().default(false),
  provider: z.enum(["qwen", "azure", "stub"]).optional(),
});
export type AudioLine = z.infer<typeof AudioLineSchema>;

export const AudioSceneSchema = z.object({
  sceneId: z.string(),
  startSec: z.number(),
  endSec: z.number(),
  durSec: z.number(),
  lineIds: z.array(z.string()),
});
export type AudioScene = z.infer<typeof AudioSceneSchema>;

export const AudioManifestSchema = z.object({
  matchId: z.string(),
  totalSec: z.number(),
  sampleRate: z.number().default(24000),
  channels: z.number().default(1),
  lines: z.array(AudioLineSchema),
  scenes: z.array(AudioSceneSchema),
  interLineGapMs: z.number().default(150),
  interSpeakerGapMs: z.number().default(250),
  dialogueHash: z.string().optional(),
  provider: z.enum(["qwen", "azure", "stub", "mixed"]).optional(),
  voices: z.record(z.string()).optional(),
  createdAt: z.string(),
});
export type AudioManifest = z.infer<typeof AudioManifestSchema>;
