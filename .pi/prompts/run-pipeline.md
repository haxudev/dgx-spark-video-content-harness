---
description: Run the podcast-football pipeline for a report or directory
argument-hint: "<html-or-dir> [phase/range notes]"
---
Use the `podcast-football-harness` skill.

Run the pipeline target `$1` using the requested phase or range from these notes: `${@:2}`.

On this host (haxu / linux) the verified-working invocation is:

```bash
env GX10_OPENAI_BASE_URL= GX10_MODEL_NAME= \
    PUPPETEER_EXECUTABLE_PATH=/home/haxu/.cache/puppeteer/chrome/linux-131.0.6778.204/chrome-linux64/chrome \
    npm run harness -- run $1
```

For fast text-only iteration, prepend `HARNESS_SKIP_RENDER=1` and append `--to AUDIT_TALK`. For HTML structural checks without final-frame review, use `--to VERIFY_VISUAL`. For Qwen image review, run the full render and set `HARNESS_VISUAL_AUDIT_LLM=1` before `--to AUDIT_VISUAL` or `--to POST`. See `docs/runbook-execution.md` for the provider/timing matrix and the rationale for blanking the GX10 vars during WRITE.

If a phase fails, inspect `state.json`, `verify/*.json`, and `escalation.json`, then make the smallest code or template fix and rerun the relevant phase/range.