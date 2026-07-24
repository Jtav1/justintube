# JavaScript code standards

Conventions for JavaScript in this repository (`webapi/`, `processing/`, and shared patterns). Prefer matching neighboring files over inventing a new style.

Primary references:

- Route factory + OpenAPI JSDoc: [`webapi/routes/api-keys.js`](webapi/routes/api-keys.js)
- Auth middleware: [`webapi/lib/auth/require-auth.js`](webapi/lib/auth/require-auth.js), [`webapi/lib/auth/require-admin.js`](webapi/lib/auth/require-admin.js)
- Sequelize model: [`webapi/lib/models/user-api-key.js`](webapi/lib/models/user-api-key.js)
- Router mounting / stubs: [`webapi/routes/stubs.js`](webapi/routes/stubs.js)

---

## Language and tooling

- **JavaScript** with **ES modules** (`import` / `export`). Use **explicit `.js` extensions** in relative import paths (Node ESM).
- **Semicolons** at the end of statements.
- **Double quotes** for string literals.
- Target **Node ≥ 20** (`webapi` engines field); prefer modern async/`await` APIs.

---

## Indentation and whitespace

- **2 spaces** per indentation level. Do not use tabs.
- **One blank line** between logical sections (after imports, between unrelated blocks).
- **One blank line** between import groups: third-party packages first, then a blank line, then local/project imports.
- **Trailing commas** in multiline object literals, array literals, and parameter lists where it improves diffs.
- Avoid trailing whitespace on lines.

---

## Line length and wrapping

- Prefer readable line breaks over very long lines. Indent continuations consistently (typically one extra level).
- Keep chained calls one call per line when that stays clearer than a single long expression.

---

## Naming

- **Variables and functions:** `camelCase` (`hashApiKey`, `requireAuth`, `keyDisplay`).
- **Module-scope constants:** `const` with `camelCase` or `UPPER_SNAKE` for true fixed literals (`DEFAULT_TTL_MS`, `MAX_NAME_LENGTH`).
- **Files:**
  - Libraries / helpers: **kebab-case** (`require-auth.js`, `user-api-key.js`, `api-key.js`).
  - Route modules: **kebab-case** matching the resource (`api-keys.js`, `system-config.js`).
- **Sequelize models:** PascalCase class name (`UserApiKey`); **table names** `UPPER_SNAKE_CASE` (`USER_API_KEYS`).
- **JS attributes / JSON:** **camelCase** (`userId`, `expiresAt`, `keyDisplay`). DB columns are snake_case via Sequelize `field` mappings where needed.
- **Error codes:** snake_case strings (`unauthorized`, `invalid_body`, `not_found`).

---

## Imports

- Order: external packages first, blank line, then relative project imports.
- Prefer **named imports** / **named exports**. Avoid unused imports.
- Aggregate re-exports only when they clarify a public surface (e.g. `lib/models/index.js`).

---

## Functions and exports

- Prefer **named `function` declarations** for exported and private helpers:

  ```js
  export function createApiKeysRouter() { ... }

  /**
   * @private
   */
  function serializeApiKey(row) { ... }
  ```

- Route modules export a **factory** `createXxxRouter()` that returns an Express `Router`.
- Use **`async`/`await`** for asynchronous work; avoid unnecessary `.then()` chains.
- **Early returns** for guard clauses (`if (!row) { res.status(404)...; return; }`).

---

## Comments and JSDoc

Document functions with a preceding `/** ... */` block that includes a short description, **`@param`** for each parameter (braced types), and **`@returns`** (type + brief meaning).

### Inline comments

- Use `//` for short “why” notes (non-obvious constraints, security choices).
- Prefer a comment on its own line above the code it describes.

### Exported and private functions

```js
/**
 * Soft-revokes an API key by setting `revokedAt` when not already revoked.
 *
 * @param {import('sequelize').Model} row UserApiKey instance.
 * @returns {Promise<void>} Resolves after the row is updated (or left unchanged).
 */
async function softRevoke(row) { ... }
```

- Mark internal helpers with `@private` when they are not part of the module’s public API.
- Route handler JSDoc should also state **HTTP method + path**, **body/query shape**, and **auth**.

### OpenAPI on routes

Document public HTTP endpoints with an inline `@openapi` YAML fragment in the handler JSDoc. The document is merged from [`webapi/openapi.yaml`](webapi/openapi.yaml) plus route annotations via `swagger-jsdoc` ([`webapi/lib/loadOpenApi.js`](webapi/lib/loadOpenApi.js)). Include `operationId`, `tags`, `security`, and main response codes.

---

## Web API routes

