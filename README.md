# Justintube

A self-hosted, MediaCMS-style video platform: YouTube-like frontend, self-hosted transcoding pipeline, and shared watch sessions (CAST). Built contract-first — the full API surface is specified in OpenAPI before any endpoint is implemented.

> **Status: early scaffolding.** The API contract is complete and every endpoint returns `501 Not Implemented`. There is no frontend, database, or test suite yet.

## What it will do

- **Video platform basics** — upload (including yt-dlp URL import), FFmpeg transcoding to multiple resolutions with configurable hardware acceleration, tagging, search with typeahead suggestions, subscriptions, likes, playlists, watch history, and notifications.
- **Access control** — email-verified accounts with optional SSO linking, RBAC roles (Admin / Moderator / Uploader / Viewer / Locked), and per-video visibility (public, private with grants, hidden, unlisted).
- **CAST shared watch sessions** — start a session from a playlist or a single video, share a session code, and watch together: a live session queue (a copy seeded from the playlist — the source is never mutated), synced play/pause/skip/seek for everyone, presence, an activity feed, emoji reactions, and an in-app display view for casting to a TV. Realtime sync runs over Socket.IO (namespace `/cast`, one room per session). Ported from the dixtube-live prototype.
- **Admin tools** — user/role management, transcode profiles, featured videos, moderation (de-listing, bans).

See `Views.md` (the source-of-truth product spec) and `MediaCMS Feature List.md` (the longer-term roadmap) for details.

## Getting started

Requires Node.js 18+ (24 recommended).

```bash
cd api
npm install
npm run dev     # auto-reload via node --watch
# or: npm start
```

The server listens on `PORT` (default 3000):

| URL | What |
| --- | --- |
| `/health` | Liveness probe |
| `/docs` | Interactive API reference (Scalar) |
| `/openapi.json` | The OpenAPI 3.1 document |
| `/api/v1/...` | All API routes (currently 501 stubs) |

## Project layout

```
Views.md                  Product spec the API surface is derived from
MediaCMS Feature List.md  Longer-term feature roadmap by build phase
api/
  index.js                Express 5 app factory + HTTP server (Socket.IO attached)
  openapi.yaml            The full intended API contract (OpenAPI 3.1)
  routes/stubs.js         Every route registered with a 501 stub handler
  lib/loadOpenApi.js      Loads the spec at startup (boot fails on invalid YAML)
  cast/                   CAST session module (skeleton: wiring real, logic stubbed)
    events.js             Socket event names — the realtime protocol's source of truth
    session-store.js      Multi-session state store + queue/playback mutators
    gateway.js            /cast Socket.IO namespace and event handlers
    resolve-video.js      Internal video-lookup seam
    persistence.js        Persistence interface (SQLite planned)
    realtime.js           Attaches Socket.IO + gateway to the HTTP server
```

**Contract-first workflow:** `Views.md` → `openapi.yaml` → route stubs. Implementing an endpoint means replacing its stub while keeping the route path and `operationId` in sync with the spec. For CAST, the socket event names in `api/cast/events.js` are part of the contract too — they must match the event catalog documented on `GET /cast/{id}/sync`.

## Deployment

`.github/workflows/docker-backend.yml` builds `api/Dockerfile`, pushes the image to GHCR as `justintube-api`, and cosign-signs it on pushes to `master` and `v*` tags. `docker-compose.yml` is a placeholder for the eventual full stack (app, transcode workers, database, reverse proxy).

## License

See [LICENSE.md](LICENSE.md).
