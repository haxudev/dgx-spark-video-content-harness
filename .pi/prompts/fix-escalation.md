---
description: Diagnose and fix a supervisor escalation from an output directory
argument-hint: "<out/date/match>"
---
Use the `podcast-football-harness` skill.

Diagnose the escalation in `$1` by reading:

```bash
$1/state.json
$1/escalation.json
$1/verify/*.json
```

Identify the phase, issue kinds, routed fallback, and likely root cause. Make a focused fix, then rerun only the smallest phase range needed to prove recovery.