# Pi Agent Runtime Compatibility

This project supports pi as a minimal no-MCP coding-agent runtime. Pi's core model is a terminal harness with built-in file and shell tools, project context files, skills, prompt templates, optional extensions, JSON event mode, RPC mode, and an SDK. For this repository, the safest compatibility layer is resource-based: expose the existing CLI and project rules to pi instead of adding a second orchestration stack.

## What Was Added

- `AGENTS.md`: project instructions automatically loaded by pi from the working directory.
- `.pi/settings.json`: enables skill commands and exposes the existing root `skills/` directory to pi.
- `.pi/skills/podcast-football-harness/SKILL.md`: a pi-discoverable workflow skill for this pipeline.
- `.pi/prompts/*.md`: slash-command prompt templates for report inspection, pipeline runs, and escalation fixes.
- `scripts/pi-agent-harness.ts`: an optional wrapper that launches pi with this project's defaults.
- `package.json#pi`: package manifest entries so the same resources can be discovered if this repo is used as a pi package.

## Why No MCP

Pi intentionally does not require MCP. Its default tools and project resources are enough for this repository because the pipeline already exposes a stable CLI:

```bash
npm run harness -- inspect <html>
npm run harness -- run <html|dir>
```

That keeps the agent runtime thin: pi edits files, runs the harness, reads artifacts, and uses verifier output to decide the next step.

## Running Pi Through the Wrapper

Install pi separately when needed:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

Preview the generated prompt without launching pi:

```bash
npm run pi:prompt -- --input inputs/20260522/2026-05-22_ajax-vs-groningen.html "inspect this report"
```

Start an interactive pi session with project defaults:

```bash
npm run pi -- --input inputs/20260522/2026-05-22_ajax-vs-groningen.html "inspect this report and fix parser gaps if needed"
```

Run a one-shot print-mode task:

```bash
npm run pi -- --mode print --input inputs/20260522/2026-05-22_ajax-vs-groningen.html "summarize the current pipeline readiness"
```

Start pi's JSON event mode for integration:

```bash
npm run pi -- --mode json "list the available project commands"
```

Start pi's RPC mode for an external controller. The wrapper does not write protocol messages to stdout, so stdout remains JSONL-only for pi:

```bash
npm run pi -- --mode rpc --no-session
```

## Resource Discovery

Pi discovers these resources from the project root:

- Context: `AGENTS.md`
- Project skills: `.pi/skills/` and `../skills` from `.pi/settings.json`
- Prompt templates: `.pi/prompts/*.md`
- Package resources: `package.json#pi`

Useful pi commands inside an interactive session:

```text
/skill:podcast-football-harness
/inspect-report inputs/20260522/2026-05-22_ajax-vs-groningen.html
/run-pipeline inputs/20260522/2026-05-22_ajax-vs-groningen.html
/fix-escalation out/20260522/2026-05-22_ajax-vs-groningen
```

## Default Runtime Posture

- Use pi's built-in `read`, `grep`, `find`, `ls`, `bash`, `edit`, and `write` tools.
- Do not require cloud credentials for basic verification; the project has deterministic dialogue and stub TTS fallbacks.
- Use `HARNESS_SKIP_RENDER=1` for fast local checks unless the user specifically needs final MP4 rendering.
- Treat `out/` as generated output unless explicitly asked to preserve artifacts.