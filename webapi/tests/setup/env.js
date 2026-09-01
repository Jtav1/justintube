import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Jest `setupFiles` module. Runs before each test file's own imports so that
 * `lib/db.js` and `routes/uploads.js` (which read configuration from
 * `process.env` at import time) initialize against an isolated, throwaway
 * SQLite database and media directory instead of the developer's real data.
 *
 * A unique temp directory is created per Jest worker (keyed by
 * `JEST_WORKER_ID`) so parallel test files never share a database file.
 *
 * @returns {void} No return value; mutates `process.env` as a side effect.
 */
const workerId = process.env.JEST_WORKER_ID || "1";
const scratchDir = mkdtempSync(join(tmpdir(), `justintube-test-${workerId}-`));

process.env.DB_CLIENT = "sqlite";
process.env.SQLITE_FILE = join(scratchDir, "test.sqlite");
process.env.MEDIA_STORAGE_DIRECTORY = join(scratchDir, "media");
// Isolates the storage-migration scripts' resumable manifest from the real
// scripts/state/ directory and from other parallel Jest workers.
process.env.STORAGE_MIGRATION_STATE_DIR = join(scratchDir, "migration-state");
process.env.SITEDATA_STORAGE_DIRECTORY = join(scratchDir, "sitedata");
process.env.FILETYPES_ALLOWED = "mp4,webm,mkv,mp3,wav";
process.env.FILETYPES_CONVERTIBLE = "mov,wma";
process.env.AVATAR_FILETYPES_ALLOWED = "jpg,jpeg,png,webp";
process.env.PROCESSING_API_URL = "http://processing.test:3001";
// Pinned so a developer's real webapi/.env (loaded by "dotenv/config" in
// index.js, which only fills in variables not already set) can't leak its
// local ENABLE_TRANSCODING value into the test suite - tests assume the
// default-enabled behavior unless a specific test overrides it.
process.env.ENABLE_TRANSCODING = "true";
process.env.HLS_BASE_URL = "http://hls.test:8888";
process.env.ENABLE_LIVESTREAM = "true";
process.env.INTERNAL_SERVICE_TOKEN = "test-internal-token";
process.env.TRANSCODE_RECONCILE_ENABLED = "false";
process.env.SESSION_SECRET = "test-session-secret";
process.env.SESSION_COOKIE_SECURE = "false";
process.env.ENABLE_ACCOUNT_REGISTRATION = "true";
process.env.REQUIRE_EMAIL_VERIFICATION = "false";
process.env.ADMIN_USERNAME = "testadmin";
process.env.ADMIN_PASSWORD = "testadminpassword";
// Small cap so the "file too large" (413) path is exercisable with tiny fixtures.
process.env.MAX_UPLOAD_SIZE_BYTES = String(1024);
process.env.MAX_AVATAR_SIZE_BYTES = String(1024);
