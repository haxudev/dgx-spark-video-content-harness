# podcast-football Agent Guide

This project turns football data/probability HTML reports into Chinese dual-host vertical videos. It is intentionally CLI-first so minimal coding agents such as pi can operate without MCP.

## Default Workflow

- Install dependencies with `npm install` when needed.
- Inspect a report with `npm run harness -- inspect <html>` before changing parser heuristics.
- Run the pipeline with `npm run harness -- run <html|dir>`.
- For fast offline verification, use `HARNESS_SKIP_RENDER=1 npm test` or `HARNESS_SKIP_RENDER=1 npm run harness -- run <html> --to POST`.
- Check types with `npm run lint`; use `npm run build` before declaring generated CLI output ready.

## Proven invocation (read this before running on haxu / linux)

See `docs/runbook-execution.md` for the full table. TL;DR — two env knobs are required:

```bash
env GX10_OPENAI_BASE_URL= GX10_MODEL_NAME= \
    PUPPETEER_EXECUTABLE_PATH=/home/haxu/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome \
    npm run harness -- run inputs/<YYYYMMDD>/<file>.html
```

Why:
- **GX10 chat vars blanked** → falls back to Azure `gpt-5.4`. Keep `GX10_OPENAI_API_KEY` set so the GX10 chat/agent brain can still authenticate; empty exported `GX10_OPENAI_BASE_URL`/`GX10_MODEL_NAME` beat `.env` defaults because `dotenv` only fills *unset* vars. (GX10 no longer hosts TTS — TTS is the local Qwen3-TTS service, see below.)
- **PUPPETEER_EXECUTABLE_PATH** → required for hyperframes; Chrome 131 from the puppeteer cache is the verified-working binary on this host.

Expected wall time end-to-end: ~15 min cold (RENDER dominates at ~7 min). Output lands in `out/<bucket>/<base>/final.mp4` at 1080×1920, h264+aac; runtime is advisory and VERIFY_AV checks audio/video sync.

## Pipeline Shape

The phase order is `INGEST -> PLAN -> WRITE -> VERIFY_TEXT -> AUDIT_TALK -> TTS -> VERIFY_AUDIO -> AVATAR -> COMPOSE -> VERIFY_VISUAL -> RENDER -> VERIFY_AV -> AUDIT_VISUAL -> POST`.

The supervisor owns retry, rollback, and `escalation.json`. When a phase fails, inspect `out/<date>/<match>/state.json`, `verify/*.json`, and `escalation.json` before editing code.

### v2 four-act deck

PLAN is now a fixed four-act storyboard (no dynamic chapter clustering, no risk/strategy/compliance scenes):

1. `cover-anime` — 结论先行 full-screen anime cover (gpt-image-2). Shows 双方 / 胜平负 / 比分 top3 / 球数 top3. The Act-1 backdrop is a gpt-image-2 image that carries both teams' identity elements (国旗/队色/纹章/球员气质). Only degrades to a data card when no image deployment is configured (or `HARNESS_SKIP_COVER=1`).
2. `fundamentals-signal` — team-strength compare chart + 风向标 (隐含/公允/模型 probability bars + 赛前概率漂移). Probability-only, no odds/EV.
3. `market-grid` — unchanged model probability distribution (胜平负 / 总进球 / 比分 / 半全场).
4. `upset-dashboard` — 爆冷 gauge + 复杂性指标 + 主要驱动 + 潜在爆冷比分 (all ECharts, no text grids).

The compliance disclaimer is folded into the Act-1 opening and Act-4 closing narration (WRITE emits the required phrases; `repairCompliancePhrases` guarantees them). WRITE is **agent-first**: a single conclusion-first LLM call freely authors all four acts from a market-derived brief, with a market-aware deterministic fallback for offline runs. Structured chart data comes from `marketExtractor` (`marketSignal`, `totalGoals.topGoals`, `upset.complexityMetrics`, `upset.drivers`).