### Mounting

- Implement routes in `webapi/routes/*.js` as `createXxxRouter()` factories.
- Register real routers in [`createApiRouter()`](webapi/routes/stubs.js) **before** `registerStubRoutes`, so implementations override 501 placeholders.
- When replacing a stub, **remove** the matching stub registration.
- Base path for the public API is `/api/v1`. Internal service callbacks mount under `/internal`.

### Auth

- **`requireAuth`:** session cookie **or** `Authorization: Bearer` user API key. Sets `req.user`, `req.authRole`, `req.authMethod` (`"session"` | `"api_key"`).
- **`requireAdmin`:** run **after** `requireAuth`; allows only `req.authRole.name === "admin"`.
- **CSRF:** apply `csrfProtection` on routers that mutate state. Enforced for cookie sessions on unsafe methods; **skipped** when a Bearer token is present. Clients send `X-CSRF-Token`.
- **Internal callbacks:** Bearer `INTERNAL_SERVICE_TOKEN` (see `internal-file-versions.js`).

### Request validation

- Hand-roll validation in handlers (coerce with `String(...)` / `Number(...)`, early `400` with a typed error). Match neighboring routes rather than introducing a new validation library without agreement.

### Success responses

- Lists: `{ items: [...] }`.
- Creates: `201` with the created resource body.
- Deletes / soft-revokes with no body: `204` via `res.status(204).end()`.
- Never return secrets (`passwordHash`, `keyHash`, full API key plaintext except the one-time create response when designed that way).

### Error responses

Use a machine-readable snake_case `error` plus a human `message` (no `ok` flag):

```js
res.status(400).json({
  error: "invalid_body",
  message: "name is required.",
});
```

Common codes: `unauthorized`, `forbidden`, `csrf_invalid`, `not_found`, `invalid_body`, `invalid_id`, `invalid_query`, `internal_error`, `not_implemented`.

In `catch` blocks: `console.error("<operationId> failed:", err)` then `500` with `internal_error`.

---

## Sequelize models (`webapi/lib/models`)

- One model per file; register associations and re-exports in [`index.js`](webapi/lib/models/index.js).
- Use `timestampColumn("created_at")` / `timestampColumn("updated_at")` from [`attribute-helpers.js`](webapi/lib/models/attribute-helpers.js).
- Prefer `constrainedString([...])` over native ENUM when values must work under SQLite.
- File-level JSDoc describing the table purpose, ending with `@type {import('sequelize').ModelStatic<...>}` on the exported model.
- Soft “delete” for credentials/tokens is usually an explicit nullable timestamp (e.g. `revokedAt`), not Sequelize `paranoid`. Auth lookups must ignore revoked/expired rows.

Schema is applied via `ensureSchema()` on boot — there is no separate migration runner for routine model additions.

---

## Testing

- **Jest** with `@jest/globals` imports; HTTP tests use **supertest**.
- Helpers: [`webapi/tests/helpers/app.js`](webapi/tests/helpers/app.js) (`createTestClient`, `createTestAgent`), [`webapi/tests/helpers/db.js`](webapi/tests/helpers/db.js) (`setupSchema`, `resetTables`, `seedXxx`).
- Typical suite shape: `beforeAll(setupSchema)`, `afterEach(resetTables)`.
- Use a cookie-jar agent + CSRF for session flows; Bearer API keys for key-auth flows.
- Assert both status codes and `res.body.error` machine codes; assert secrets are absent from JSON bodies.

---

## Processing API

- Lives under `processing/` (yt-dlp / ffmpeg / queue). Same formatting, ESM, and JSDoc expectations as `webapi/`.
- Keep service-to-service auth and callbacks aligned with the Web API’s `/internal` contract.

---

## What to avoid

- Mixing quote styles or omitting semicolons without project-wide agreement.
- Returning `{ ok: false, ... }` error envelopes — use `{ error, message }`.
- Leaving stale 501 stubs after a real router owns the same path.
- Exposing `keyHash`, full API keys (except one-time create), or password hashes in responses.
- JSDoc that only restates the function name — describe behavior, params, and return value.
- Large unrelated refactors or drive-by renames in the same change as a feature.

---

## Reference checklist for a new Web API route

1. Implement `createXxxRouter()` with CSRF (if mutating), auth, `@openapi` JSDoc, and `{ error, message }` errors.
2. Mount it in `createApiRouter()` before stubs; remove matching stubs.
3. Add/adjust models only if needed; register associations in `models/index.js`.
4. Add HTTP tests under `webapi/tests/http/`.
5. Check off the operation in [`API_Checklist.md`](API_Checklist.md).
