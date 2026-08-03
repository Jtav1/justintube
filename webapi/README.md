# Justintube Web API (`webapi/`)

Express 5 application API for Justintube. Serves `/api/v1` (browser + API-key clients), `/internal` (processing callbacks), OpenAPI docs, and health checks.

Conventions: [docs/code-standards.md](../docs/code-standards.md). Progress: [docs/api-checklist.md](../docs/api-checklist.md).

## Requirements

- Node.js **≥ 20.6** (see `package.json` `engines`)
- SQLite (default) or MySQL
- Optional: running [processing](../processing/) service for post-upload transcodes

## Setup

```bash
cp .env.example .env
npm install
```

Important env vars (see `.env.example` for the full list):

| Variable | Purpose |
| -------- | ------- |
| `PORT` | Listen port (default `3000`) |
| `DB_CLIENT` | `sqlite` (default) or `mysql` |
| `SQLITE_FILE` | SQLite path when `DB_CLIENT=sqlite` |
| `SESSION_SECRET` | Cookie session signing secret |
| `MEDIA_STORAGE_DIRECTORY` | Media root (`original/` uploads live here) |
| `PROCESSING_API_URL` | Processing service base URL |
| `INTERNAL_SERVICE_TOKEN` | Shared bearer for `/internal` callbacks |
| `ENABLE_ACCOUNT_REGISTRATION` | `true` to allow `POST /api/v1/auth/register` |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | Seeded admin account on boot |

## Scripts

| Script | What it does |
| ------ | ------------ |
| `npm run dev` | Start with `.env`, reload on change |
| `npm run dev:compose` | Start with reload, no `.env` file load |
| `npm start` | Production-style `node index.js` |
| `npm test` | Jest + supertest |
| `npm run docs:generate` | Write `openapi.generated.json` |
| `npm run docs:preview` | Generate + serve Scalar locally |
| `npm run docs:build` | Generate + validate OpenAPI |

## Database

On startup, `ensureSchema()` in [`lib/schema.js`](lib/schema.js) syncs tables from Sequelize models in [`lib/models/`](lib/models/). Works for both MySQL (`mysql2`) and SQLite (`sqlite3`), selected by `DB_CLIENT`. Reference roles (and optional admin user) are seeded after sync.

There is no separate migration runner for routine model additions — define the model, register associations in `lib/models/index.js`, and boot the app (or run tests that call `setupSchema()`).

## Auth overview

- **Session cookie** for the website, plus **CSRF** (`X-CSRF-Token`) on unsafe methods for cookie clients.
- **Bearer API keys** (`Authorization: Bearer jt_…`) for programmatic access; keys are stored as SHA-256 hashes + a non-secret prefix only.
- Middleware: `requireAuth` (session or API key), `requireAdmin` (admin role after auth).
- Processing callbacks on `/internal` use Bearer `INTERNAL_SERVICE_TOKEN`.

### Roles

Seeded into `ROLES` on boot ([`lib/seed.js`](lib/seed.js)). Acceptable role names:

| Name | Description |
| ---- | ----------- |
| `admin` | Full administrative access to the platform. |
| `moderator` | Can moderate content and manage other users. |
| `uploader` | Verified user who can upload and manage their own videos. |
| `viewer` | Default role that can watch and engage. |
| `locked` | Account restricted from most actions (auth rejects these users). |

Email verification is tracked independently of role via `USERS.emailVerified` (a boolean), not a role — a user of any role can be verified or unverified.

## Layout

| Path | Role |
| ---- | ---- |
| `index.js` | App factory, `/health`, `/docs`, `/openapi.json` |
| `routes/` | Route factories (`createXxxRouter`); stubs for unimplemented ops |
| `lib/auth/` | Session, CSRF, CORS, passwords, API keys, middleware |
| `lib/models/` | Sequelize models + associations |
| `lib/schema.js` | `ensureSchema` / dialect setup |
| `openapi.yaml` | Base OpenAPI document (merged with route `@openapi` JSDoc) |
| `tests/` | Jest HTTP + DB tests |

New routes: implement a factory, mount it in `createApiRouter()` **before** stubs, remove matching stubs, add tests, check off [docs/API_Checklist.md](../docs/API_Checklist.md).

## HTTP surface (high level)

| Prefix | Audience |
| ------ | -------- |
| `GET /health` | Liveness |
| `GET /docs`, `GET /openapi.json` | API docs |
| `/api/v1/...` | Public app API |
| `/internal/...` | Processing → API callbacks |
