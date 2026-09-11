# Justintube Web UI (`webview/`)

React+Vite application for Justintube. Serves the web frontend. 
Uses `lucide` icons (see `package.json`)

## Requirements

- Nodejs  **≥ 20.6**  (see `package.json` `engines`)
- Docker (for full suite of dependencies) or at minimum Sqlite for dev mode

## Setup
```bash
cp .env.example .env
npm install
```

Important env vars
| Variable | Purpose |
| -------- | ------- |
| `VITE_API_BASE_URL` | API URL used by `npm run dev` (default `localhost:3000`) |

`VITE_API_BASE_URL` only applies to the Vite dev server — Vite bakes `VITE_`-prefixed vars into
the bundle at build time, so it can't vary per deployment. The Docker image instead reads the API
origin at container **start** from a plain `API_BASE_URL` env var: `docker-entrypoint.sh` writes
it into `/config.js`, which `index.html` loads before the app bundle, and `src/api/client.js`
reads it off `window.__RUNTIME_CONFIG__`. This means the same built image works across
environments — no rebuild needed to point it at a different API.

## Commands

```bash
npm run dev       # start the Vite dev server
npm run build     # production build to dist/
npm run preview   # serve the production build locally
npm run lint      # eslint .
```

## Structure

```
src/
  api/          axios client + per-resource request functions (auth, users, videos, themes)
  components/   reusable UI pieces (Sidebar, TopBar, VideoCard, VideoPlayer, VideoComments, ...)
  context/      React context/providers (auth, theme) and their hooks
  layouts/      shared page chrome (AppLayout)
  lib/          small framework-free helpers (formatting, etc.)
  pages/        route-level views (VideoListing, VideoPage, UploadPage, ProfilePage, AdminPanel, ...)
```

Talks to the `webapi` service (see [`../webapi`](../webapi)) via `VITE_API_BASE_URL` (dev) /
`API_BASE_URL` (Docker); routing is handled by `react-router-dom`.