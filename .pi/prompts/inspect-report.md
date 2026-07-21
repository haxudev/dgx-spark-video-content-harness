---
description: Inspect one football report and recommend parser or planning changes
argument-hint: "<html-report>"
---
Use the `podcast-football-harness` skill.

Inspect `$1` with:

```bash
npm run harness -- inspect $1
```

Summarize the block distribution, unknown percentage, high-importance blocks, and the cheapest next code change if the report is not parsed well. Do not edit files unless the inspection output clearly points to a local fix.