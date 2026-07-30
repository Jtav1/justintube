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
| `VITE_API_BASE_URL` |  API URL (default `localhost:3000`) |

Vite only exposes `VITE_`-prefixed vars to client code, and bakes them in at build time (not read
at container runtime).

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

Talks to the `webapi` service (see [`../webapi`](../webapi)) via `VITE_API_BASE_URL`; routing is
handled by `react-router-dom`.