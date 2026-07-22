# justintube-processing

Express API that:

1. Downloads videos with [yt-dlp](https://github.com/yt-dlp/yt-dlp) into `MEDIA_STORAGE_DIRECTORY`
2. Queues ffmpeg transcodes with [BullMQ](https://docs.bullmq.io/) + Redis

Shared media layout (same volume as the API service in compose):

| Path | Purpose |
| ---- | ------- |
| `$MEDIA_STORAGE_DIRECTORY/original` | Source uploads (API writes here) |
| `$MEDIA_STORAGE_DIRECTORY/transcoded` | FFmpeg outputs |

## Setup

```bash
cp .env.example .env
npm install
```

Requires Docker for `dev` / `start`, and a reachable Redis for transcode routes.

Callbacks to the web API require:

- `API_BASE_URL` — base URL of the Justintube API (compose: `http://api:3000`)
- `INTERNAL_SERVICE_TOKEN` — shared bearer token (must match the API)

Transcoding is controlled through `.env`:

- `ENABLE_TRANSCODING=true` enables software transcoding by default.
- `ENABLE_HW_ACCELERATED_TRANSCODING=true` and a non-empty
  `GPU_ACCELERATION_DEVICE` switch video encoding to hardware mode.
- `HW_ACCELERATED_TRANSCODING_ENCODERS` must be a JSON array such as
  `["h264_qsv","hevc_qsv"]`. In hardware mode, `profile.videoCodec` must
  exactly match an encoder in that allowlist.

## Run

| Script        | What it does                                         |
| ------------- | ---------------------------------------------------- |
| `npm run serve` | Start the Node process (`node index.js`)           |
| `npm run dev` | Build image and run container on port 3001           |
| `npm start`   | Start via root `docker-compose` `processing` service |
| `npm test`    | Run unit / route contract tests                      |

Compose services: `redis` + `processing` (shared `media-data` volume at `/media`).

## API

### `GET /health`

Liveness probe. Includes whether a Redis-backed queue is configured.

### `POST /download`

JSON body `{ "url": "https://..." }`

```bash
curl -X POST http://localhost:3001/download \
  -H 'Content-Type: application/json' \
  -d '{"url":"https://www.youtube.com/watch?v=…"}'
```

Success: `{ "success": true, "filename": "<epoch>.<ext>" }`  
Error: `{ "success": false, "error": "…" }`

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
    "audioCodec": "aac"
  }
}
```

Batch body (preferred; used by the web API after upload):

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
        "audioCodec": "aac"
      }
    }
  ]
}
```

```bash
curl -X POST http://localhost:3001/transcode \
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

Removes a job from Redis (used by API reconciliation after failures).

Success (`200`): `{ "success": true, "jobId": "<uuid>", "removed": true }`  
Unknown id: `{ "success": false, "error": "job not found" }` (`404`)
