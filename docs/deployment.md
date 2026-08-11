# Deployment

Production-readiness notes for running the whole stack via the root
[`docker-compose.yml`](../docker-compose.yml). See each service's own README
for local (non-compose) dev instructions.

## 1. Overview / architecture

Six services, one Docker network:

| Service | Role | Reachable at |
| --- | --- | --- |
| `db` | MySQL 8.4 | `db:3306` (internal only) |
| `redis` | BullMQ job queue backing store | `redis:6379` (internal only) |
| `search` | Meilisearch, used when `ENABLE_ADVANCED_SEARCH=true` | `search:7700` (internal only) |
| `webapi` | Public API (`/api/v1`), internal callback API (`/internal`) | published on `PORT` (default 3000) |
| `processing` | yt-dlp downloads + ffmpeg transcodes, BullMQ worker | internal only, called by `webapi` |
| `webview` | React SPA served by nginx | published on `WEBVIEW_PORT` (default 5173) |

`webapi` and `processing` authenticate each other's callbacks with a shared
`INTERNAL_SERVICE_TOKEN` Bearer token. `webview` talks to `webapi` directly
from the browser (cross-origin), not through an nginx proxy.

## 2. TLS (external, not included in this stack)

Nothing in this repo terminates TLS. Deploy behind an operator-managed
reverse proxy or cloud load balancer that terminates HTTPS and forwards
plain HTTP to `webapi` (port `PORT`) and `webview` (port `WEBVIEW_PORT`).

Set `TRUST_PROXY` to match your proxy topology — `1` (the default) trusts
one hop, which is correct for a single fronting proxy/load balancer. This
affects secure cookies, `req.secure`, and rate-limit IP attribution in
`webapi`. Get this wrong and sessions/cookies can misbehave even though TLS
itself works fine.

## 3. Quick start (production)

```bash
cp .env.example .env
# edit .env: fill in every REQUIRED secret, set PUBLIC_APP_URL/PUBLIC_API_URL/
# CORS_ORIGIN/API_BASE_URL to your real hostname(s)
docker compose up -d --build
docker compose ps   # wait for db/redis/search/webapi/processing to show healthy
```

`docker compose up` fails immediately with a clear error naming the missing
variable if any `REQUIRED` value in `.env.example` is left blank — there is
no silent fallback to a weak default secret.

## 4. Secrets checklist

| Var | Used by | Generate with |
| --- | --- | --- |
| `MYSQL_ROOT_PASSWORD` | `db` | `openssl rand -hex 32` |
| `MYSQL_PASSWORD` | `db`, `webapi` | `openssl rand -hex 32` |
| `MEILI_MASTER_KEY` | `search`, `webapi` | `openssl rand -hex 32` |
| `INTERNAL_SERVICE_TOKEN` | `webapi`, `processing` | `openssl rand -hex 32` |
| `REDIS_PASSWORD` | `redis`, `processing` | `openssl rand -hex 32` |
| `SESSION_SECRET` | `webapi` (cookie signing) | `openssl rand -hex 32` |

Rotate any of these that were ever set to an example/weak value before going
live. Do not commit `.env` — it's gitignored at the repo root.

## 5. Network exposure

`db`, `redis`, and `search` publish **no host ports** by default — they're
only reachable on the internal compose network (`db:3306`, `redis:6379`,
`search:7700`). This is deliberate: there's no reason a database, job queue,
or search index needs to be reachable from outside the Docker host.

If you want local host access for tooling (a DB GUI, RedisInsight, the
Meilisearch dashboard), add a gitignored `docker-compose.override.yml`
(Compose merges this automatically, no extra flags needed):

```yaml
# docker-compose.override.yml
services:
  db:
    ports:
      - "3306:3306"
  redis:
    ports:
      - "6379:6379"
  search:
    ports:
      - "7700:7700"
```

Note `redis` requires `--requirepass` (wired from `REDIS_PASSWORD`) and
`AUTH`; most Redis GUIs will prompt for a password.

