#!/usr/bin/env bash
# daily-today.sh — 每日 14:00 北京时间，为 football.haxu.net 中 T+1 日的所有比赛
# 生成双人播客 MP4，输出到 openclaw-artifacts/{date}/
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
HARNESS="/app/dist/cli.js"
DB_ENDPOINT="https://ftvabvfqdrhgfhcejngc.supabase.co"
DB_KEY="sb_publishable_l4KGCygNyrlBVN63KXX7vg_S772r5bx"
OUT_ROOT="/app/out"
INPUTS_ROOT="/app/inputs/web"
ARTIFACTS_DIR="${OPENCLAW_ARTIFACTS_DIR:-/home/nuc/openclaw-artifacts}"

# ---- T+1 date (Beijing time) ----
T1=$(TZ=Asia/Shanghai date -d "+1 day" +%Y-%m-%d)
T1_NOHYPHEN="${T1//-/}"
DATE_DIR="${T1//-/}"

echo "=== daily-today: T+1=$T1 ($T1_NOHYPHEN) ==="

# ---- Fetch match IDs from Supabase (local filter: ilike/like return 500 on Supabase) ----
MATCH_IDS=$(curl -s \
  "$DB_ENDPOINT/rest/v1/envelopes?select=match_id&order=match_id.desc&limit=100" \
  -H "apikey: $DB_KEY" \
  -H "Authorization: Bearer $DB_KEY" \
  -H "Content-Type: application/json" 2>/dev/null \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
seen = set()
for d in data:
    mid = d.get('match_id', '')
    if mid.startswith('${T1_NOHYPHEN}') and mid not in seen:
        seen.add(mid)
        print(mid)
" 2>/dev/null)

if [ -z "$MATCH_IDS" ]; then
  echo "No T+1 matches found for $T1. Exiting."
  exit 0
fi

MATCH_COUNT=$(echo "$MATCH_IDS" | wc -l)
echo "Found $MATCH_COUNT matches:"
echo "$MATCH_IDS"

# ---- Create output directory ----
mkdir -p "$ARTIFACTS_DIR/$DATE_DIR"

# ---- Process each match ----
OK=0
FAIL=0

while IFS= read -r MATCH_ID; do
  [ -z "$MATCH_ID" ] && continue
  URL="https://football.haxu.net/match/${MATCH_ID}/"
  echo ""
  echo "▶ [$MATCH_ID] $URL"

  # Run harness (detached)
  docker exec -d podcast-football-agent sh -c \
    "cd /app && node $HARNESS run --url $URL --mode podcast \
     --result-json /app/out/result-${MATCH_ID}.json \
     > /app/out/run-${MATCH_ID}.log 2>&1"

  echo "  → run started (detached)"
  OK=$((OK + 1))
done <<< "$MATCH_IDS"

echo ""
echo "=== Batch dispatched: $OK total ==="
echo "Logs: $PROJECT_DIR/out/run-*.log"

# ---- Wait for all runs to complete and copy MP4s to artifacts ----
echo ""
echo "Waiting for all runs to complete..."

for MATCH_ID in $MATCH_IDS; do
  [ -z "$MATCH_ID" ] && continue
  
  # Wait until the run log is non-empty (run has started)
  LOG_FILE="$PROJECT_DIR/out/run-${MATCH_ID}.log"
  while [ ! -f "$LOG_FILE" ] || [ ! -s "$LOG_FILE" ]; do
    sleep 5
  done
  
  # Wait until the run completes (look for "✔" or "✖" marker)
  while ! grep -qE '^✔|✖' "$LOG_FILE" 2>/dev/null; do
    sleep 10
  done
  
  # Extract final MP4 path
  FINAL_MP4="$PROJECT_DIR/out/web/${MATCH_ID}/final.mp4"
  
  if [ -f "$FINAL_MP4" ]; then
    cp "$FINAL_MP4" "$ARTIFACTS_DIR/$DATE_DIR/"
    FILESIZE=$(stat -c%s "$FINAL_MP4" 2>/dev/null || echo "?")
    echo "✔ $MATCH_ID → $ARTIFACTS_DIR/$DATE_DIR/final-${MATCH_ID}.mp4 ($FILESIZE bytes)"
    # Rename to include date prefix
    BASENAME=$(basename "$FINAL_MP4")
    # Actually final.mp4 overwrites — use match ID as filename
    # Check if file already exists
    if [ -f "$ARTIFACTS_DIR/$DATE_DIR/final-${MATCH_ID}.mp4" ]; then
      echo "  [skip] already exists"
    else
      mv "$ARTIFACTS_DIR/$DATE_DIR/final-${MATCH_ID}.mp4" "$ARTIFACTS_DIR/$DATE_DIR/${MATCH_ID}.mp4" 2>/dev/null || true
    fi
  else
    echo "✖ $MATCH_ID — no final.mp4 found"
    FAIL=$((FAIL + 1))
  fi
done

echo ""
echo "=== Done: $OK dispatched, $((OK - FAIL)) ok, $FAIL failed ==="
echo "Artifacts: $ARTIFACTS_DIR/$DATE_DIR/"
