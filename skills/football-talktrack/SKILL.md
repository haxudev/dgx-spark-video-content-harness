---
name: football-talktrack
description: |
  Authors the Chinese spoken script for football data-observation videos in the
  match-insight-harness harness WRITE phase. v2 is AGENT-FIRST: a single LLM call
  freely writes the whole conclusion-first four-act script per match (podcast
  dual-host OR monologue single-host); a deterministic template is only the
  offline / LLM-failure fallback. Structure-agnostic — driven by a market-
  derived brief, never hard-coded report sections.
---

# football-talktrack

## When to use

Invoked by the WRITE phase (`src/phases/03-write.ts`). Input is `talk-plan.json`
(four acts) + a probability-only `MarketData` brief (`marketExtractor`). Output is
`dialogue.json` (`SceneDialogue[]`, SSML-ready) with `mode` and `authoredBy`
stamped in.

## Authoring model (v2 — agent-first, READ THIS FIRST)

- **The agent (LLM) writes the script freely, per match.** One whole-script
  `chatJson` call authors all four acts from the brief. There is **no per-scene
  template** in the happy path — every opening, metaphor, hook and ordering is
  the model's own, seeded by a per-run `creativeSeed` so even a re-run of the
  same fixture yields a fresh take.
- **The deterministic generator is a fallback only** (`deterministicScript` /
  `deterministicMonologue` → `monologueActLines`). It produces a near-identical
  script every match (only team names / qualitative buckets change). It exists
  for offline tests (`HARNESS_DISABLE_LLM=1`) and as a last resort when every
  LLM attempt fails. **It is not the product** — if you hear the same script
  across different matches, the agent fell back; fix the provider, don't accept
  the template.
- **Transparency:** WRITE stamps `dialogue.json.authoredBy` = `"agent"` |
  `"deterministic"` and writes `verify/write.json` (`authoredBy`, `llmAvailable`,
  `creativeSeed`, `fallbackReason`). A fallback while the LLM was available
  raises a `write-agent-fallback` WARN in `state.json`.
- **Reliability knobs:** the agent call uses `retries: 2` (3 attempts) so a
  transient provider hiccup does not drop to the template. Pin the seed with
  `HARNESS_WRITE_SEED` for reproducible debugging.

## Two script modes

Selected by `HARNESS_SCRIPT_MODE` / `--mode`; stamped into `dialogue.json.mode`.

| Mode | Hosts | Voice | System prompt |
|---|---|---|---|
| `podcast` (default) | `Anchor` 小美 (女) + `Analyst` 小帅 (男) | 轻快双人对谈，结论先行 | `buildScriptSystemPrompt` |
| `monologue` | `Narrator` 解局人 (单人) | 第一人称「解局人」悬念口播（直白·球赛术语）：谁被当热门 → 数据更冷静 → 牌面很散 → 冷门会不会来 | `buildMonologueSystemPrompt` |

Both feed the same TTS → COMPOSE → RENDER tail. VERIFY_TEXT / AUDIT_TALK read
`mode` and skip the dual-host-only gates (双声道 cadence / speaker-balance /
both-speakers) in monologue mode; **every** compliance/banned/restricted/数据保真
gate stays active in both.

## Plain, story-driven, comprehensible (both modes)

The audience is **中学文化程度的普通球迷** — "一听就懂" is a hard rule. Metaphors
may only use **on-pitch football imagery / 球赛术语** (控球、反击、压迫、防线、体能、
主场氛围、伤病、板凳深度、纸面实力…). **Cross-domain / literary / abstract metaphors
are banned** — no 门缝 / 裂缝 / 风向暗线 / 脚下的纸 / 窗户纸 / 钥匙锁 / 棋局 / 电影 /
剧本 / 资本. Openings must be **direct** (say who's favored + the suspense in plain
words); no "这场像一部…/像两把钥匙…" cold opens. Self-check: if a metaphor needs a
second sentence to explain, drop it.

## Conclusion-first four acts

1. **结论先行** (hook / `cover-anime`): brand welcome (names「AI球赛观察」, varied
   each match) → headline takeaway (最被看好方+可能性、最可能比分、最可能球数、
   爆冷量级). **No opening compliance read-out** (compliance only closes Act 4).
2. **基本面 + 风向标** (`fundamentals-signal`): team strength + 市场隐含可能性
   vs 模型可能性 + 概率漂移. Probability-only.
3. **模型概率分布** (`market-grid`): 胜平负 / 总进球 / 比分 / 半全场.
4. **爆冷** (`upset-dashboard`): 爆冷可能性 + 主要驱动 + 潜在爆冷比分, then the
   closing compliance phrases land verbatim by keyword.

## Hard rules the agent must obey (enforced downstream)

1. **自由创作**：use `creativeSeed`; no fixed template / 口头禅 / 范文 句式; every
   match must sound bespoke. Variety comes from the match's **real story**, not
   from inventing new metaphors — reuse a clear plain phrasing before reaching
   for a novel image; never fall back to the deterministic stock lines.
2. **句长 ≤ 28 中文字**；每行落到完整句号/问号/感叹号.
3. **合规口径**：no lottery / betting / purchase / recommendation / odds / EV /
   庄家 / 抽水 / 金额 / 资金 / 资本 / 行动引导. "谁更被看好" is told as 球队热度 /
   外界看好 vs 数据更冷静 (probability mismatch only), **never money language**.
4. **closing 合规**：the last act recites every `config/compliance-phrases.yaml#closing`
   phrase by keyword (`repairCompliancePhrases` guarantees it if the agent drops one).
5. **无时间概念**：no calendar / clock / video-duration words (今晚/几点/北京时间/
   三分钟讲透/这期视频…). Refer to the match by team names. 「赛前」and in-match
   football time (上/下半场/补时/第X分钟/近五场/本赛季) are allowed.
6. **数据保真**：only numbers / teams / scorelines present in the brief; no
   invented model/algorithm names; don't exaggerate direction for drama.
7. **全中文 TTS**：digits / `%` / 比分 written as Chinese readings. Monologue is
   extra-strict: **少数字、多故事，禁止小数点** — translate magnitudes into words
   ("六成上下"、"勉强过半"、"几乎一边倒") instead of reciting percentages.
8. **节奏**：podcast alternates speakers (no ≥3 same-speaker run; Anchor 35–50%,
   ≥1 question per content act). Monologue is intentionally single-voice.

## Post-processing (deterministic, NOT creative templates)

These run on whatever the agent produced and are the compliance/quality
guarantees the verifiers depend on — keep them: glossary gloss, time-concept
strip, Chinese-number conversion, brand-welcome + compliance repair, cross-scene
dedup, dual-host cadence (podcast), char-floor top-up, and AV-sync-focused pacing.

## Config inputs

- `config/glossary.yaml` — terms rewritten to plain Chinese (no English/brackets).
- `config/banned-terms.yaml` — stripped from output.
- `config/compliance-phrases.yaml` — opening (podcast/legacy) + closing phrases.

## Output contract

`dialogue.json` per `src/schemas/dialogue.ts` — `{ matchId, mode, authoredBy,
scenes: SceneDialogue[], totalEstSec, totalChars, createdAt }`, each line
`{ id, sceneId, speaker, text, ssml, targetSec, estChars }`.
