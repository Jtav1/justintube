# Justintube

A self-hosted video platform: YouTube-like frontend, self-hosted transcoding pipeline, and shared watch sessions (CAST). Built contract-first — the API surface is specified in OpenAPI, and work tracks toward completing each documented endpoint.

This software is a collaborative effort between myself (Justin) and a few friends who can choose to add themselves to this readme and other docs :)

## Why

I (Justin) have been hosting a MediaCMS instance for a long time for myself and friends to use for fun, but I find it lacking in a few ways and I've always wanted to tackle developing one specifically tailored to our needs instead of maintained by someone else. Plus I'm tired of keeping it updated.

Quick shout out to them though, https://mediacms.io/ https://github.com/mediacms-io/mediacms if you are looking at this project you will probably be better served by MediaCMS until I remove this warning. However Justintube is not a fork and shares zero code or ideas with them - I'm not patient enough to bother doing that lol

## What it will do

- **Video platform basics** — upload (including yt-dlp URL import as a bonus/stretch goal feature), FFmpeg transcoding to multiple resolutions with configurable hardware acceleration (also a bonus feature), tagging, search with typeahead suggestions, subscriptions, likes, playlists, watch history, and notifications.
- **Access control** — email-verified accounts with optional SSO linking (another bonus feature), RBAC roles (Admin / Moderator / Uploader / Viewer / Locked), and per-video visibility (public, private with grants, hidden, unlisted).
- **CAST shared watch sessions** — start a session from a playlist or a single video, share a session code, and watch together: a live session queue (a copy seeded from the playlist — the source is never mutated), synced play/pause/skip/seek for everyone, presence, an activity feed, emoji reactions, and an in-app display view for casting to a TV. Realtime sync runs over Socket.IO (namespace `/cast`, one room per session). Ported from the dixtube-live prototype.
- **Admin tools** — user/role management, API keys, system config, transcode profiles, featured videos, moderation (de-listing, bans).

See [docs/Planned Views.md](docs/Planned%20Views.md) for the product UI sketch, [webapi/openapi.yaml](webapi/openapi.yaml) for the OpenAPI base document, and [docs/API_Checklist.md](docs/API_Checklist.md) for implementation progress.

## Getting started

Requires **Node.js 20+** (developed against Node 24; recommended). The Web API can use **SQLite** (local default) or **MySQL**.

### Running the entire project

```bash
docker compose up -d
```

That should work; if it didn't then I have lost my way.

Compose brings up Redis, the processing service, and the API (shared media volume). See [processing/README.md](processing/README.md) for download/transcode details.

### (DEV) Running the Web API by itself

```bash
cd webapi
cp .env.example .env   # edit as needed
npm install
npm run dev            # loads .env, auto-reload via node --watch
# npm run dev:compose  # auto-reload without reading .env
npm test
```

Default listen port is `PORT` (3000). Useful URLs:

| URL             | What                                      |
| --------------- | ----------------------------------------- |
| `/health`       | Liveness probe                            |
| `/docs`         | Scalar API reference                      |
| `/openapi.json` | OpenAPI document (YAML + route `@openapi`) |
| `/api/v1/...`   | Public application API (WIP)              |
| `/internal/...` | Service-to-service callbacks              |

More detail: [webapi/README.md](webapi/README.md).

### (DEV) Running the processing service

```bash
cd processing
cp .env.example .env
npm install
npm run serve          # Node process on PORT (default 3001)
# or: npm run dev / npm start — see processing/README.md
```

Needs Redis for transcode queue routes. Callbacks to the Web API use `API_BASE_URL` + `INTERNAL_SERVICE_TOKEN`.

### (DEV) Running the web view

tbd

## Project layout

| Path | Role |
| ---- | ---- |
| [`webapi/`](webapi/) | Public Web API (Express, Sequelize, sessions / API keys) |
| [`processing/`](processing/) | yt-dlp downloads + BullMQ/ffmpeg transcodes |
| [`docs/`](docs/) | Product notes, API checklist, [code standards](docs/code-standards.md) |
| [`docker-compose.yml`](docker-compose.yml) | Redis + API + processing stack |

## License

See [LICENSE.md](LICENSE.md).
