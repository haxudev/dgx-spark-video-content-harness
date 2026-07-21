# Execution Runbook — proven recipes & gotchas

This runbook captures the **actually working** invocation for the `dgx-spark-video-content-harness` harness on this machine (haxu / linux / 2026-05). Keep it tight: only things confirmed end-to-end on a real report.

Reference run: `inputs/20260523/2026-05-23_fiorentina-vs-atalanta.html`
→ `out/20260523/2026-05-23_fiorentina-vs-atalanta/final.mp4` (173.2 s, 6 scenes, 1080×1920, h264+aac).

## 1. One-shot command (full pipeline, end-to-end ≈ 15 min)

```bash
cd /home/haxu/dgx-spark-video-content-harness

# Drop the source report into the date bucket — the bucket dir name becomes the matchId prefix.
mkdir -p inputs/<YYYYMMDD>
cp <some>/report.html inputs/<YYYYMMDD>/<YYYY-MM-DD>_<slug>.html

# Run pipeline. Mandatory env knobs on this host:
#   1. Disable the GX10 *thinking LLM* for WRITE (it returns hidden reasoning and
#      times out >10 min for 6 scenes). Blank only GX10_OPENAI_BASE_URL +
#      GX10_MODEL_NAME — llmClient only registers the GX10 LLM when all three of
#      BASE_URL/API_KEY/MODEL are set, so dropping the base URL is enough to fall
#      back to Azure gpt-5.4.
#   2. **TTS is the local Qwen3-TTS service** (nuc.haxu.home:8568 named voices,
#      :8569 voice clone). It authenticates with QWEN_TTS_API_KEY (not GX10).
#      A TTS call failure → Azure neural fallback, and any Azure failure →
#      sine-wave *stub* (silent gaps). TTS defaults to `qwen` in `.env`.
#   3. Point Chromium at the puppeteer cache so hyperframes can launch.
env GX10_OPENAI_BASE_URL= GX10_MODEL_NAME= \
    PUPPETEER_EXECUTABLE_PATH=/home/haxu/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome \
    npm run harness -- run inputs/<YYYYMMDD>/<file>.html
```

