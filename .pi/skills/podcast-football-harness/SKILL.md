---
name: podcast-football-harness
description: Operate the podcast-football video pipeline from a minimal pi runtime without MCP. Use for inspecting reports, running phases, diagnosing escalations, and choosing verification commands.
---

# podcast-football-harness

Use this skill when a pi session is asked to run, debug, or extend the football video harness.

## Runtime Model

- This project is compatible with pi's no-MCP workflow. Use files plus shell commands.
- Prefer the public CLI: `npm run harness -- <command>`. Avoid importing phase modules directly unless you are writing tests.
- Project skills in `skills/` are exposed through `.pi/settings.json`; prompt templates are in `.pi/prompts/`.

## Main Commands

```bash
npm run harness -- inspect <html>
npm run harness -- run <html|dir>
npm run harness -- run <html> --phase INGEST
npm run harness -- run <html> --from INGEST --to POST
HARNESS_SKIP_RENDER=1 npm test
npm run lint
npm run build
```

## Phase Map

1. `INGEST`: parse arbitrary report HTML into `report.blocks.json`.
2. `PLAN`: turn blocks into `talk-plan.json`.
3. `WRITE`: generate dual-host Chinese dialogue, using LLM when configured and deterministic templates otherwise.
4. `VERIFY_TEXT`: enforce glossary, banned terms, length, and compliance.
5. `AUDIT_TALK`: score the talk track and write per-scene improvement suggestions to `verify/talk-track-audit.json`.
6. `TTS`: synthesize or stub audio and produce line timings.
7. `VERIFY_AUDIO`: compare actual timing to the plan.
8. `COMPOSE`: build the HTML composition from scene templates.
9. `VERIFY_VISUAL`: lint composition structure.
10. `RENDER`: render video, or skip when `HARNESS_SKIP_RENDER=1`.
11. `VERIFY_AV`: check output duration and sync.
12. `AUDIT_VISUAL`: extract per-scene final frames and write image review suggestions to `verify/visual-frame-audit.json`.
13. `POST`: write delivery manifests.

## Diagnostics

- Start with `out/<date>/<match>/state.json` to see phase attempts.
- Read `out/<date>/<match>/escalation.json` after a supervisor failure.
- Inspect `out/<date>/<match>/verify/*.json` for verifier-specific details.
- Parser issues usually show up as high `unknownPct` in `inspect` output.
- Visual issues usually mean a missing `templates/scenes/*.hbs` partial or an unregistered `visualSpec.kind`.
- Talk quality issues live in `verify/talk-track-audit.json`; final-frame visual quality issues live in `verify/visual-frame-audit.json` and `verify/visual-frames/*.jpg`.

## Environment Knobs

- `HARNESS_WORK_DIR`: alternate output root, default `out`.
- `HARNESS_BATCH_PARALLEL`: batch report concurrency, default `2`.
- `HARNESS_DISABLE_LLM=1`: force deterministic writing.
- `HARNESS_SKIP_RENDER=1`: skip hyperframes render for local tests.
- `HARNESS_TTS_PARALLEL`: TTS concurrency.
- `HARNESS_DBG=1`: verbose LLM/TTS diagnostics.
- `HARNESS_QUALITY_LLM=1`: add an LLM review layer to `AUDIT_TALK`.
- `HARNESS_VISUAL_AUDIT_LLM=1`: send extracted scene frames to Qwen/OpenAI-compatible vision review.
- `HARNESS_REQUIRE_VISUAL_AUDIT=1`: fail if final MP4/frames are missing.
- `HARNESS_REQUIRE_QWEN_VISION=1`: fail if Qwen vision review cannot run.
- `PI_OFFLINE=1`: disable pi startup network checks when running pi.

## Edit Rules

- Keep changes scoped to the failed phase or the requested capability.
- Add or adjust tests when changing parser heuristics, templates, schemas, state routing, or compliance checks.
- Do not remove compliance phrases or dual-host dialogue requirements. Keep public output free of lottery, betting, purchase, recommendation, stake, payoff, and profit/loss language.

## Proven Execution Recipe (haxu / linux, 2026-05)

Full notes in `docs/runbook-execution.md`. Minimum viable command:

```bash
env GX10_OPENAI_BASE_URL= GX10_MODEL_NAME= \
    PUPPETEER_EXECUTABLE_PATH=/home/haxu/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome \
    npm run harness -- run inputs/<YYYYMMDD>/<file>.html
```

Why each knob matters:

1. **Blank `GX10_OPENAI_BASE_URL` + `GX10_MODEL_NAME`** — the configured GX10 endpoint is `qwen3.6-35b` with `thinking_effort=low`. `chatJson` pads `max_completion_tokens` to `2×+400` for reasoning models, and WRITE phases can exceed the supervisor's wall-clock budget. Blanking the chat base URL/model makes `llmClient` skip GX10 and use Azure `gpt-5.4`. Keep `GX10_OPENAI_API_KEY` set so GX10 TTS can authenticate.
2. **`PUPPETEER_EXECUTABLE_PATH`** — hyperframes calls `npx hyperframes render` which needs Chrome. No system Chrome on this host. Verified path: `/home/haxu/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome`. Other candidates (`~/.cache/ms-playwright/chromium-1217`, `~/.agent-browser/browsers/chrome-148.*`) were not exercised end-to-end.
3. **`HARNESS_SKIP_RENDER=1`** — set this whenever you only need to validate text / visuals; saves ~7 min of frame capture + ffmpeg.

### Reference Provider Map

| Layer | Primary | Fallback | Notes |
|---|---|---|---|
| LLM (`llmClient.ts`) | GX10 `qwen3.6-35b` (currently disable for WRITE) | Azure `gpt-5.4` | Provider order = order vars are set. Blank GX10 chat vars to force Azure. |
| TTS | GX10 Qwen3 TTS (`http://gx10.haxu.home:8091/v1/audio/speech`) | Azure Speech, then sine-wave stub (offline) | Existing `VIBEVOICE_VOICE_FEMALE` / `VIBEVOICE_VOICE_MALE` values are still honored; prefer `GX10_TTS_VOICE_FEMALE` / `GX10_TTS_VOICE_MALE` for new overrides. |
| RENDER | hyperframes 0.6.25 + Chrome 131 (puppeteer cache) | `HARNESS_SKIP_RENDER=1` no-op | `--quality draft` by default; override with `HARNESS_RENDER_QUALITY`. |

### Reference Timings (Fiorentina vs Atalanta, 6 scenes / 173.2 s output)

```
INGEST        <1s     PLAN          <1s     WRITE        ~2m  (Azure)
VERIFY_TEXT   <1s     AUDIT_TALK    <1s     TTS          ~4m
VERIFY_AUDIO  <1s     COMPOSE       ~10s    VERIFY_VISUAL <1s
RENDER        ~7m     VERIFY_AV     <1s     AUDIT_VISUAL <1s+Qwen
POST          <1s
                                        ── total ≈ 15 min cold
```

### Quick Checks Post-Render

```bash
ffprobe -v error -show_entries stream=codec_type,width,height \
        -show_entries format=duration,size -of default \
        out/<bucket>/<base>/final.mp4
jq '{compliancePolicy, restrictedTerms, opening: .opening|map(.id), closing: .closing|map(.id)}' \
   out/<bucket>/<base>/compliance.json
```

Expect 1080×1920, VERIFY_AV audio/video sync pass, `restrictedTerms` must be empty, opening must include `simulated_prefix`, and closing must include all configured boundary phrases.

### Known Pitfalls

- **GX10 thinking timeout**: see above. Symptom = WRITE phase hangs >10 min, `state.json` shows `currentPhase: WRITE / status: running`.
- **High Unknown% in parser** on `oh-my-football-ml` reports (~92%) is normal — the four `chart-hint` blocks at the `①②③④` headings still drive correct chapter selection via `pickRichKindByChapterTitle` in `02-plan.ts`.
- **LLM occasionally hallucinates the league** (e.g. "荷甲" on a Serie A report). If this matters, post-validate by checking `meta.league` against dialogue text, or add a `wrong-league` rule to `04-verify-text.ts`.
- **Pipeline is resumable**: re-running picks up from `currentPhase` in `state.json`. Delete the per-match dir or use `--from <PHASE>` to force a rerun of a specific range.