**Agent free-creation, not a template (important).** The script is *authored per match* by the LLM, seeded by a per-run `creativeSeed` so even re-running the same fixture yields a fresh take; the agent prompt explicitly forbids fixed templates / stock phrasing. The deterministic generator (`monologueActLines` / `deterministicScript`) is an offline / last-resort fallback that produces a near-identical script every match — **it is not the product**. To keep this honest: the agent call uses `retries: 2` (3 attempts) so a transient provider hiccup never silently drops to the template; WRITE stamps `dialogue.json.authoredBy` (`agent`|`deterministic`) + writes `verify/write.json`, and a fallback while the LLM was available raises a `write-agent-fallback` WARN. Pin the seed with `HARNESS_WRITE_SEED` for reproducible debugging. If a generated video sounds identical across matches, check `authoredBy` — it fell back; fix the provider and re-run WRITE, don't accept the template.

### Script modes (podcast vs monologue)

WRITE supports two script modes, selected by `HARNESS_SCRIPT_MODE` (env, default `podcast`) or the `--mode <podcast|monologue>` CLI flag. The same four-act deck, TTS, COMPOSE and RENDER tail serve both; only WRITE and the text gates branch.

- `podcast` (default, unchanged): dual-host 男女对谈 — `Anchor` (小美) + `Analyst` (小帅).
- `monologue`: single-host first-person 口播稿 — one `Narrator` (解局人), a suspenseful insider "解局" voice told in **plain, football-grounded language** (中学文化程度受众, 一听就懂; on-pitch imagery only, no cross-domain/literary metaphors) that structures the match as 谁被当热门 → 数据其实更冷静 → 牌面很散 → 冷门会不会来. It is **agent-first** (a single conclusion-first LLM call) with a market-aware deterministic fallback, same as podcast.

WRITE stamps the chosen mode into `dialogue.json` (`.mode`); VERIFY_TEXT / AUDIT_TALK read it from there and skip the dual-host-only gates (双声道 cadence、speaker-balance、both-speakers per scene) in monologue mode. Every compliance/banned/restricted/数据保真 gate stays active in both modes. Both modes must stay **直白易懂**: metaphors only from on-pitch football imagery/术语, never 门缝/裂缝/风向/资本/钥匙/棋局/电影 抽象隐喻; openings are direct (no "像一部…/像两把钥匙…" cold opens). "谁更被看好" is **probability-only** — 市场隐含可能性 vs 模型可能性 (风向标/概率漂移) and 爆冷, told as 球队热度/外界看好 vs 数据更冷静, never odds/betting/庄家/金额/资金/资本. Narrator voice/name overrides: `AZURE_VOICE_NARRATOR`, `QWEN_TTS_VOICE_NARRATOR`, `NARRATOR_DISPLAY_NAME`. Per-run **Qwen3-TTS** custom voice (no env edit): `harness run … --voice <name>` (named roster, mode-aware: monologue→Narrator, podcast→both hosts) or the per-role `--voice-male` / `--voice-female` / `--voice-narrator`; to **clone** an arbitrary voice from a reference wav use `--clone-ref <wav>` (or `--clone-ref-male/-female/-narrator`). See `docs/runbook-execution.md` §1b.

### Avatar presenter (no subtitles)

The video carries **no on-screen dialogue subtitles**. Instead a looping **digital-human presenter** (LongCat-Video-Avatar) sits in a framed full-width card at the bottom of the 1080×1920 frame, signalling "someone is narrating". The deck visuals are therefore **identical for podcast and monologue** — the only differences are the 口播稿 (script), 配音 (voice), and the avatar source image. This keeps the deck maintained once.

