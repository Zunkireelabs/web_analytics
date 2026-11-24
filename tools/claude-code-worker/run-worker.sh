#!/bin/sh
# Runs the Claude Code worker for the day's fix window, then stops it cleanly (SIGTERM: it finishes what it is writing and gives back anything unfinished).
# Token comes from the macOS keychain (service superrank-worker). Uses your own Claude Code login (WORKER_CLAUDE_CONFIG_DIR=default).
# Usage: run-worker.sh            (runs until 14:10 local time; override with WORKER_RUN_UNTIL=HH:MM)
set -eu
DIR="$(cd "$(dirname "$0")" && pwd)"
export SUPERRANK_URL="${SUPERRANK_URL:-https://app.superrank.si}"
export WORKER_CLAUDE_CONFIG_DIR="${WORKER_CLAUDE_CONFIG_DIR:-default}"
UNTIL="${WORKER_RUN_UNTIL:-14:10}"
NODE="${NODE_BIN:-$(command -v node)}"

now=$(date +%s)
end=$(date -j -f "%Y-%m-%d %H:%M:%S" "$(date +%Y-%m-%d) $UNTIL:00" +%s)
[ "$end" -gt "$now" ] || { echo "past $UNTIL today, not starting"; exit 0; }

"$NODE" "$DIR/worker.mjs" &
WORKER=$!
trap 'kill -TERM "$WORKER" 2>/dev/null || true' INT TERM
# caffeinate keeps the laptop awake (lid open) while the worker runs; it ends with the worker.
caffeinate -i -w "$WORKER" &
while kill -0 "$WORKER" 2>/dev/null && [ "$(date +%s)" -lt "$end" ]; do sleep 20; done
kill -TERM "$WORKER" 2>/dev/null || true
wait "$WORKER" 2>/dev/null || true
