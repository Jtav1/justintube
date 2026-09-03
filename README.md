# Justintube

A self-hosted video platform: YouTube-like frontend, self-hosted transcoding pipeline, and shared watch sessions (CAST) (FUTURE!). Built from the bottom up because you know back end is best

This software is a collaborative effort between myself (Justin) and a few friends who can choose to add themselves to this readme and other docs :)

## Why

I, Justin, have been hosting a MediaCMS instance for a long time for myself and friends to use for fun, but I find it lacking in a few ways and I've always wanted to tackle developing one specifically tailored to our needs instead of maintained by someone else. Plus I'm tired of keeping it updated.

Quick shout out to them though, https://mediacms.io/ https://github.com/mediacms-io/mediacms if you are looking at this project you will probably be better served by MediaCMS. However Justintube is not a fork and shares zero code or ideas with them - I'm not patient enough to bother doing that lol

## What it does

- **Video platform basics** — upload (including yt-dlp URL import), FFmpeg transcoding to multiple resolutions with configurable hardware acceleration, video tagging, search with typeahead suggestions, subscriptions, likes, playlists, watch history, and notifications.
- **Access control** — email-verified accounts with optional SSO linking (FUTURE), RBAC roles (Admin / Moderator / Uploader / Viewer / Locked), and per-video visibility (public, private with grants, hidden, unlisted).
- **CAST shared watch sessions** — (FUTURE/PLANNED) start a session from a playlist or a single video, share a session code, and watch together: a live session queue (a copy seeded from the playlist — the source is never mutated), synced play/pause/skip/seek for everyone, presence, an activity feed, emoji reactions, and an in-app display view for casting to a TV. Realtime sync runs over Socket.IO (namespace `/cast`, one room per session). Based on the dixtube-live prototype by [SpinnerMaster][https://github.com/SpinnerMaster]
- **Admin tools** — user/role management, API keys, system config, transcode profiles, featured videos, moderation (de-listing, bans).

See [webapi/openapi.yaml](webapi/openapi.yaml) for the OpenAPI base document and [docs/api-checklist.md](docs/api-checklist.md) for implementation progress.

## Getting started

Requires **Node.js 20.6+** for `webapi/` and `webview/`, and `processing/`. The Web API can use **SQLite** (local default) or **MySQL**.

### Running the entire project

Copy the .env.example to .env and then customize it to your liking. REQUIRED stuff must be set, OPTIONAL is up to you, DEFAULTS can be left, and then EXPERIMENTAL do what you want man see what happens

Once you do that, you can run the docker-compose.yml. Make sure you completely read the .env and docker-compose first. Make sure you know whats going on. 

```bash
cp .env.example .env   # fill in required secrets - see docs/deployment.md
docker compose up -d --build
```

That should work; if it didn't then I have lost my way.

I also do build the docker images myself in the github repo so you can delete the build sections in the docker-compose and just specify images that reference those.

Compose brings up MySQL, Redis, Meilisearch, the processing service, the API, and the web view (shared media volume). `docker compose up` will refuse to start if a required secret in `.env` is left blank. See [processing/README.md](processing/README.md) for download/transcode details, and [docs/deployment.md](docs/deployment.md) for production hardening notes (TLS assumptions, secrets, network exposure, etc.). Currently all of these are required, I may in the future break it out and allow you to run the system without the extra containers and an existing DB. 

If you want to run less stuff you can remove the processing and search containers if you set the associated env vars to disabled in the .env (ENABLE_ADVANCED_SEARCH for Search, and ENABLE_TRANSCODING, ENABLE_VIDEO_IMPORTS for the Processing and Redis containers)

Currently the system requires root access to initialize a DB. I may change this in the future to use an existing MySQL instance and DB if desired. 

### (DEV) Running components individually

If you create `.env` files in both the webapi and webview containers (based on their respective `.env.example` files) you can run each by doing a 

```bash
cd webapi/
npm run dev
```

```bash
cd webview/
npm run dev
```

This makes it super easy to test new stuff that doesn't rely on the other containers. You can also set the `webapi/` `.env` file to use sqlite instead of mysql for quick and easy spin-up. 

Default listen port is `PORT` (3000). Useful URLs:

| URL             | What                                      |
| --------------- | ----------------------------------------- |
| `/health`       | Liveness probe                            |
| `/docs`         | Scalar API reference                      |
| `/openapi.json` | OpenAPI document (YAML + route `@openapi`) |
| `/api/v1/...`   | Public application API (WIP)              |
| `/internal/...` | Service-to-service callbacks              |

More detail: [webapi/README.md](webapi/README.md).

## Project layout

| Path | Role |
| ---- | ---- |
| [`webapi/`](webapi/) | Public Web API (Express, Sequelize, sessions / API keys) |
| [`processing/`](processing/) | yt-dlp downloads + BullMQ/ffmpeg transcodes |
| [`webview/`](webview/) | Web frontend (React + Vite) |
| [`docs/`](docs/) | Product notes, API checklist, [code standards](docs/code-standards.md), [deployment](docs/deployment.md) |
| [`docker-compose.yml`](docker-compose.yml) | Full stack: MySQL, Redis, Meilisearch, API, processing, web view |
| [`migration-tools`](migration-tools/) | Tools for migrating from other systems to justintube (incl Mediacms) |

If you're going to contribute, reference the code standards doc linked above. Or like tell your AI tool to read it and make sure your changes comply. Which is what I do. 

## License

See [LICENSE.md](LICENSE.md).
