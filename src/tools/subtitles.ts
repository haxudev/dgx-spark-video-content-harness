import type { AudioManifest, AudioLine, WordBoundary } from "../schemas/audioManifest.js";
import type { DialogueFile, DialogueLine } from "../schemas/dialogue.js";

export interface SubtitleOpts {
  wordLevel?: boolean;
  wordsPerCue?: number;       // for word-level grouping
}

export function buildSubtitles(
  mani: AudioManifest,
  dlg: DialogueFile,
  opts: SubtitleOpts = {},
): string {
  const lineTextMap = new Map<string, DialogueLine>(
    dlg.scenes.flatMap(s => s.lines.map(l => [l.id, l] as const)),
  );
  const wordLevel = !!opts.wordLevel;
  const groupSize = opts.wordsPerCue ?? 3;

  const out: string[] = ["WEBVTT", ""];
  let cueIdx = 0;

  for (const al of mani.lines) {
    const line = lineTextMap.get(al.id);
    if (!line) continue;
    if (wordLevel && al.boundaries.length > 0) {
      // Group boundaries
      let i = 0;
      while (i < al.boundaries.length) {
        const slice = al.boundaries.slice(i, i + groupSize);
        const start = al.startSec + (slice[0]!.offsetMs / 1000);
        const last = slice[slice.length - 1]!;
        const end = al.startSec + (last.offsetMs + last.durMs) / 1000;
        const text = slice.map(b => b.text).join("");
        cueIdx += 1;
        out.push(String(cueIdx));
        out.push(`${ts(start)} --> ${ts(end)}`);
        out.push(`<v ${al.speaker}>${escapeVtt(text)}</v>`);
        out.push("");
        i += groupSize;
      }
    } else {
      cueIdx += 1;
      out.push(String(cueIdx));
      out.push(`${ts(al.startSec)} --> ${ts(al.startSec + al.durSec)}`);
      out.push(`<v ${al.speaker}>${escapeVtt(line.text)}</v>`);
      out.push("");
    }
  }
  return out.join("\n");
}

function ts(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.floor((sec - Math.floor(sec)) * 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}
function pad(n: number, w: number): string { return n.toString().padStart(w, "0"); }
function escapeVtt(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
