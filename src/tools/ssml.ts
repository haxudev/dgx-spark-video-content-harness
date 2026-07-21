/**
 * Azure Neural TTS voices for the two podcast hosts. The internal SpeakerName
 * key (Anchor / Analyst) stays stable so the rest of the codebase doesn't need
 * a rename — these values are the Azure neural voice names used directly in the
 * generated SSML.
 */
export const VOICE = {
  Anchor:  process.env.AZURE_VOICE_FEMALE?.trim() || "zh-CN-XiaoxiaoNeural",
  Analyst: process.env.AZURE_VOICE_MALE?.trim()   || "zh-CN-YunxiNeural",
  // Single-host monologue narrator (解局人). Deep, resonant male voice for the
  // 阴谋论式解局 gravitas, with a mild (−1st) pitch drop. Override with
  // AZURE_VOICE_NARRATOR.
  Narrator: process.env.AZURE_VOICE_NARRATOR?.trim() || "zh-CN-YunjianNeural",
} as const;

/** Human-readable display name used in captions and slate overlays. */
export const SPEAKER_DISPLAY = {
  Anchor:  "小美",
  Analyst: "小帅",
  Narrator: process.env.NARRATOR_DISPLAY_NAME?.trim() || "解局人",
} as const;

export type SpeakerName = keyof typeof VOICE;

const STYLE: Record<SpeakerName, { style: string; degree: string; rate: string; pitch: string }> = {
  Anchor:  { style: "chat",              degree: "1.2", rate: "+5%",  pitch: "+1st" },
  Analyst: { style: "narration-relaxed", degree: "1.0", rate: "+2%",  pitch: "+0st" },
  // Resonant, confiding "解局" cadence — mild −1st pitch drop (not the heavier −2st).
  Narrator:{ style: "narration-relaxed", degree: "1.05", rate: "+0%", pitch: "-1st" },
};

const CPS_DEFAULT = 3.0;

/**
 * Wrap a single line of plain Chinese text in SSML for Azure Neural TTS.
 * - chat / narration-relaxed express-as for variety between hosts
 * - mild prosody tuning per speaker
 * - automatic <break> insertion at 中文 punctuation for natural pacing
 */
export function lineToSsml(text: string, speaker: SpeakerName, opts: { rateOverride?: string } = {}): string {
  const voice = VOICE[speaker];
  const s = STYLE[speaker];
  const rate = opts.rateOverride ?? s.rate;

  // Insert micro-breaks at 句中 punctuation to give natural pauses.
  const body = text
    .replace(/、/g, '、<break time="120ms"/>')
    .replace(/，/g, '，<break time="160ms"/>')
    .replace(/；/g, '；<break time="220ms"/>')
    .replace(/。/g, '。<break time="280ms"/>')
    .replace(/！/g, '！<break time="280ms"/>')
    .replace(/？/g, '？<break time="280ms"/>');

  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="http://www.w3.org/2001/mstts" xml:lang="zh-CN">
  <voice name="${voice}">
    <mstts:express-as style="${s.style}" styledegree="${s.degree}">
      <prosody rate="${rate}" pitch="${s.pitch}">${escapeXml(body)}</prosody>
    </mstts:express-as>
  </voice>
</speak>`;
}

export function estimateLineDuration(text: string, cps: number = CPS_DEFAULT): number {
  let n = 0;
  for (const ch of text) {
    if (/[\u4e00-\u9fff]/.test(ch)) n += 1;
    else if (/[A-Za-z0-9]/.test(ch)) n += 0.5;
  }
  return Math.round((n / cps) * 100) / 100;
}

function escapeXml(s: string): string {
  // We've already inserted <break> tags — those literal "<break …/>" must survive.
  // Strategy: protect breaks, escape rest, restore breaks.
  const parts: string[] = [];
  const re = /<break\s+time="\d+ms"\/>/g;
  let last = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    parts.push(escapeBasic(s.slice(last, m.index)), m[0]);
    last = m.index + m[0].length;
  }
  parts.push(escapeBasic(s.slice(last)));
  return parts.join("");
}

function escapeBasic(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
