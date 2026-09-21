# Justintube

A self-hosted video platform: Familiar frontend, self-hosted transcoding pipeline, and shared cast/airplay-able watch sessions. Built from the bottom up because you know back end is best.

This software is a collaborative effort between myself (Justin) and a few friends who can choose to add themselves to this readme and other docs :)

## What it does

- **Video platform basics** — upload video/audio files, basic search, subscriptions, likes, playlists, watch history, watch parties, CAST/Airplay, notifications
- **Optional advanced features** - Upload by link/import (via yt-dlp), hardware accelerated transcoding into web formats or custom quality profiles, advanced search with meilisearch.
- **Access control** — email-verified accounts, with RBAC (Admin / Moderator / Uploader / Viewer / Locked), and per-video visibility (public, private with grants, hidden, unlisted).
- **CASTable shared watch sessions** — start a watch party from a playlist, a single video, or empty room; share a join code/scan QR code, and watch together: a live session queue, synced play/pause/skip/seek for everyone, presence, an activity feed, emoji reactions, and an in-app display view for casting to a TV. The owner can kick members and end the session. Realtime sync runs over Socket.IO (namespace `/cast`, one room per session). Based on the dixtube-live prototype by [SpinnerMaster](https://github.com/SpinnerMaster)
- **Admin tools** — user/role management, API keys, UI themes, system config, transcode profiles, featured videos, moderation (de-listing, bans).
- **Fully documented API**
- Fully containerized and designed to run via docker-compose and behind a reverse proxy for simple deployment

## What this isn't

- This site isn't meant to compete with projects like [Peertube](https://github.com/chocobozzz/peertube) or [Tube Archivist](https://github.com/tubearchivist/tubearchivist) or [MediaCMS](https://github.com/mediacms-io/mediacms) and certainly not media library streaming platforms like [Jellyfin](https://github.com/jellyfin/jellyfin) - this isn't a youtube channel archiver, nor a community building platform, or a business-ready CMS. Just a simple self-hostable video/audio hosting and sharing system.

See [webapi/openapi.yaml](webapi/openapi.yaml) for the OpenAPI base document and [docs/api-checklist.md](docs/api-checklist.md) for implementation progress.

## Getting started

Requires **Node.js 20.6+** for `webapi/` and `webview/`, and `processing/` when running components in local dev mode via `npm run dev`. The Web API can use **SQLite** (local dev instance default) or **MySQL**.

### Running the entire project

Copy the .env.example to .env in your working directory and then customize it to your liking. Check out `/docs/deployment.md` for startup instructions. In the .env, REQUIRED stuff must be set, OPTIONAL is up to you, DEFAULTS can be left, and then EXPERIMENTAL do what you want man see what happens. Please read the whole .env before asking me questions. Also check `docs`

Once you do that, you can run the docker-compose.yml. Make sure you completely read the .env and docker-compose first. Make sure you know whats going on. 

```bash
cp .env.example .env 
docker compose up -d --build
```

That should work; if it didn't then I have lost my way.

I also do build the docker images myself in the github repo **so you can delete the build sections in the docker-compose and just specify images that reference those.**

Compose brings up MySQL, Redis, Meilisearch, the processing service, the API, and the web view (shared media volume). `docker compose up` will refuse to start if a required secret in `.env` is left blank. See [processing/README.md](processing/README.md) for download/transcode details, and [docs/deployment.md](docs/deployment.md) for production hardening notes (TLS assumptions, secrets, network exposure, etc.). Currently all of these are required, I may in the future break it out and allow you to run the system without the extra containers and an existing DB. 

If you want to run less stuff you can remove the processing and search containers if you set the associated env vars to disabled in the .env (ENABLE_ADVANCED_SEARCH for Search, and ENABLE_TRANSCODING, ENABLE_VIDEO_IMPORTS for the Processing and Redis containers)

Currently the system requires root access to initialize a DB. I may change this in the future to use an existing MySQL instance and DB if desired. 

### (DEV) Running components individually

There are .env.example files in all component directories - `./processing`, `./streaming`, `./webapi`, `./webview` - you can run each by setting up their .env files based on the examples and then `npm install` and `npm run dev` each one.

This makes it super easy to test new stuff that doesn't rely on the other containers. You can also set the `webapi/` `.env` file to use sqlite instead of mysql for quick and easy spin-up. 

### Migration Tools

There's also a `/migration-tools` directory where I have some random scripts to help with importing media. There is a script to import a user's videos from MediaCMS, with original upload timestamp, with access to the MediaCMS media directory and DB. There's also a script to use yt-dlp to upload videos from outside the site.

### Connectivity 

You'll want to forward your API url to webapi container port 3000 by default, and your web UI url to webview container port 5173 by default..

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

If you want to contribute please reference the code standards doc linked above. Or like tell your AI tool to read it and make sure your changes comply idk its 2026.

## License

See [LICENSE.md](LICENSE.md).