Unlike `db`/`redis`/`search`, the `streaming` service (only relevant when
`ENABLE_LIVESTREAM=true`) publishes ports `1935` (RTMP ingest) and `8888`
(HLS playback) **by design** — OBS (or any RTMP encoder) and viewers'
browsers both need to reach it directly from outside the Docker host, unlike
`processing`'s internal-only API. Set `RTMP_INGEST_URL`/`HLS_BASE_URL` in
`.env` to this host's real public hostname/IP (not `localhost`) and make sure
those two ports are actually forwarded through any router/firewall in front
of it, or streamers/viewers will fail to connect even though the container
itself is healthy.

## 6. CORS configuration

`CORS_ORIGIN` is a comma-separated allowlist of browser origins allowed to
make credentialed requests. If it's set, only those origins are allowed
(everything else is rejected by the `cors` middleware). If it's left blank:
outside production, requests are reflected (dev convenience); in production
(`NODE_ENV=production`, which the `webapi` image always sets), cross-origin
requests are **rejected entirely**. Since the webview talks to the API
cross-origin from the browser, `CORS_ORIGIN` must be set to your real
webview origin(s) in production or the frontend will fail to authenticate.

## 7. Admin & demo accounts

`ADMIN_USERNAME`/`ADMIN_PASSWORD` seed a single admin account on first boot
(idempotent — won't overwrite on later boots). Leave both blank to skip
creating one; you can promote or create an admin another way instead.

`SEED_DEMO_USERS` (default `false` in this compose file) controls three
extra demo accounts (`User1`, `User2`, `Mod1`), all sharing the password
`"password"`, one of which is a moderator. **Never enable this in a real
deployment.**

## 8. API docs exposure

`ENABLE_API_DOCS` (default `false` here) controls whether `GET /docs`
(Scalar UI) and `GET /openapi.json` are mounted at all. Keep this `false` in
production unless you specifically want your full API schema public.

## 9. `API_BASE_URL` is injected at container start, not baked in

`webview`'s Docker image contains no baked-in API URL. At container start,
`webview/docker-entrypoint.sh` writes the `API_BASE_URL` env var into a
`/config.js` file served alongside the app bundle; `index.html` loads it
before the bundle, and `src/api/client.js` reads it off
`window.__RUNTIME_CONFIG__`. Changing `API_BASE_URL` and restarting the
container (no rebuild) is sufficient, and the same published image can be
promoted across environments with different API origins.

(`VITE_API_BASE_URL` still exists as a separate, Vite-only env var, but it's
only read by `npm run dev` for local non-Docker development — see
`webview/README.md`.)

`PUBLIC_API_URL` is the analogous var for `webapi` itself: read server-side
(not injected into any container's config.js) to build absolute
`og:image`/`og:video`/`twitter:player` URLs for the link-unfurl route
(`GET /api/v1/videos/:id/unfurl`) and its companion embeddable player page
(`GET /api/v1/videos/:id/player`) — those URLs are fetched directly by
external bots (Slack, Discord, Twitter, etc.) over the public internet, so
they can't be relative paths or the Docker-internal `webapi:3000` hostname.
It typically equals `API_BASE_URL`'s value. Set it to an `https://` host to
enable Twitter/X Player Card inline video playback — over `http://` the
unfurl page falls back to a rich card with a thumbnail only, no inline play.

## 10. Redis auth

`redis` requires a password (`REDIS_PASSWORD`, wired via `--requirepass`).
`processing` is the only other service that talks to Redis directly and
picks up the same var. There's no TLS between `processing` and `redis` in
this stack — both run on the internal compose network only.

## 11. yt-dlp version pinning

`processing/Dockerfile` pins `yt-dlp` and `yt-dlp-ejs` to specific versions
rather than installing latest on every image rebuild, for build
reproducibility. Tradeoff: yt-dlp ships frequent fixes for site-extraction
breakage (sites change their pages, yt-dlp has to keep up), so a pinned
version can start failing to download from a given site over time. Bump the
pins in `processing/Dockerfile` deliberately when that happens, rather than
switching back to always-latest.

## 12. Storage directory provisioning

`webapi` and `processing` both run as a non-root `app` user (uid/gid 1001 by
default, reconciled to `PUID`/`PGID` env vars at container start — see each
`docker-entrypoint.sh`). On first boot against a bind-mounted host path that
doesn't exist yet (as in `docker-compose-prod.yml`), Docker creates the mount
point as `root`; each entrypoint then `chown -R`s its writable mount points
(`/media`, `/sitedata`, `/data/shared`) to the `app` user before dropping
privileges, and the app itself creates the subdirectories it needs
(`original/`, `transcoded/`, `thumbnails/`, `avatars/`, `banners/`,
`themes/`) at startup. No manual `mkdir`/`chown` on the host is required for
any of these paths, including on a completely fresh deployment.

## 13. Health checks & startup ordering

`db`, `redis`, `search`, `webapi`, and `processing` all have Docker
`healthcheck:` blocks. `webapi` waits for `db` and `processing` to report
healthy before starting; `webview` waits for `webapi`. `docker compose ps`
shows each service's health status — expect a `starting` → `healthy`
transition over the first ~15-30 seconds per service.

## 14. Explicitly out of scope

- **TLS termination** — assumed external (see §2).
- **Secrets management/vaulting** — `.env` is a plain file; for a real
  production deployment, consider Docker secrets, an external secrets
  manager, or your platform's native secret store instead of a `.env` file
  on disk.
- **Backups** — `db-data`, `media-data`, and `search-data` are named Docker
  volumes with no automated backup. Back them up yourself.
- **Log aggregation / monitoring** — services log to stdout/stderr only
  (`docker compose logs`); no shipping to an external log/metrics system is
  configured.
- **CI/CD deploy automation** — the GitHub Actions workflows in
  `.github/workflows/` build, sign, and publish images; they do not deploy
  anywhere. Deploying a new image to your environment is a manual step.
- **Horizontal scaling** — `processing` runs one transcode job at a time by
  design (`concurrency: 1`); running multiple `processing` replicas isn't
  tested or documented here.

## 15. Known constraints

- The webview's Content-Security-Policy leaves `connect-src`, `img-src`, and
  `media-src` permissive (`'self' *`) rather than scoped to the real API
  origin. `img-src` and `media-src` need this because banners/avatars and
  video streams are served cross-origin from the API. `API_BASE_URL` is now
  known at container start (see §9), so `nginx.conf` could in principle
  template all three directives to that exact origin, but doing so isn't
  implemented here. Every other CSP directive is strict.
- **Link-unfurl: hardcoded internal proxy address.** `webview/nginx.conf`
  proxies bot requests to `http://webapi:3000` — the Docker Compose service
  DNS name. This only works when `webview` and `webapi` share a Docker
  network (true of both `docker-compose.yml` and `docker-compose-prod.yml`
  as shipped). Any topology where they don't share a network (webview
  behind a CDN/static host, webapi on a different host/orchestrator) breaks
  the proxy outright.
- **Link-unfurl: User-Agent sniffing is best-effort.** The bot detection in
  `webview/nginx.conf` matches known, documented UA substrings (Slackbot,
  Twitterbot, Discordbot, etc.). Apple's iMessage link-preview fetcher in
  particular does not send a single stable, documented User-Agent, so
  iMessage previews may not always be recognized.
- **Link-unfurl: Twitter/X Player Cards are HTTPS-only** and historically
  require a one-time Card Validator run
  (https://cards-dev.twitter.com/validator) against a live URL before Player
  Cards render for a new domain — an operational step outside this repo's
  scope. Until `PUBLIC_API_URL` is set to a real `https://` host, the unfurl
  page falls back to a `summary_large_image` card (no inline playback).
