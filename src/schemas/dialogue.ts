import { z } from "zod";

export const SpeakerSchema = z.enum(["Anchor", "Analyst", "Narrator"]);
export type Speaker = z.infer<typeof SpeakerSchema>;

export const DialogueLineSchema = z.object({
  id: z.string(),                          // "s01-l1"
  sceneId: z.string(),
  speaker: SpeakerSchema,
  text: z.string(),                        // plain text for verify + subtitles
  ssml: z.string(),                        // full <speak> SSML for Azure
  targetSec: z.number(),                   // estimated from chars (4.2 cps default)
  estChars: z.number().int(),
  notes: z.string().optional(),
});
export type DialogueLine = z.infer<typeof DialogueLineSchema>;

export const SceneDialogueSchema = z.object({
  sceneId: z.string(),
  lines: z.array(DialogueLineSchema).min(1),
});
export type SceneDialogue = z.infer<typeof SceneDialogueSchema>;

export const DialogueFileSchema = z.object({
  matchId: z.string(),
  mode: z.enum(["podcast", "monologue"]).default("podcast"),
  /** Who authored the script: the LLM agent (free per-match creation) or the
   *  deterministic offline-fallback template. Surfaces in verify/write.json so a
   *  silent fallback to the canned template is auditable. */
  authoredBy: z.enum(["agent", "deterministic"]).optional(),
  scenes: z.array(SceneDialogueSchema),
  totalEstSec: z.number(),
  totalChars: z.number().int(),
  createdAt: z.string(),
});
export type DialogueFile = z.infer<typeof DialogueFileSchema>;
