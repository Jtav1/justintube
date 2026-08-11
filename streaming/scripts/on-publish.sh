#!/bin/sh
# Runs when a publish becomes available (see runOnAvailable in mediamtx.yml).
# MediaMTX execs this directly (no shell wrapping), so all multi-step logic
# lives here rather than inline in the yaml. $MTX_PATH/$API_BASE_URL/
# $INTERNAL_SERVICE_TOKEN come from MediaMTX's hook env / the container env.
set -eu

RAW_KEY="${MTX_PATH#live/}"

AUTH=$(curl -sf -X POST "$API_BASE_URL/internal/livestreams/authorize" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"streamKey\":\"$RAW_KEY\"}")

LIVESTREAM_ID=$(echo "$AUTH" | jq -r .livestreamId)
USER_ID=$(echo "$AUTH" | jq -r .userId)

curl -sf -X POST "$API_BASE_URL/internal/livestreams/$LIVESTREAM_ID/start" \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" >/dev/null

# Add a second, stable path keyed by userId (not the secret key) that
# re-pulls this stream from MediaMTX itself, so playback URLs never need
# the raw stream key - see GET /livestreams/:id/playback in webapi.
curl -sf -X POST "http://127.0.0.1:9997/v3/config/paths/add/live/$USER_ID" \
  -H "Content-Type: application/json" \
  -d "{\"source\":\"rtmp://127.0.0.1:1935/$MTX_PATH\"}" >/dev/null