> ⚠️ `GX10_OPENAI_API_KEY` is for the GX10 *chat/agent brain*, not TTS — TTS now
> uses `QWEN_TTS_API_KEY`. Confirm the result with
> `jq '.provider, .voices' out/<…>/audio/manifest.json` → should read
> `"qwen"` and `{"Anchor":"Vivian","Analyst":"Dylan"}` (or a `clone:*` label when
> cloning). A `"mixed"` provider or Azure/stub voices means the Qwen TTS host was
> unreachable.
>
> **Future (35b orchestration):** the GX10 35b model is intended to *drive /
> optimise the pipeline* later. Re-enabling it is just restoring
> `GX10_OPENAI_BASE_URL` + `GX10_MODEL_NAME` (and, ideally, a non-thinking model
> or `thinking_effort=disabled` so WRITE doesn't time out). Keep the GX10 env
> vars configured in `.env`; the blanking above is only a temporary WRITE-speed
> workaround, not a teardown.

Resume after a partial run:

```bash
env GX10_OPENAI_BASE_URL= GX10_MODEL_NAME= \
    PUPPETEER_EXECUTABLE_PATH=/home/haxu/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome \
    npm run harness -- run inputs/<…>.html --from TTS --to POST
```

Skip the expensive render when iterating on text/visuals:

```bash
HARNESS_SKIP_RENDER=1 \
env GX10_OPENAI_BASE_URL= GX10_MODEL_NAME= \
    npm run harness -- run inputs/<…>.html --to VERIFY_VISUAL
```

## 1b. Script mode — podcast (dual-host) vs monologue (single-host)

The harness authors the spoken script in one of two modes; both feed the same
TTS → COMPOSE → RENDER tail and produce a 1080×1920 vertical mp4.

| Mode | Select with | Hosts | Style |
|---|---|---|---|
| `podcast` (default) | `--mode podcast` or unset | Anchor 小美 (女) + Analyst 小帅 (男) | 轻快双人对谈，结论先行 |
| `monologue` | `--mode monologue` **or** `HARNESS_SCRIPT_MODE=monologue` | Narrator 解局人 (单人) | 第一人称「解局人」悬念口播，直白·球赛术语：谁被当热门 → 数据更冷静 → 牌面很散 → 冷门会不会来 |

The CLI flag just sets `HARNESS_SCRIPT_MODE`; the env var is the single source of
truth (`scriptMode()` in `src/tools/runProfile.ts`). WRITE stamps the mode into
`dialogue.json` (`.mode`), and VERIFY_TEXT / AUDIT_TALK read it from there — the
dual-host gates (双声道 cadence、speaker-balance、both-speakers) are skipped in
monologue mode, while every compliance/banned/restricted/数据保真 gate stays on.

Both modes must stay **直白易懂** (中学文化程度受众, 一听就懂): metaphors only from
on-pitch football imagery / 球赛术语, never 门缝 / 裂缝 / 风向 / 资本 / 钥匙 / 棋局 /
电影 抽象隐喻; openings are direct (no "像一部…/像两把钥匙…" cold opens). The
"谁更被看好" framing is **probability-only** by construction: 市场隐含可能性 vs
模型可能性 (the 风向标 / 概率漂移) and 爆冷, told as 球队热度 / 外界看好 vs 数据更冷静
— never odds, betting, 庄家, amounts, 资金 or 资本 (all still banned).

```bash
# Monologue, full pipeline (same env knobs as §1):
env GX10_OPENAI_BASE_URL= GX10_MODEL_NAME= \
    PUPPETEER_EXECUTABLE_PATH=/home/haxu/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome \
    npm run harness -- run inputs/<YYYYMMDD>/<file>.html --mode monologue

# Fast offline check (deterministic, stub TTS, no render):
HARNESS_SCRIPT_MODE=monologue HARNESS_DISABLE_LLM=1 \
HARNESS_SKIP_RENDER=1 HARNESS_SKIP_COVER=1 HARNESS_SKIP_BGIMAGE=1 \
    npm run harness -- run inputs/<…>.html --to AUDIT_TALK
```

Narrator voice overrides: `AZURE_VOICE_NARRATOR` (Azure neural, default
`zh-CN-YunjianNeural`), `QWEN_TTS_VOICE_NARRATOR` (Qwen3-TTS named voice, falls
back to the male `Dylan`), and `NARRATOR_DISPLAY_NAME` (on-screen badge, default 解局人).

Per-run custom voice (no env edit, **qwen backend only**):

- **Named roster voice** — `--voice <name>` (one of the CustomVoice roster). It is
  mode-aware: in `monologue` it sets the Narrator, in `podcast` it seeds **both**
  hosts. For distinct dual-host voices use `--voice-male` (Analyst 小帅) /
  `--voice-female` (Anchor 小美) / `--voice-narrator`. These set the
  `QWEN_TTS_VOICE_*` env vars before the run (Azure voices untouched).
- **Cloned voice** — `--clone-ref <wav>` clones an arbitrary voice from a reference
  wav via the Base service (:8569, 3-second rapid clone). Mode-aware like `--voice`,
  with per-role `--clone-ref-male` / `--clone-ref-female` / `--clone-ref-narrator`,
  and optional `--clone-ref-text <transcript>` to enable higher-fidelity ICL mode.
  The TTS cache keys on the reference, so it invalidates automatically.

```bash
npm run harness -- run inputs/<…>.html --mode monologue --voice Uncle_Fu
npm run harness -- run inputs/<…>.html --voice-female Vivian --voice-male Dylan
# Clone the host's own voice from a reference wav (monologue → Narrator):
npm run harness -- run inputs/<…>.html --mode monologue \
    --clone-ref ~/openclaw-artifacts/custom_voice/merged.wav
```

## 2. LLM provider chain (`src/tools/llmClient.ts`)

Providers are tried in order **GX10 → Azure** based on env vars. Both currently configured in `.env`.

| Provider | Endpoint | Model | Status | When to pick |
|---|---|---|---|---|
| **GX10** primary | `http://gx10.haxu.home:8000/v1` | `qwen3.6-35b` (thinking) | ✅ reachable, but **too slow** for WRITE phase even with `GX10_THINKING_EFFORT=low` (returns reasoning, budget padded 2×+400). `chatJson` retries 2× → multi-minute per scene → 600 s timeout. | Single-scene exploratory probes only. |
| **Azure OpenAI** fallback | `https://haxuaifoundryaiservice.openai.azure.com/openai/v1` | `gpt-5.4` | ✅ current WRITE backend, reliable JSON-mode. | Default. Triggered by blanking GX10 chat vars. |
| Deterministic templates | — | — | Built-in fallback when `HARNESS_DISABLE_LLM=1` or all providers fail. | Air-gapped tests or CI smoke. |

Force Azure-first today: blank the three GX10 vars in the environment (see §1). Do **not** edit `.env` — `dotenv` only fills *unset* variables, so an exported empty string wins.

If/when GX10 thinking is fixed (e.g. `thinking_effort=disabled` or a non-reasoning model), reverse the override.

## 3. TTS backend (`src/tools/azureSpeech.ts`)

Selector: `HARNESS_TTS_PROVIDER` = `qwen` | `azure` | `auto` (`.env` ships `qwen`).

| Backend | Endpoint | Voices | Notes |
|---|---|---|---|
| **Qwen3-TTS** primary | named: `QWEN_TTS_BASE_URL` `/v1/tts` (`nuc.haxu.home:8568`) · clone: `QWEN_TTS_CLONE_URL` `/v1/voice_clone` (`:8569`) | `clone:*` (Anchor 小美, x-vector), `Dylan` (Analyst 小帅), `Uncle_Fu`/`clone:*` (Narrator 解局人), all seed-pinned | Local Qwen3-TTS. Named voices use the CustomVoice model (`/v1/tts`, optional `instruct` style control); voice cloning uses the **Base** model (`/v1/voice_clone`, `ref_audio` + optional `ref_text`). Auth: `QWEN_TTS_API_KEY` (falls back to `API_KEY`). Override voices via `QWEN_TTS_VOICE_{FEMALE,MALE,NARRATOR}`, clone refs via `QWEN_TTS_CLONE_REF_{FEMALE,MALE,NARRATOR}` / `--clone-ref*`. Output is 24 kHz mono WAV. |
| **Azure Speech** fallback | `swedencentral.tts.speech.microsoft.com` | `zh-CN-XiaoxiaoNeural` (Anchor), `zh-CN-YunxiNeural` (Analyst) | Used when Qwen fails and Azure credentials are present. SSML neural TTS with real word boundaries. Override via `AZURE_VOICE_FEMALE` / `AZURE_VOICE_MALE`. |
| Stub | — | low-amplitude sine WAVs | Used when Qwen and Azure are missing/fail; lets the rest of the pipeline still verify offline. |

The two Qwen3-TTS services live in the sibling `qwen3-tts` repo (`docker compose up -d qwen3-tts qwen3-tts-base`). Cache lives in `out/_cache/tts/` keyed by `(provider, voice, ssml, text, styleKey)` — the cloned-voice "voice" is a hash of the reference and `styleKey` folds in the instruct + sampling (seed), so changing any of them invalidates the cache. Corrupt/truncated cache wavs are auto-detected (RIFF validation) and re-synthesised.

### Voice consistency — 女声(Anchor)克隆 (READ if the female voice sounds like "different people")

The named CustomVoice **`Vivian` + an expressive `instruct` ("活泼少女…") drifts hard**: measured per-segment spectral-envelope (timbre) spread `0.0133` — **4.9× the male's `0.0027`** — so the audience hears a different-sounding host each segment. Two fixes are in place:

1. **Fixed seed** (`QWEN_TTS_SEED=7`, default on) anchors the sampling so a role's take is reproducible.
2. **Anchor is cloned from a fixed x-vector reference** (`QWEN_TTS_CLONE_REF_FEMALE=custom_voice/anchor_ref.wav`, `x_vector_only_mode` auto-on). This pins the speaker embedding to ONE reference → timbre spread drops to `0.0040` end-to-end (**≈ the male baseline**, "one person"). The clone path ignores `instruct`; `QWEN_TTS_INSTRUCT_FEMALE` is now a *stable* directive used only if cloning is disabled.

The reference `custom_voice/anchor_ref.wav` is a **deterministic** neutral Vivian sample (in `custom_voice/`, gitignored + mounted into the container like the narrator's `merged.wav`). Regenerate it identically with:

```bash
curl -s -X POST http://nuc.haxu.home:8568/v1/tts \
  -H "Content-Type: application/json" -H "Authorization: Bearer $QWEN_TTS_API_KEY" \
  -d '{"text":"大家好，欢迎来到AI球赛观察，我是主持人小美。今天我们一起来看这场比赛的赛前数据和走势分析。","speaker":"Vivian","language":"Chinese","format":"wav","seed":7}' \
  -o custom_voice/anchor_ref.wav
```

To A/B the timbre metric, synth the same lines under each config and compare mean pairwise spectral-envelope distance (lower = more consistent). Empirical ranking: **clone `0.0033` < no-instruct `0.0056` < stable-instruct+low-temp `0.0050` < Serena `0.0116` < current-Vivian+活泼少女 `0.0133`**.


## 4. RENDER phase (`hyperframes` 0.6.25)

- Binary: `node_modules/.bin/hyperframes`
- Chrome: **must** set `PUPPETEER_EXECUTABLE_PATH`. Verified working path: `/home/haxu/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome`. Other candidates exist (`~/.cache/ms-playwright/chromium-1217/...`, `~/.agent-browser/browsers/chrome-148.*/chrome`) — Chrome 131 was the one that completed successfully.
- Flags emitted by `src/phases/09-render.ts`: `--fps 30 --quality draft --quiet`. Override draft quality via `HARNESS_RENDER_QUALITY=standard|high`.
- Pipeline gracefully degrades to a `render-skipped` warn when hyperframes/Chrome is unavailable; set `HARNESS_SKIP_RENDER=1` to force-skip.
- Expected wall time on this host (~draft quality, 173 s composition): ~6–8 min — Chrome frame capture ~4 min, ffmpeg encode ~2 min.

## 5. Phase timings (Fiorentina baseline)

| Phase | Wall time | Notes |
|---|---|---|
| INGEST | <1 s | Unknown% on this report family is ~92% — fine, the chart-hint blocks at section headers carry enough signal. |
| PLAN | <1 s | Deterministic. Picks neutral rich kinds via `pickRichKindByChapterTitle`: `team-fundamentals`, `market-grid`, `upset-dashboard`; high-risk participation-guidance chapters are quarantined. |
| WRITE | ~2 min | Azure gpt-5.4, one agent-authored script call + verifier pass. With GX10 thinking: >10 min, times out. |
| VERIFY_TEXT | <1 s | Glossary / banned / compliance. |
| AUDIT_TALK | <1 s | Deterministic talk-track quality gate; optional LLM layer with `HARNESS_QUALITY_LLM=1`. |
| TTS | ~4 min | 42 lines, parallel=4. GX10 Qwen3 TTS, Azure Speech fallback. |
| VERIFY_AUDIO | <1 s | Length vs plan. |
| AVATAR | ~0 s | **Cache-only**: copies a pre-generated clip from the version-controlled library (`assets/avatar-clips/`) into `composition/avatar.mp4`. Performs **no network call** and **never** triggers a longcat job, so a normal run can never pause the qwen brain. On a miss it ships the framed placeholder (`avatar-cache-miss` WARN) unless `HARNESS_REQUIRE_AVATAR=1`. Generate new clips out of band with `harness avatar-prewarm`. |
| COMPOSE | ~10 s (+ image generation when configured) | Handlebars → composition/index.html + vendor JS. When `AZURE_OPENAI_IMAGE_DEPLOYMENT` is set (and `HARNESS_SKIP_COVER`/`HARNESS_SKIP_BGIMAGE` unset), gpt-image-2 cover (`composition/cover.png`, the Act-1 two-team backdrop) **and** background (`composition/bg.png`, the persistent full-video backdrop) are **固化/mandatory** — a generation miss raises a blocking `compose-cover-missing` / `compose-bg-missing` issue and COMPOSE retries (cached successes are reused, ~45–90 s/image cold). Disable independently with `HARNESS_SKIP_COVER=1` / `HARNESS_SKIP_BGIMAGE=1`; tune the cover overlay with `HARNESS_COVER_SEC` (default 3.2, does not extend audio duration). |
| VERIFY_VISUAL | <1 s | Lint composition structure. |
| RENDER | ~7 min | hyperframes renders the deck → `composition/deck.mp4`, then ffmpeg ping-pong-loops the avatar clip into the bottom band and muxes the deck audio → `final.mp4` (just a copy when no `avatar.mp4`). Dominant cost. |
| VERIFY_AV | <1 s | ffprobe duration check, expects |Δ| ≤ 1 s vs manifestTotal. |
| AUDIT_VISUAL | <1 s + Qwen | Extracts per-scene final frames; optional Qwen vision review with `HARNESS_VISUAL_AUDIT_LLM=1`. |
| POST | <1 s | Hashes + manifest.json. |

Total: ~15 min cold, ~5 min warm (TTS cache hot, no LLM re-write).

## 5b. Avatar presenter (digital human, replaces subtitles)

The video has **no on-screen dialogue subtitles**. A looping digital-human clip sits in a framed full-width card at the bottom of the 1080×1920 frame (geometry in `src/tools/avatarLayout.ts`). The deck is now **identical for podcast and monologue** — only the script, voice and avatar image differ.

**The pipeline is cache-only.** The `AVATAR` phase *consumes* a pre-generated clip from a **version-controlled material library** (`assets/avatar-clips/`) and **never calls longcat** — guaranteeing a normal `harness run` can never pause the co-located qwen3.6 brain. Generation is a separate, deliberate operator step (`harness avatar-prewarm`), the only command that pauses qwen.

```bash
# Normal run — pure consume, no network, no brain impact. Ships the matching
# library clip if present, else a framed placeholder (avatar-cache-miss WARN).
npm run harness -- run inputs/<bucket>/<file>.html
npm run harness -- run <html> --skip-avatar           # force the placeholder band

# Inspect the library (read-only): present/missing combos, sizes, staleness.
npm run harness -- avatar-library

# Pre-generate clips — THIS PAUSES qwen ~10-12 min per clip. Run it deliberately,
# never inside a normal run. Needs the longcat service:
env LONGCAT_AVATAR_BASE_URL=http://192.168.20.50:8800 \
    npm run harness -- avatar-prewarm --mode both
env LONGCAT_AVATAR_BASE_URL=http://192.168.20.50:8800 \
    npm run harness -- avatar-prewarm --mode monologue --avatar-resolution 720p
# Regenerate after swapping a source image (avatar-library flags it STALE):
env LONGCAT_AVATAR_BASE_URL=… npm run harness -- avatar-prewarm --mode podcast --force
```

Mechanics & gotchas:

- **Version-controlled library.** Clips live in `assets/avatar-clips/<mode>-<resolution>-seg<segments>.mp4` (e.g. `podcast-480p-seg1.mp4`), tracked by git so the presenter ships with zero longcat calls. A non-default `--prompt` adds an 8-char suffix. `index.json` records provenance (source image basename + sha256, bytes, longcat job id, driving-audio source). The name is **image-bytes free**, so lookup needs no source image and the library travels with the repo. The legacy `out/_cache/avatar/<hash>.mp4` is still read as a best-effort fallback. Override the dir with `HARNESS_AVATAR_LIBRARY_DIR`.
- **Pre-generation (`avatar-prewarm`).** The ONLY caller of longcat `/generate`. A running job stops the gx10 qwen LLM (~10+ min); a global lock (`<library>/.lock`) serialises generations, `/healthz` is checked before submit, and `waitForBrainOnline()` waits for `qwen_active` before returning. The **driving audio** is auto-discovered from prior runs' **opening** TTS (the match structure is similar across fixtures); pin it with `--drive-audio` / `HARNESS_AVATAR_DRIVE_AUDIO`, else a neutral line is synthesized as a last resort.
- **Images.** Default `~/openclaw-artifacts/podcast_avator/two-people.png` (podcast) and `single-people.png` (monologue). Override with `HARNESS_AVATAR_IMAGE[_PODCAST|_MONOLOGUE]` or `HARNESS_AVATAR_ASSET_DIR`. The container mounts them at `/app/avatar-assets` (see `docker-compose.yml`).
- **Failure is non-blocking** (WARN, deck ships without the head) unless `HARNESS_REQUIRE_AVATAR=1`. `fast`/`draft` profiles set `HARNESS_SKIP_AVATAR=1`. Inspect `out/<bucket>/<base>/verify/avatar.json` (`cacheOnly`, `source`) and `verify/render.json` (`avatarComposited`).

## 6. Output validation (already automated, but useful for spot-checks)

```bash
# Duration / codec
ffprobe -v error -show_entries stream=codec_type,codec_name,width,height \
        -show_entries format=duration,size,bit_rate -of default final.mp4

# Compliance audit
cat compliance.json | jq '{compliancePolicy, restrictedTerms, opening: .opening|map(.id), closing: .closing|map(.id)}'

# Sample frames every ~30 s
for t in 5 30 60 100 140 170; do
  ffmpeg -y -ss $t -i final.mp4 -frames:v 1 -q:v 3 preview/frame-${t}s.jpg 2>/dev/null
done
```

Expected: 1080×1920, h264+aac, VERIFY_AV audio/video sync pass, `compliance.json` records the medium policy version, has an empty `restrictedTerms` list, opens with `simulated_prefix`, and closes with all configured boundary phrases.

## 7. Known issues / TODO

- **League hallucination**: the LLM occasionally invents a league name in narrative lines (observed: "荷甲赛场" on Italian Serie A report). Mitigation ideas:
  - Inject `league` from `meta` block into the WRITE system prompt as a hard constraint, and add a banned-terms entry for foreign league names not matching `meta.league`.
  - Or post-check via VERIFY_TEXT: if `meta.league` is set and dialogue mentions a different `*甲|*超|*乙`, fail with a `wrong-league` issue.
- **High Unknown% in parser**: ~92% on the `oh-my-football-ml` report family. Fine for the four-chapter pipeline because section markers come through as `chart-hint` with `headingPath[0]` = `①…②…③…④…`. Don't "fix" the parser unless a new kind of report breaks chapter detection.
- **GX10 thinking timeout**: see §2. Long-term, add a `GX10_THINKING_EFFORT=disabled` switch or a non-reasoning model alternative.
- **Initial response cold-start**: the first run after `npm install` paid ~30 s on `tsx` warm-up. Subsequent runs reuse the loader cache.

## 8. File layout cheat-sheet

```
inputs/<YYYYMMDD>/<file>.html                  ← drop reports here
out/<YYYYMMDD>/<base>/
  ├── report.blocks.json     (INGEST)
  ├── talk-plan.json         (PLAN)
  ├── dialogue.json          (WRITE)
  ├── audio/manifest.json    (TTS) + s<NN>-l<N>.wav
  ├── composition/index.html (COMPOSE)
  ├── subtitles.vtt          (COMPOSE)
  ├── final.mp4              (RENDER)
  ├── thumbnail.jpg          (POST)
  ├── manifest.json          (POST — hashes + versions)
  ├── compliance.json        (POST — phrase audit)
  ├── verify/talk-track-audit.json
  ├── verify/visual-frame-audit.json
  ├── verify/visual-frames/*.jpg  (only after full render)
  ├── verify/verify-*.json   (per-phase verifier reports)
  ├── escalation.json        (only on supervisor failure)
  └── state.json             (resumable phase state)
out/_cache/tts/              ← shared TTS cache, keep across runs
```

## 9. Containerized hosted agent (MAF, RESPONSES :8088)

A container image wraps the **unchanged** harness pipeline behind a Microsoft
Agent Framework *harness agent* (`create_harness_agent`) served over the Foundry
**RESPONSES** protocol. Upstream sends a report URL (+ style params); the agent
fetches the report, runs the full pipeline, and writes `final.mp4` into the
bind-mounted `out/`. See `agent/README.md` for full details.

```bash
# Build + run on WSL Docker (build context = repo root):
docker compose build
docker compose up            # serves POST http://localhost:<AGENT_PORT>/responses

# Call it (AGENT_PORT default 8088; THIS host uses 8089 because caddy holds 8088):
curl -sN http://localhost:8089/responses -H 'content-type: application/json' \
  -d '{"model":"football-video-agent","stream":true,
       "input":"为这份报告生成视频：https://football.haxu.net/match/<id>/ ，mode=monologue"}'
```

Key facts:

- **Brain** = GX10 `qwen3.6-35b` (OpenAI-compatible, reuses `GX10_OPENAI_*`); a
  single 35B-friendly tool `generate_match_video(report_url, mode, profile,
  cover, skip_render, voice/voice_male/voice_female/voice_narrator)`. The voice
  params are optional Qwen3-TTS named-voice overrides (mapped to `--voice*`
  flags). The pipeline `WRITE` phase keeps its own GX10→Azure chain.
- **Image** bundles Node 22 + Python 3.11 venv + Chromium + ffmpeg + CJK fonts.
  Lean MAF deps: `agent-framework-openai` + `agent-framework-foundry-hosting` +
  `mcp` (NOT the `agent-framework[all]` meta — that is multi-GB).
- **Networking**: compose defaults to `network_mode: host` so the container
  resolves/reaches `gx10.haxu.home` (chat/agent LLM :8000) and the local
  Qwen3-TTS (`nuc.haxu.home` :8568 named / :8569 clone) via the host. If host
  networking is unavailable, use the bridge + `extra_hosts` block in
  `docker-compose.yml`.
- **Port**: the agent binds `AGENT_PORT` (default 8088). On this host 8088 is
  already taken by a caddy reverse proxy, so the container runs on **8089**
  (`AGENT_PORT=8089` in `.env`) — post to `http://localhost:8089/responses`.
  `ss -ltnp | grep 808` shows who owns each port.
- **Transient OOM resilience**: a host OOM can deliver SIGKILL (`-9`) to the Node
  pipeline mid-run (seen during the long WRITE/RENDER phases), leaving no result
  manifest. The runner now **retries a signal-killed run** once by default
  (`HARNESS_AGENT_SIGNAL_RETRIES`, 0 to disable); a real non-zero pipeline error
  is never retried. If you still see `exited -9`, the retry was also killed —
  reduce concurrent memory load and re-issue the request.
- **Output**: `./out` and `./inputs` are bind-mounted; the tool returns the
  `mp4Path`, duration, scene count, and compliance policy.
- New harness CLI surface used by the agent: `harness fetch <url> [out]`
  (puppeteer SPA render) and `harness run --url <url> --result-json <file>`.
- **Foundry deploy** (optional): `agent/deploy/create_version.py` registers the
  same image as an Azure hosted agent (`ImageBasedHostedAgentDefinition`, RESPONSES v1).
- **Smoke-tested** on this host: image builds (2.59GB), container boots, `POST
  /responses` → 200, harness CLI + Chromium + ffmpeg present. A full live run
  (producing `final.mp4`) requires GX10 online — run it on the WSL host.
