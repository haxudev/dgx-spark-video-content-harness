# dgx-spark-video-content-harness hosted agent

A container-based **Microsoft Agent Framework** *harness agent* that wraps the
existing Node harness pipeline. Upstream sends a report URL (+ style params) over
the **Foundry RESPONSES protocol**; the agent fetches the report, runs the full
agent-first pipeline, and produces a 1080×1920 narrated `final.mp4`.

```
RESPONSES :8088  ─▶  create_harness_agent (GX10 qwen3.6-35b)
                        └─ tool: generate_match_video(report_url, mode, profile, cover, skip_render, voice…)
                              └─ node /app/dist/cli.js run --url … --result-json …   (unchanged 13-phase pipeline)
                                    └─ /app/out/<bucket>/<base>/final.mp4
```

The orchestration model is the only new LLM surface and is kept **35B-friendly**:
a single flat, enum-constrained tool. The harness `WRITE` phase keeps its own
provider chain (GX10 → Azure fallback), untouched.

## Run locally (WSL Docker)

```bash
# from the repo root (build context bundles the harness + this agent)
docker compose build
docker compose up
```

Requires a repo-root `.env` with the harness credentials (`GX10_*` / `AZURE_*`);
the agent brain reuses `GX10_*` by default. See `agent/.env.example` for
agent-specific overrides. `./out` and `./inputs` are bind-mounted so artifacts
land on the host.

> The container reaches `gx10.haxu.home` (chat/agent LLM :8000) and the local
> Qwen3-TTS (`nuc.haxu.home` :8568 named / :8569 clone) via **host
> networking** (compose default). If host networking is unavailable, switch to
> the bridge + `extra_hosts` block documented in `docker-compose.yml`.

## Call it (RESPONSES protocol)

> **Port**: the server binds `AGENT_PORT` (default **8088**). Set another port
> when 8088 is already taken on the host — e.g. a caddy reverse proxy. This
> deployment runs on **8089** (`AGENT_PORT=8089` in the repo `.env`), so use that
> in the curl below.

```bash
curl -sN http://localhost:8089/responses \
  -H 'content-type: application/json' \
  -d '{
        "model": "football-video-agent",
        "stream": true,
        "input": "为这份报告生成视频：https://football.haxu.net/match/20260529-4002/ ，mode=monologue"
      }'
```

The agent calls `generate_match_video` once and replies with the `mp4Path`
(under the mounted `./out`), duration, scene count, and compliance policy.

### Tool parameters

| Param | Values | Default | Maps to |
|---|---|---|---|
| `report_url` | http(s) URL | — (required) | `harness run --url` (SPA-rendered) |
| `mode` | `podcast` \| `monologue` | `podcast` | `--mode` |
| `profile` | `fast` \| `draft` \| `final` | `final` | `--profile` |
| `cover` | `ai` \| `none` | `ai` | `HARNESS_SKIP_COVER/BGIMAGE` |
| `skip_render` | bool | `false` | `HARNESS_SKIP_RENDER` |
| `voice` | Qwen3-TTS voice name | — (env default) | `--voice` (mode-aware: monologue→Narrator, podcast→both hosts) |
| `voice_male` | Qwen3-TTS voice name | — (env default) | `--voice-male` → `QWEN_TTS_VOICE_MALE` (Analyst 小帅) |
| `voice_female` | Qwen3-TTS voice name | — (env default) | `--voice-female` → `QWEN_TTS_VOICE_FEMALE` (Anchor 小美) |
| `voice_narrator` | Qwen3-TTS voice name | — (env default) | `--voice-narrator` → `QWEN_TTS_VOICE_NARRATOR` (Narrator 解局人) |
| `clone_ref` | wav path/URI | — | `--clone-ref` (mode-aware: monologue→Narrator, podcast→both hosts) — clones an arbitrary voice via the Qwen3-TTS Base service |
| `clone_ref_male` / `clone_ref_female` / `clone_ref_narrator` | wav path/URI | — | per-role `--clone-ref-*` → `QWEN_TTS_CLONE_REF_*` |
| `clone_ref_text` | transcript | — | `--clone-ref-text` (enables higher-fidelity ICL cloning) |
| `narrative` | free text | — | `HARNESS_WRITE_NOTE` — per-run editorial angle injected into the WRITE agent prompt (soft creative steer; data-fidelity + compliance gates still enforced) |

> Voice overrides apply to the **Qwen3-TTS** backend only (Azure voices are
> unchanged) and are soft-validated (trimmed, non-empty, ≤64 chars). Unset values
> keep the harness env defaults (`Vivian` / `Dylan`). Per-role flags win over the
> generic `voice`.
>
> **Voice cloning** (`clone_ref*`) needs the Qwen3-TTS **Base** service (`:8569`)
> reachable and the reference wav readable *inside the container* — mount it (the
> compose file bind-mounts `./custom_voice` → `/app/custom_voice`, so pass e.g.
> `clone_ref=/app/custom_voice/merged.wav`). The clone label appears in the audio
> manifest as `clone:<hash>` and invalidates the TTS cache automatically.

## Run the agent without Docker (dev)

```bash
cd agent && pip install -e .
AGENT_MODEL_BASE_URL=$GX10_OPENAI_BASE_URL \
AGENT_MODEL_API_KEY=$GX10_OPENAI_API_KEY \
AGENT_MODEL_NAME=$GX10_MODEL_NAME \
HARNESS_BIN="node $(pwd)/../dist/cli.js" HARNESS_DIR="$(pwd)/.." \
OTEL_SDK_DISABLED=true AGENT_PORT=8088 \
python -m football_agent.server
```

(Run `npm run build` in the repo root first so `dist/cli.js` exists.)

## Layout

| File | Purpose |
|---|---|
| `football_agent/config.py` | Env-driven runtime config (GX10 brain, harness bin, port) |
| `football_agent/style.py` | Deterministic `style/options → harness flags` mapping + validation |
| `football_agent/harness_runner.py` | Subprocess driver: `harness run --url … --result-json …` + parse |
| `football_agent/agent.py` | `create_harness_agent` + the single `generate_match_video` tool |
| `football_agent/server.py` | `ResponsesHostServer(agent).run(host, port)` |
| `deploy/create_version.py` | Optional: register the image as an Azure Foundry hosted agent |

## Deploy to Azure Foundry (optional)

Not needed for local use. Build/push the image to ACR, grant the project MI
`AcrPull`, then `python agent/deploy/create_version.py` — see that file's header.