- **Layout**: `src/tools/avatarLayout.ts` is the single source of truth for the band geometry (used by both the HTML card and the ffmpeg overlay). Header on top, four-act deck in the middle, presenter band at the bottom, a slim persistent compliance ribbon underneath. `08-verify-visual` now requires the `data-avatar-band` marker (the old `lower-third`/`subtitles.vtt` requirement is gone; `subtitles.vtt` is still written to disk as a debug artifact).
- **AVATAR phase** (`src/phases/06b-avatar.ts`, between VERIFY_AUDIO and COMPOSE) is **cache-only**: it copies a pre-generated clip from the version-controlled material library (`assets/avatar-clips/<mode>-<resolution>-seg<segments>.mp4`) into `composition/avatar.mp4`, performing **no network call** and **never** triggering a longcat job — so a normal `harness run` can never pause the qwen brain. RENDER ping-pong-loops the short clip to fill the whole video (`关键片段+循环`) and overlays it into the band via ffmpeg, keeping the deck's TTS audio. Lookup is by readable name first (image-bytes free, portable) then the legacy `out/_cache/avatar/<imageHashKey>.mp4` fallback. On a miss it ships the framed placeholder (`avatar-cache-miss` WARN) unless `HARNESS_REQUIRE_AVATAR=1`.
- **Generation is out of band** (`harness avatar-prewarm`, the ONLY longcat caller; `src/tools/avatarGenerate.ts`): generates ONE short talking-head clip per `(mode, resolution, segments, prompt)` and persists it into the library (`index.json` records source-image sha, bytes, job id, drive-audio source). The driving audio is auto-discovered from prior runs' **opening** TTS (similar structure across fixtures); pin with `--drive-audio` / `HARNESS_AVATAR_DRIVE_AUDIO`. Inspect the library with `harness avatar-library`.
- **Time-sharing with the qwen brain**: a running avatar job temporarily stops the co-located gx10 qwen LLM (~10+ min). Only `avatar-prewarm` generates, so only it pauses the brain — run it deliberately, never inside a pipeline run. It holds a global lock (`<library>/.lock`), does a `/healthz` pre-flight, and uses `waitForBrainOnline()` as a barrier confirming the brain is back before returning. A normal `harness run` (pure consume) finishes regardless of the brain state; an orchestrating agent (pi / MAF) just awaits it.
- **Enable / config**: the pipeline needs no longcat config — it consumes the committed library. `LONGCAT_AVATAR_BASE_URL` is required ONLY by `avatar-prewarm`. Library dir override: `HARNESS_AVATAR_LIBRARY_DIR` (default `assets/avatar-clips/`). Source images default to `~/openclaw-artifacts/podcast_avator/{two-people,single-people}.png` (override via `HARNESS_AVATAR_IMAGE[_PODCAST|_MONOLOGUE]` / `HARNESS_AVATAR_ASSET_DIR`). Run flags: `--skip-avatar`, `--avatar-image`, `--avatar-resolution`, `--avatar-segments`. **Miss is non-blocking** (WARN, ship deck without the head) unless `HARNESS_REQUIRE_AVATAR=1`. `fast`/`draft` profiles default `HARNESS_SKIP_AVATAR=1`.

## Runtime Constraints

