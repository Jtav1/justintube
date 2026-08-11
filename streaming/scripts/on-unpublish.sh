#!/bin/sh
# Runs when a publish stops being available (see runOnUnavailable in
# mediamtx.yml). Mirrors on-publish.sh's resolve step since MediaMTX hooks
# are stateless, separate invocations that only get $MTX_PATH again.
set -eu

RAW_KEY="${MTX_PATH#live/}"

AUTH=$(curl -sf -X POST "$API_BASE_URL/internal/livestreams/authorize" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"streamKey\":\"$RAW_KEY\"}")

LIVESTREAM_ID=$(echo "$AUTH" | jq -r .livestreamId)
USER_ID=$(echo "$AUTH" | jq -r .userId)

curl -sf -X POST "$API_BASE_URL/internal/livestreams/$LIVESTREAM_ID/stop" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" >/dev/null

# Tear down the playback alias path added in on-publish.sh. Tolerant of it
# already being gone (e.g. re-run after a crash).
curl -sf -X DELETE "http://127.0.0.1:9997/v3/config/paths/delete/live/$USER_ID" >/dev/null || true
