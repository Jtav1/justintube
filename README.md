# Justintube

A self-hosted video platform: YouTube-like frontend, self-hosted transcoding pipeline, and shared watch sessions (CAST). Built contract-first — the full API surface is specified in OpenAPI and development towards completing each documented endpoint is a work in progress.

## Why

I (Justin) have been hosting a MediaCMS instance for a long time for myself and friends to use for fun, but I find it lacking in a few ways and I've always wanted to tackle developing one specifically tailored to our needs instead of maintained by someone else. Plus I'm tired of keeping it updated.

Quick shout out to them though, https://mediacms.io/ https://github.com/mediacms-io/mediacms if you are looking at this project you will probably be better served by MediaCMS until I remove this warning. However Justintube is not a fork and shares zero code or ideas with them - I'm not patient enough to bother doing that lol

## What it will do

- **Video platform basics** — upload (including yt-dlp URL import as a bonus/stretch goal feature), FFmpeg transcoding to multiple resolutions with configurable hardware acceleration (also a bonus feature), tagging, search with typeahead suggestions, subscriptions, likes, playlists, watch history, and notifications.
- **Access control** — email-verified accounts with optional SSO linking (another bonus feature), RBAC roles (Admin / Moderator / Uploader / Viewer / Locked), and per-video visibility (public, private with grants, hidden, unlisted).
- **CAST shared watch sessions** — start a session from a playlist or a single video, share a session code, and watch together: a live session queue (a copy seeded from the playlist — the source is never mutated), synced play/pause/skip/seek for everyone, presence, an activity feed, emoji reactions, and an in-app display view for casting to a TV. Realtime sync runs over Socket.IO (namespace `/cast`, one room per session). Ported from the dixtube-live prototype.
- **Admin tools** — user/role management, transcode profiles, featured videos, moderation (de-listing, bans).

See `Views.md` for the targeted product spec, and the `openapi.yaml` for planned API spec.

## Getting started

Requires Node.js 18+ (developed against Node 24 which is therefore recommended).
Can be run with its own MYSQL instance or with an SQLITE db - I use SQLITE for development.

### Running the entire project

Production:

```bash
docker compose up -d
```

That should work if it didn't then I have lost my way

### (DEV) Running the API by itself

```bash
cd api
npm install

# Development commands:
npm run dev           # Start with .env, auto-reload via node --watch
npm run dev:compose   # Start, auto-reload, without reading .env
```

### (DEV) Running the web view

tbd

### (DEV) Running just the optional other containers

tbd

The server listens on `PORT` (default 3000):

| URL             | What                               |
| --------------- | ---------------------------------- |
| `/health`       | Liveness probe                     |
| `/docs`         | Interactive API reference (Scalar) |
| `/openapi.json` | The OpenAPI 3.1 document           |
| `/api/v1/...`   | All API routes (WIP)               |

## Project layout

WIP

## License

See [LICENSE.md](LICENSE.md).
