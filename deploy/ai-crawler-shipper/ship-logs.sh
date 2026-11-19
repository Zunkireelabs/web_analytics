#!/bin/sh
# Hourly log shipper for AI crawler analytics. Runs on the WEB SERVER that hosts a client's site, from cron, one config file
# per site. It sends only the access-log lines that could be an AI crawler (a broad filter on the user-agent field; the app does
# the exact matching and verification) to the analytics app, which turns them into daily counts and throws the lines away.
# Ordinary visitors' lines never leave the server.
#
#   ship-logs.sh /etc/ai-crawler-shipper/superrank.conf            # normal run (cron)
#   DRY_RUN=1 ship-logs.sh /etc/ai-crawler-shipper/superrank.conf  # show what WOULD be sent; sends nothing, changes no state
#
# Config file (sourced by this script; keep it root-owned, mode 600):
#   CONTAINER=superrank-web-prod                                   required: the nginx container whose logs to read
#   ENDPOINT=https://app.example.com/api/ai-crawlers/ingest        required: the analytics app's ingest URL
#   TOKEN_FILE=/etc/ai-crawler-shipper/superrank.token             required: a file holding the project's upload token (mode 600)
#   STATE_FILE=/var/lib/ai-crawler-shipper/superrank.state         optional (this is the default)
#   FIRST_SINCE=24h                                                optional: how far back the very first run reads
#   CHUNK_LINES=8000                                               optional: lines per upload (the app accepts 5 MB per upload)
#   LOG_CMD=...                                                    optional: replaces the `docker logs` command (used by tests)
#
# Safe to re-run and to overlap: a lock stops two runs at once; a failed upload leaves the window pending and the next run retries
# EXACTLY the same window, so a retry can never count a line twice (the app ignores a repeated identical upload).
set -eu

CONFIG="${1:-}"
[ -n "$CONFIG" ] && [ -r "$CONFIG" ] || { echo "usage: $0 <config-file>" >&2; exit 2; }
# shellcheck disable=SC1090
. "$CONFIG"

: "${CONTAINER:?CONTAINER is not set in $CONFIG}"
: "${ENDPOINT:?ENDPOINT is not set in $CONFIG}"
: "${TOKEN_FILE:?TOKEN_FILE is not set in $CONFIG}"
STATE_FILE="${STATE_FILE:-/var/lib/ai-crawler-shipper/$(basename "$CONFIG" .conf).state}"
FIRST_SINCE="${FIRST_SINCE:-24h}"
CHUNK_LINES="${CHUNK_LINES:-8000}"
DRY_RUN="${DRY_RUN:-0}"

[ -r "$TOKEN_FILE" ] || { echo "cannot read token file $TOKEN_FILE" >&2; exit 2; }
# A token readable by other users defeats the point of a token file.
# (Read from `ls -l`, not `find -perm`, whose syntax differs between Linux and macOS: characters 5-10 are the group and other bits.)
case "$(ls -ld "$TOKEN_FILE" | cut -c5-10)" in
  ------) ;;
  *) echo "token file $TOKEN_FILE must not be accessible by group or others (chmod 600)" >&2; exit 2 ;;
esac
TOKEN="$(tr -d ' \n\r' < "$TOKEN_FILE")"
[ -n "$TOKEN" ] || { echo "token file $TOKEN_FILE is empty" >&2; exit 2; }

mkdir -p "$(dirname "$STATE_FILE")"
LOCK="$STATE_FILE.lock"
# A lock left by a crashed run is ignored after 2 hours.
[ -d "$LOCK" ] && [ -n "$(find "$LOCK" -maxdepth 0 -mmin +120 2>/dev/null)" ] && rmdir "$LOCK" 2>/dev/null || true
if ! mkdir "$LOCK" 2>/dev/null; then echo "another run is in progress (lock $LOCK); skipping" >&2; exit 0; fi
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"; rmdir "$LOCK" 2>/dev/null || true' EXIT

# State: line 1 = the end of the last window that was fully delivered; line 2 (only after a failed run) = the end of the window
# that is still pending, so the retry reads the identical window.
LAST_OK=""; PENDING=""
if [ -f "$STATE_FILE" ]; then LAST_OK="$(sed -n 1p "$STATE_FILE")"; PENDING="$(sed -n 2p "$STATE_FILE")"; fi
SINCE="${LAST_OK:-$FIRST_SINCE}"
NOW="${PENDING:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
export SINCE NOW CONTAINER

if [ "$DRY_RUN" != "1" ]; then printf '%s\n%s\n' "$LAST_OK" "$NOW" > "$STATE_FILE"; fi   # window is now pending until it is delivered

LOG_CMD="${LOG_CMD:-docker logs --since \"\$SINCE\" --until \"\$NOW\" \"\$CONTAINER\" 2>&1}"
# A failed read (container missing, docker down) stops here, loudly, with the window still pending.
sh -c "$LOG_CMD" > "$TMP/raw"

# Broad on purpose: anything whose user agent might be an AI crawler. The app decides exactly which. Our own analytics agent is
# dropped here because it makes thousands of requests a day and is never counted.
awk -F'"' '{ ua = tolower($6); if (ua ~ /bot|crawl|spider|agent|fetch|indexer|-user|gpt|claude|perplex|google|meta-/ && ua !~ /zunkireeanalyticsbot/) print }' "$TMP/raw" > "$TMP/lines"
TOTAL="$(wc -l < "$TMP/raw" | tr -d ' ')"
KEEP="$(wc -l < "$TMP/lines" | tr -d ' ')"

if [ "$DRY_RUN" = "1" ]; then
  echo "dry run: window $SINCE -> $NOW, read $TOTAL log lines, $KEEP would be sent (the rest never leave this server)"
  exit 0
fi

post() {
  curl -sS --fail --max-time 60 -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: text/plain' \
    --data-binary @"$1" -o "$TMP/response" "$ENDPOINT"
}

if [ "$KEEP" -eq 0 ]; then
  : > "$TMP/empty"; post "$TMP/empty"      # nothing to report, but still a sign of life for the dashboard
else
  split -l "$CHUNK_LINES" "$TMP/lines" "$TMP/part."
  for part in "$TMP"/part.*; do post "$part"; done
fi

printf '%s\n' "$NOW" > "$STATE_FILE"      # delivered: the next window starts here, and nothing is pending
echo "shipped window $SINCE -> $NOW: read $TOTAL lines, sent $KEEP"
