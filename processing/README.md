# Justintube processing (`processing/`)

Express API that:

1. Downloads videos with [yt-dlp](https://github.com/yt-dlp/yt-dlp) into `MEDIA_STORAGE_DIRECTORY`
2. Queues ffmpeg transcodes with [BullMQ](https://docs.bullmq.io/) + Redis

This service is called by the [Web API](../webapi/) after uploads (and for URL import later). When a transcode or thumbnail job finishes or fails, it callbacks to the Web API under `/internal/file-versions/...` or `/internal/thumbnails/...` respectively. Every upload/import always enqueues a thumbnail (single-frame WebP extraction) job alongside any rendition jobs, regardless of transcode profile count.

Shared media layout (same volume as the Web API in compose):

| Path | Purpose |
| ---- | ------- |
| `$MEDIA_STORAGE_DIRECTORY/original` | Source uploads (Web API writes here) |
| `$MEDIA_STORAGE_DIRECTORY/transcoded` | FFmpeg rendition outputs |
| `$MEDIA_STORAGE_DIRECTORY/thumbnails` | Auto-generated video thumbnails (WebP) |

Default listen port: `PORT` (3001).

## Requirements

- Node.js **≥ 24** (see `package.json` `engines` — stricter than `webapi/`'s ≥20.6)
- Docker for `dev` / `start`
- A reachable Redis for transcode routes

## Setup

```bash
cp .env.example .env
npm install
```

Callbacks to the Web API require:

- `API_BASE_URL` — base URL of the Justintube Web API (compose: `http://api:3000`; local: `http://localhost:3000`)
- `INTERNAL_SERVICE_TOKEN` — shared bearer token (must match the Web API)

Transcoding is controlled through `.env`:

- `ENABLE_TRANSCODING=true` enables transcoding at all (software or hardware).
- `ENABLE_HW_ACCELERATED_TRANSCODING=true` and a non-empty
  `GPU_ACCELERATION_DEVICE` make hardware-accelerated encoding *available* on
  this deployment.
- `HW_ACCELERATED_TRANSCODING_ENCODERS` must be a JSON array such as
  `["h264_qsv","hevc_qsv"]` — the allowlist of encoder names hardware jobs may use.

These three vars govern which profiles **can** run in hardware, not whether any
given job **does** — that's decided per-job by the incoming `profile.hardwareAccelerated`
boolean (set on the `TranscodeProfile` in the Web API). Software profiles
(`hardwareAccelerated: false`) always encode in software regardless of the above.
A hardware profile whose job isn't currently runnable is skipped, not treated as
a request error — see `skipped[].reason` below.

**IMPORTANT NOTE:** There are some hardcoded hw transcoding stuff that may be specific to my '''''production''''' homelab server with a gen 9.5 comet lake uhd630. If someone else ever wants to run this pls open an issue on the repo if it breaks for you. I may or may not look into it 

## Run

| Script | What it does |
| ------ | ------------ |
| `npm run serve` | Start the Node process (`node index.js`) |
| `npm run dev` | Build image and run container on port 3001 |
| `npm start` | Start via root `docker-compose` `processing` service |
| `npm test` | Run unit / route contract tests |

Compose services: `redis` + `processing` (shared `media-data` volume at `/media`). See the root [README](../README.md) and [docker-compose.yml](../docker-compose.yml).

## API

Every route below `/health` requires `Authorization: Bearer $INTERNAL_SERVICE_TOKEN`
(see `lib/require-internal-token.js`) — this service is meant to be reached only
by `webapi` over the private Docker network; the token is defense-in-depth for
the case where that boundary doesn't hold.

### `GET /health`

Liveness probe. Includes whether a Redis-backed queue is configured, and current
hardware-accelerated transcoding availability:

```json
{
  "status": "ok",
  "redis": "configured",
  "hardwareAcceleration": { "enabled": true, "encoders": ["h264_qsv", "hevc_qsv"] }
}
```

Not gated by the internal token. Polled by the Web API's
`GET /admin/transcode-profiles/hardware-status` to shape the admin profile UI.

### Shared yt-dlp options

Every route in this section accepts these optional fields alongside `url`:

- `cookies` — raw Netscape-format `cookies.txt` content (e.g. exported from a
  browser extension), for sites/videos that need an authenticated session.
  Written to a `0600` temp file for the single yt-dlp invocation that needs
  it, then deleted immediately afterward — success or failure. Never logged,
  never echoed back, never persisted anywhere else. Capped at ~1MB.
- `rateLimit` — `--limit-rate` value, e.g. `"2M"` or `"500K"`.
- `retries` — `--retries` value, capped by `MAX_YTDLP_RETRIES` (default 20).

### `POST /download`

JSON body `{ "url": "https://...", "cookies"?: "...", "rateLimit"?: "2M", "retries"?: 5 }`

```bash
curl -X POST http://localhost:3001/download \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=…"}'
```

Success: `{ "success": true, "filename": "<epoch>.<ext>", "hasVideo": true|false }`  
Error: `{ "success": false, "error": "…" }`

`hasVideo` reflects whether ffprobe found a video stream in the downloaded file (yt-dlp's
format selector falls back to `bestaudio` for audio-only sources). webapi prefers this
ffprobe-based signal over sniffing the file extension, since an audio-only download can land
in an ambiguous container (e.g. opus-in-webm) that extension alone can't distinguish from a
video webm.

### `POST /download/audio`

JSON body `{ "url": "https://...", "audioFormat"?: "mp3" }` (plus the shared yt-dlp options above).

Downloads only the audio from a URL — no video stream, no muxed container. Uses yt-dlp's
`-f bestaudio/best -x --audio-format <audioFormat>` (ffmpeg-backed extraction under the hood),
preferring a genuinely audio-only source format so no video is even downloaded in the first
place; only falls back to downloading combined video+audio and extracting when a source has no
separate audio-only format. `audioFormat` defaults to `"best"` (remux into whatever container
matches the source's native codec, no re-encode) — one of `best`, `aac`, `alac`, `flac`, `m4a`,
`mp3`, `opus`, `vorbis`, `wav`.

```bash
curl -X POST http://localhost:3001/download/audio \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=…","audioFormat":"mp3"}'
```

Success: `{ "success": true, "filename": "<epoch>.<ext>" }`  
Error: `{ "success": false, "error": "…" }`

### `POST /download/format`

JSON body `{ "url": "https://...", "formatId": "137" }` (plus the shared yt-dlp options above).

Downloads a URL in a specific, caller-chosen format — as opposed to `POST /download`'s fixed
≤1080p auto-selection. `formatId` must be one of the `formatId` values `POST /download/probe`
returned for this same URL; **this is re-checked against a live probe on every request**, not
trusted from whatever the caller last saw — formats vary per video and change over time. If
`formatId` isn't currently available, the request fails with `400` and a message pointing back
at `/download/probe`:

```json
{ "success": false, "error": "formatId \"999\" is not currently available for this URL — call POST /download/probe first to determine valid formats" }
```

When the chosen format is video-only (common for high-resolution formats), it's automatically
paired with the best available audio track for muxing.

```bash
curl -X POST http://localhost:3001/download/format \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=…","formatId":"137"}'
```

Success: `{ "success": true, "filename": "<epoch>.<ext>", "hasVideo": true|false }`  
Error: `{ "success": false, "error": "…" }`

### `POST /download/probe`

JSON body `{ "url": "https://..." }` (plus the shared yt-dlp options above).

Fetches metadata without downloading anything (`yt-dlp --skip-download -J`), so a caller can
preview a title/thumbnail/duration and available formats before committing to `POST /download`.
Always resolves a single video, even for a playlist URL (`--no-playlist`, same as `/download`) —
use `/download/playlist/probe` to enumerate a playlist.

```bash
curl -X POST http://localhost:3001/download/probe \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=…"}'
```

Success (`200`):

```json
{
  "success": true,
  "id": "abc123",
  "title": "…",
  "description": "…",
  "uploader": "…",
  "durationSeconds": 213,
  "thumbnail": "https://…",
  "webpageUrl": "https://…",
  "extractor": "youtube",
  "formats": [
    { "formatId": "137", "ext": "mp4", "height": 1080, "width": 1920, "vcodec": "avc1…", "acodec": null, "fps": 30, "filesizeBytes": 12345678, "tbr": 4500, "formatNote": "1080p" }
  ]
}
```

### `POST /download/playlist/probe`

JSON body `{ "url": "https://...", "limit"?: 50 }` (plus the shared yt-dlp options above).

Enumerates a playlist/channel URL's entries via yt-dlp's flat-playlist mode — fast, since it
doesn't fetch each entry's full metadata. `limit` is clamped to `MAX_PLAYLIST_PROBE_ITEMS`
(default 200).

Success (`200`):

```json
{
  "success": true,
  "playlistTitle": "…",
  "playlistId": "…",
  "entryCount": 2,
  "truncated": false,
  "entries": [
    { "url": "https://…", "id": "abc123", "title": "…", "durationSeconds": 213, "uploader": "…" }
  ]
}
```

### `POST /download/playlist`

JSON body `{ "url": "https://...", "limit"?: 10 }` (plus the shared yt-dlp options above).

Enumerates the playlist/channel (same as `/download/playlist/probe`, capped by
`MAX_PLAYLIST_DOWNLOAD_ITEMS`, default 25) and downloads each entry **sequentially** with
`downloadUrl`, one HTTP request in and one HTTP response out. This is not queued — kept
deliberately small/synchronous like `/download` itself. One entry failing doesn't abort the
rest; each is reported individually.

Success (`200`):

```json
{
  "success": true,
  "playlistTitle": "…",
  "playlistId": "…",
  "total": 2,
  "succeeded": 1,
  "failed": 1,
  "results": [
    { "url": "https://…", "title": "…", "success": true, "filename": "1700000000.mp4", "hasVideo": true },
    { "url": "https://…", "title": "…", "success": false, "error": "…" }
  ]
}
```

### `POST /transcode`

Queues one or more ffmpeg jobs for a basename under `/media/original`.

Legacy single-profile body:

```json
{
  "filename": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4",
  "profile": {
    "id": 1,
    "outputHeight": 720,
    "outputWidth": 1280,
    "outputContainer": "mp4",
    "videoCodec": "h264",
    "audioCodec": "aac",
    "hardwareAccelerated": false
  }
}
```

Batch body (preferred; used by the Web API after upload):

```json
{
  "filename": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4",
  "jobs": [
    {
      "jobId": "11111111-1111-1111-1111-111111111111",
      "outputFilename": "11111111-1111-1111-1111-111111111111.mp4",
      "profile": {
        "id": 1,
        "outputHeight": 720,
        "outputWidth": 1280,
        "outputContainer": "mp4",
        "videoCodec": "h264",
        "audioCodec": "aac",
        "hardwareAccelerated": false
      }
    }
  ]
}
```

```bash
curl -X POST http://localhost:3001/transcode \
  -H "Authorization: Bearer $INTERNAL_SERVICE_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"filename":"…mp4","jobs":[…]}'
```

Success (`202`) for a single job (legacy-compatible fields plus `jobs`):

```json
{
  "success": true,
  "jobId": "<uuid>",
  "outputFilename": "<uuid>.mp4",
  "jobs": [{ "jobId": "<uuid>", "outputFilename": "<uuid>.mp4", "profileId": 1 }]
}
```

Success (`202`) for a batch:

```json
{
  "success": true,
  "jobs": [
    { "jobId": "<uuid>", "outputFilename": "<uuid>.mp4", "profileId": 1 }
  ]
}
```

Jobs that can't run are listed under `skipped` (with a `reason`) rather than
failing the whole request; remaining jobs in the batch are processed normally.
Reasons:

- `profile_exceeds_source_resolution` — the profile's output width/height
  exceeds the probed source video.
- `hardware_transcoding_unavailable` — the profile has `hardwareAccelerated: true`,
  but this deployment doesn't currently have hardware transcoding enabled/configured
  (`ENABLE_HW_ACCELERATED_TRANSCODING`/`GPU_ACCELERATION_DEVICE`).
- `hardware_encoder_not_configured` — the profile has `hardwareAccelerated: true`
  and hardware transcoding is enabled, but this profile's `videoCodec` isn't in
  the `HW_ACCELERATED_TRANSCODING_ENCODERS` allowlist.
- `profile_orientation_mismatch` — the profile's orientation (horizontal:
  `outputWidth > outputHeight`, vertical: `outputHeight > outputWidth`) doesn't
  match the probed source's orientation. Square profiles/sources are
  orientation-agnostic and are never skipped for this reason. Checked last,
  after the resolution and hardware checks above.

Software profiles (`hardwareAccelerated: false`) are never skipped for hardware
reasons. The response also includes probed `source` dimensions.

When a job finishes, the worker runs `stat` + `ffprobe`, then POSTs metadata to
`{API_BASE_URL}/internal/file-versions/:jobId/complete` (Bearer
`INTERNAL_SERVICE_TOKEN`). Failures POST to `/fail`.

The output file is written to `/media/transcoded/<outputFilename>` when the job completes.

### `GET /transcode/:jobId`

Returns BullMQ job state from Redis.

Success (`200`):

```json
{
  "success": true,
  "jobId": "<uuid>",
  "state": "completed",
  "progress": 100,
  "outputFilename": "<uuid>.mp4",
  "profileId": 1,
  "failedReason": null,
  "returnvalue": {
    "outputFilename": "<uuid>.mp4",
    "profileId": 1,
    "fileSizeBytes": 12345,
    "videoWidth": 1280,
    "videoHeight": 720,
    "resolution": "720p",
    "storagePath": "transcoded/<uuid>.mp4",
    "mimeType": "video/mp4"
  }
}
```

Unknown id: `{ "success": false, "error": "job not found" }` (`404`)

### `DELETE /transcode/:jobId`

Removes a job from Redis (used by Web API reconciliation after failures).

Success (`200`): `{ "success": true, "jobId": "<uuid>", "removed": true }`  
Unknown id: `{ "success": false, "error": "job not found" }` (`404`)
