---
name: av-sync-verifier
description: |
  Verification strategies for ensuring rendered video stays in sync with the
  source AudioManifest. Tolerances, fingerprinting and frame-OCR techniques
  used by phases 06 / 08 / 10.
---

# av-sync-verifier

## Source of truth

`audio/manifest.json` is the **only** time reference downstream of TTS. Every
`composition.html` `data-start` and every GSAP timeline keyframe is computed
from manifest entries — not from plan target seconds, which are estimates.

## Tolerance ladder

| Layer            | Metric                                           | Tolerance | On breach                              |
|------------------|--------------------------------------------------|-----------|----------------------------------------|
| 06 VERIFY_AUDIO  | per-scene `actualSec` vs `plan.targetSec`        | ±8%       | Adjust `<prosody rate>` and re-TTS    |
| 06 VERIFY_AUDIO  | scene N start ≥ scene N-1 end                    | 0ms       | Hard error → re-TTS                    |
| 06 VERIFY_AUDIO  | inter-scene gap                                  | ≤ 600ms   | Warn (cosmetic)                        |
| 06 VERIFY_AUDIO  | WAV sample rate / channels                       | 24k / 1   | Warn (downstream loudness drift)       |
| 10 VERIFY_AV     | mp4 duration vs manifest.totalSec                | ±500ms    | Hard error → re-COMPOSE                |
| 10 VERIFY_AV     | per-line audio onset (fingerprint)               | ±50ms     | Hard error → re-COMPOSE (re-stitch)    |
| 10 VERIFY_AV     | frame OCR @ line.startSec includes first 6 chars | fuzzy     | Warn unless 3+ adjacent fail           |

## Fingerprint matching (per-line audio onset)

For each manifest line:

1. Read original WAV (24kHz mono PCM).
2. Extract `ffmpeg -ss line.startSec -t 0.5 final.mp4 -ac 1 -ar 24000 -f s16le -`.
3. Cross-correlate the first 8000 samples of both signals; argmax = drift.

Use FFT-based correlation (sliding window across ±100ms search range) — runs
in ~10ms per line. Total time for 60-line video: ~600ms.

## Frame OCR fallback (visual onset)

```bash
ffmpeg -y -ss <line.startSec + 0.4> -i final.mp4 -frames:v 1 verify/f.png
tesseract verify/f.png - -l chi_sim
```

Apply fuzzy match: rendered caption should contain ≥ 4 of the first 6 chars of
`line.text` (allows for caption typography differences).

## Failure routing (from `stateMachine.ts`)

```
VERIFY_AV fail → COMPOSE retry (≤2) → re-emit data-start with fingerprint offsets baked in
COMPOSE retry exhausted → escalation.json
```

## Implementation status

- Phase 06: structural drift + continuity ✔
- Phase 08: token / element-count lint ✔
- Phase 10: mp4 duration probe ✔; fingerprint + OCR TODO (deferred until first
  real-render integration test).
