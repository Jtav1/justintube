# Justintube

A self-hosted video platform: YouTube-like frontend, self-hosted transcoding pipeline, and shared watch sessions (CAST) (FUTURE!). Built from the bottom up because you know back end is best

This software is a collaborative effort between myself (Justin) and a few friends who can choose to add themselves to this readme and other docs :)

## Why

I (Justin) have been hosting a MediaCMS instance for a long time for myself and friends to use for fun, but I find it lacking in a few ways and I've always wanted to tackle developing one specifically tailored to our needs instead of maintained by someone else. Plus I'm tired of keeping it updated.

Quick shout out to them though, https://mediacms.io/ https://github.com/mediacms-io/mediacms if you are looking at this project you will probably be better served by MediaCMS until I remove this warning. However Justintube is not a fork and shares zero code or ideas with them - I'm not patient enough to bother doing that lol

## Versioning

v1.1.x - Alpha releases
- Unstable and structural changes. Data will be deleted and manipulated

v1.2.x - Beta releases
- Longer term (X weeks) features that may or may not cause unstability

v2.0.0 - Initial production release
- All initial planned features implemented and site is ready for use. Anything additional should not break or delete any data from production instances

## What it does

- **Video platform basics** — upload (including yt-dlp URL import), FFmpeg transcoding to multiple resolutions with configurable hardware acceleration (WIP/FUTURE), video tagging, search with typeahead suggestions, subscriptions, likes, playlists, watch history, and notifications.
- **Access control** — email-verified accounts with (FUTURE) optional SSO linking, RBAC roles (Admin / Moderator / Uploader / Viewer / Locked), and per-video visibility (public, private with grants, hidden, unlisted).
- **CAST shared watch sessions** — (FUTURE/PLANNED) start a session from a playlist or a single video, share a session code, and watch together: a live session queue (a copy seeded from the playlist — the source is never mutated), synced play/pause/skip/seek for everyone, presence, an activity feed, emoji reactions, and an in-app display view for casting to a TV. Realtime sync runs over Socket.IO (namespace `/cast`, one room per session). Based on the dixtube-live prototype by [SpinnerMaster][https://github.com/SpinnerMaster]
- **Admin tools** — user/role management, API keys (FUTURE), system config (WIP), transcode profiles (FUTURE), featured videos, moderation (de-listing, bans).

See [webapi/openapi.yaml](webapi/openapi.yaml) for the OpenAPI base document and [docs/api-checklist.md](docs/api-checklist.md) for implementation progress.

## Getting started

Requires **Node.js 20.6+** for `webapi/` and `webview/`, and `processing/`. The Web API can use **SQLite** (local default) or **MySQL**.

### Running the entire project

```bash
cp .env.example .env   # fill in required secrets - see docs/deployment.md
docker compose up -d --build
```

That should work; if it didn't then I have lost my way.

Compose brings up MySQL, Redis, Meilisearch, the processing service, the API, and the web view (shared media volume). `docker compose up` will refuse to start if a required secret in `.env` is left blank. See [processing/README.md](processing/README.md) for download/transcode details, and [docs/deployment.md](docs/deployment.md) for production hardening notes (TLS assumptions, secrets, network exposure, etc.). Currently all of these are required, I may in the future break it out and allow you to run the system without the extra containers and an existing DB. 

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

```bash
cd webview
cp .env.example .env   # edit as needed
npm install
npm run dev            # Vite dev server
```

Default listen port is Vite's default (`5173`). Talks to the Web API via `VITE_API_BASE_URL`. More detail: [webview/README.md](webview/README.md).

## Project layout

| Path | Role |
| ---- | ---- |
| [`webapi/`](webapi/) | Public Web API (Express, Sequelize, sessions / API keys) |
| [`processing/`](processing/) | yt-dlp downloads + BullMQ/ffmpeg transcodes |
| [`webview/`](webview/) | Web frontend (React + Vite) |
| [`docs/`](docs/) | Product notes, API checklist, [code standards](docs/code-standards.md), [deployment](docs/deployment.md) |
| [`docker-compose.yml`](docker-compose.yml) | Full stack: MySQL, Redis, Meilisearch, API, processing, web view |

## License

See [LICENSE.md](LICENSE.md).
