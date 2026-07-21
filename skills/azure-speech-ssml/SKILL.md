---
name: azure-speech-ssml
description: |
  SSML cookbook for Azure Neural TTS (zh-CN). Voice selection, express-as
  styles, break / prosody templates, char→sec math, and word-boundary
  collection for word-level subtitle timing.
---

# azure-speech-ssml

## Voice map (this project)

| Role     | Voice                       | Style                | Rate | Pitch  | When to use                                  |
|----------|-----------------------------|----------------------|------|--------|----------------------------------------------|
| Anchor   | `zh-CN-XiaoxiaoNeural`      | `chat` deg 1.2       | +5%  | +1st   | 提问、引导、收束                              |
| Analyst  | `zh-CN-YunxiNeural`         | `narration-relaxed`  | +2%  | +0st   | 数据解读、策略描述、长句                      |

Substitutions allowed: `zh-CN-XiaoyiNeural` (warmer Anchor), `zh-CN-YunjianNeural`
(sportscaster Analyst). Update `tools/ssml.ts#VOICE` and `tts-cache` invalidates
automatically.

## Char → seconds estimation

Chinese mainland TTS averages **4.2 chars/sec** at default rate, including
punctuation pauses. Latin chars count as 0.5. With micro-breaks injected at
"、"(120ms) "，"(160ms) "；"(220ms) "。！？"(280ms), real-world deviation
is typically ±8%.

## SSML template (per line)

```xml
<speak version="1.0"
       xmlns="http://www.w3.org/2001/10/synthesis"
       xmlns:mstts="http://www.w3.org/2001/mstts"
       xml:lang="zh-CN">
  <voice name="zh-CN-XiaoxiaoNeural">
    <mstts:express-as style="chat" styledegree="1.2">
      <prosody rate="+5%" pitch="+1st">
        这场比赛，<break time="160ms"/>赛前有哪些变量？
      </prosody>
    </mstts:express-as>
  </voice>
</speak>
```

## Knobs (when to twist what)

- **Scene drift > 8% long**: lower `prosody.rate` by 5% (`+5%` → `+0%`).
- **Scene drift > 8% short**: raise rate by 5% (`+5%` → `+10%`); cap at `+20%`.
- **Dry / monotone**: bump styledegree (1.2 → 1.6).
- **Compliance scene gravity**: switch Analyst express-as to `serious`.
- **Emphasis**: wrap key 词 in `<emphasis level="strong">关键词</emphasis>`.

## Word-boundary collection (subtitle timing)

```ts
const synth = new SpeechSynthesizer(cfg, AudioConfig.fromAudioFileOutput(out));
const boundaries: { text: string; offsetMs: number; durMs: number }[] = [];
synth.wordBoundary = (_s, e) => boundaries.push({
  text: e.text,
  offsetMs: Number(e.audioOffset) / 10_000,
  durMs:    Number(e.duration)    / 10_000,
});
```

Boundaries drive `subtitles.vtt` word-level grouping (default 3 chars/cue).

## Audio format

PCM 24kHz mono 16-bit Riff WAV (`SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm`).
Read duration deterministically from RIFF header without ffprobe.

## Cache key

`sha256(voice + "\u241f" + ssml)`. Bumping voice list / prosody defaults
invalidates only the affected lines.