- No MCP is required. Use normal file tools and shell commands.
- The stable project interface is the `harness` CLI, not direct phase imports.
- The pipeline can run without an LLM: `WRITE` falls back to a market-aware deterministic script when no `GX10_*` or `AZURE_OPENAI_*` provider is configured.
- TTS is configurable via `HARNESS_TTS_PROVIDER` = `qwen` | `azure` | `auto` (default `auto` = local Qwen3-TTS first, then Azure, then stub). The `.env` ships `qwen`. TTS can fall back to stub audio, so tests should not require cloud credentials. **Voice consistency:** a fixed `QWEN_TTS_SEED` (default 7) pins sampling, and the **female host (Anchor) is cloned from a fixed x-vector reference** (`QWEN_TTS_CLONE_REF_FEMALE=custom_voice/anchor_ref.wav`) instead of the named `Vivian` + expressive `instruct`, which drifted ~5× the male's per-segment timbre ("像不同人"). Cloning drops that to ≈ the male baseline. See `docs/runbook-execution.md` §TTS "Voice consistency". The clone path ignores `instruct`; `QWEN_TTS_INSTRUCT_FEMALE` is a stable fallback for named-voice mode.
- Script mode is configurable via `HARNESS_SCRIPT_MODE` = `podcast` (default) | `monologue`, or the `--mode` CLI flag (which just sets that env var). See the "Script modes" subsection above.
- For fast offline runs also set `HARNESS_SKIP_COVER=1 HARNESS_SKIP_BGIMAGE=1` so COMPOSE does not block on Azure gpt-image-2.
- The bottom **avatar presenter** replaces on-screen subtitles and is **cache-only** in the pipeline: the AVATAR phase consumes a clip from the version-controlled library (`assets/avatar-clips/`) and **never calls longcat**, so a normal run never pauses qwen. A miss is **non-blocking** (graceful WARN, ship placeholder) and the phase is OFF in `fast`/`draft` (`HARNESS_SKIP_AVATAR=1`). Pre-generate new clips out of band with `harness avatar-prewarm` (the only longcat caller, which pauses qwen ~10-12 min/clip); inspect with `harness avatar-library`. See the "Avatar presenter" subsection.
- gpt-image-2 cover + background are **固化 (mandatory) when configured**: if an image deployment is set and `HARNESS_SKIP_COVER`/`HARNESS_SKIP_BGIMAGE` are unset, COMPOSE *requires* the Act-1 two-team cover (`composition/cover.png`) and the persistent full-video backdrop (`composition/bg.png`). Each generation walks an authored→deterministic prompt fallback and retries transient image-API errors; a hard miss raises a blocking `compose-cover-missing` / `compose-bg-missing` issue (the supervisor retries COMPOSE, reusing cached successes) instead of silently shipping the gradient/data-card fallback. To intentionally ship without AI images, set the corresponding `HARNESS_SKIP_*` flag.
- Do not commit generated artifacts under `out/` unless the user explicitly asks.

## Containerized hosted agent (MAF)

- A container image wraps the **unchanged** harness behind a Microsoft Agent Framework *harness agent* (`create_harness_agent`) served over the Foundry **RESPONSES** protocol on port 8088 (`POST /responses`). Code lives in `agent/`; see `agent/README.md` and `docs/runbook-execution.md` §9.
- Upstream passes `report_url` + style params (`mode`, `profile`, `cover`, `skip_render`, and optional Qwen3-TTS `voice`/`voice_male`/`voice_female`/`voice_narrator`) to a single 35B-friendly tool `generate_match_video`, which calls `harness fetch` + `harness run --url … --result-json …` and returns the `mp4Path` (under the bind-mounted `out/`).
- The agent **brain** is GX10 `qwen3.6-35b` (reuses `GX10_OPENAI_*`); the pipeline `WRITE` phase keeps its own GX10→Azure chain. Run with `docker compose up` (WSL Docker; defaults to `network_mode: host` to reach `gx10.haxu.home`).
- Lean MAF deps only: `agent-framework-openai` + `agent-framework-foundry-hosting` + `mcp` — never the `agent-framework[all]` meta (multi-GB).
- New harness CLI surface (also usable standalone): `harness fetch <url> [out]` (puppeteer SPA render) and `harness run --url <url> --result-json <file>`.

## Content Constraints

- Preserve the medium compliance policy: sports probability observation only, no lottery/betting/purchase/recommendation language.
- Dialogue must remain dual-host (`Anchor` plus `Analyst`) in the default `podcast` mode; the `monologue` mode is the single-host (`Narrator`) exception and skips only the dual-host cadence/balance gates — never the compliance ones.
- Numbers in dialogue must be traceable to parsed report blocks or config.
- Keep probability and score-scenario analysis non-actionable; avoid certainty language and action guidance.