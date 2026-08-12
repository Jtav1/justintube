# JavaScript code standards

Conventions for `webapi/` and `processing/`. Match neighboring files over inventing new style.

References: [`webapi/routes/api-keys.js`](webapi/routes/api-keys.js) (route + OpenAPI JSDoc),
[`require-auth.js`](webapi/lib/auth/require-auth.js) / [`require-admin.js`](webapi/lib/auth/require-admin.js),
[`user-api-key.js`](webapi/lib/models/user-api-key.js) (model), [`stubs.js`](webapi/routes/stubs.js) (mounting).

---

## Style

- ESM (`import`/`export`), explicit `.js` extensions on relative imports. Semicolons. Double quotes. 2-space indent, no tabs. Node ≥ 20, `async`/`await`.
- One blank line between logical sections and between import groups (third-party, then local).
- Trailing commas in multiline literals/params. No trailing whitespace.
- Break long lines for readability; one chained call per line when clearer.

## Naming

- Variables/functions: `camelCase`. Module constants: `camelCase` or `UPPER_SNAKE` for fixed literals.
- Files: kebab-case (`require-auth.js`, `api-keys.js`).
- Sequelize model classes: PascalCase; table names: `UPPER_SNAKE_CASE`.
- JSON/JS fields: `camelCase` (DB columns are snake_case via Sequelize `field` mappings).
- Error codes: snake_case strings (`unauthorized`, `invalid_body`, `not_found`).

## Imports

External packages, blank line, then relative imports. Named imports/exports preferred; no unused imports. Aggregate re-exports only where they clarify a public surface (`lib/models/index.js`).

## Functions

- Named `function` declarations for exported/private helpers, not arrows.
- Route modules export a `createXxxRouter()` factory returning an Express `Router`.
- `async`/`await` over `.then()` chains. Early returns for guard clauses.

## Comments and JSDoc

- Every function: `/** ... */` with a short description, `@param` per parameter (typed), `@returns`.
- `@private` on internal helpers. Route handlers also note HTTP method + path, body/query shape, auth.
- Inline `//` comments only for non-obvious "why" (constraints, security choices), on their own line above the code.
- Public HTTP endpoints get an `@openapi` YAML fragment in the handler JSDoc (merged via `swagger-jsdoc`, see [`loadOpenApi.js`](webapi/lib/loadOpenApi.js)) with `operationId`, `tags`, `security`, response codes.

## Web API routes

- Implement as `createXxxRouter()`, mount in [`createApiRouter()`](webapi/routes/stubs.js) before `registerStubRoutes`, and remove the matching stub. Public API base path `/api/v1`; internal callbacks under `/internal`.
- **Auth:** `requireAuth` (session cookie or Bearer API key) sets `req.user`/`req.authRole`/`req.authMethod`. `requireAdmin` runs after it, requires `admin` role. `csrfProtection` on mutating routers (cookie sessions only, skipped for Bearer). Internal callbacks use Bearer `INTERNAL_SERVICE_TOKEN`.
- **Validation:** hand-rolled in handlers (`String()`/`Number()` coercion, early `400`), matching neighboring routes — no validation library.
- **Success:** lists as `{ items: [...] }`; creates `201`; deletes/soft-revokes `204` no body. Never return secrets (`passwordHash`, `keyHash`, full API key except one-time create response).
- **Errors:** `{ error: "snake_case_code", message: "human text" }`, never `{ ok: false }`. Common codes: `unauthorized`, `forbidden`, `csrf_invalid`, `not_found`, `invalid_body`, `invalid_id`, `invalid_query`, `internal_error`, `not_implemented`. In `catch`: `console.error("<operationId> failed:", err)` then `500 internal_error`.

## Sequelize models (`webapi/lib/models`)

- One model per file; associations/re-exports in [`index.js`](webapi/lib/models/index.js).
- Use `timestampColumn("created_at"/"updated_at")` from [`attribute-helpers.js`](webapi/lib/models/attribute-helpers.js).
- Prefer `constrainedString([...])` over native ENUM (SQLite compatibility).
- File-level JSDoc on table purpose, ending `@type {import('sequelize').ModelStatic<...>}`.
- Soft-delete for credentials/tokens: nullable timestamp (e.g. `revokedAt`), not `paranoid`. Auth lookups must exclude revoked/expired rows.
- Schema changes go through migrations, not `ensureSchema()` — see root `CLAUDE.md`.

## Testing

- Jest (`@jest/globals`) + supertest. Helpers: [`tests/helpers/app.js`](webapi/tests/helpers/app.js) (`createTestClient`, `createTestAgent`), [`tests/helpers/db.js`](webapi/tests/helpers/db.js) (`setupSchema`, `resetTables`, `seedXxx`).
- Typical shape: `beforeAll(setupSchema)`, `afterEach(resetTables)`. Cookie-jar agent + CSRF for session flows; Bearer key for API-key flows.
- Assert status code, `res.body.error`, and absence of secrets in bodies.

## Processing API

`processing/` (yt-dlp/ffmpeg/queue) follows the same ESM/formatting/JSDoc rules. Keep service-to-service auth aligned with the `/internal` contract.

## Avoid

- Mixed quote styles or missing semicolons.
- `{ ok: false, ... }` error envelopes.
- Stale `501` stubs after a real router takes the path.
- `keyHash`, full API keys, or password hashes in responses.
- JSDoc that just restates the function name.
- Unrelated refactors or drive-by renames bundled with a feature.

## New route checklist

1. `createXxxRouter()` with CSRF (if mutating), auth, `@openapi` JSDoc, `{ error, message }` errors.
2. Mount before stubs; remove matching stub.
3. Add/adjust models if needed; register in `models/index.js`.
4. Add HTTP tests under `webapi/tests/http/`.
5. Check off the operation in [`API_Checklist.md`](API_Checklist.md).
