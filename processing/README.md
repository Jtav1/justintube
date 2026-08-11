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

### `POST /download`

JSON body `{ "url": "https://..." }`

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
