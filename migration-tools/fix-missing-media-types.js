#!/usr/bin/env node
"use strict";

// Repairs ORIGINAL_UPLOADS rows in justintube's own (MySQL) database whose
// media_type column is missing (NULL or empty) - e.g. rows written by an
// external import that didn't set it. Finding those rows still requires a
// direct database query (media_type isn't filterable via any public
// endpoint), but fixing each one goes entirely through justintube's public
// API - POST /videos/:id/media-type/repopulate - which does the actual
// ffprobe-via-processing work and writes the result back server-side. See
// /migration-tools/README.

require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");

const LOG_DIR = path.join(__dirname, "logs");

/**
 * Parses CLI flags into an options object.
 *
 * @param {string[]} argv Raw argv slice (after `node script.js`).
 * @returns {{dryRun: boolean}} Parsed options.
 */
function parseArgs(argv) {
  const opts = { dryRun: false };
  for (const arg of argv) {
    if (arg === "--dry-run") {
      opts.dryRun = true;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  return opts;
}

/**
 * Reads and validates the env vars this script needs, throwing with a clear
 * message if any are missing.
 *
 * @returns {Record<string, string|number>} Validated env config.
 */
function loadEnvConfig() {
  const required = [
    "JUSTINTUBE_API_BASE_URL",
    "JUSTINTUBE_API_KEY",
    "JUSTINTUBE_MYSQL_HOST",
    "JUSTINTUBE_MYSQL_DATABASE",
    "JUSTINTUBE_MYSQL_USER",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}. See .env.example.`);
  }
  return {
    apiBaseUrl: process.env.JUSTINTUBE_API_BASE_URL.replace(/\/+$/, ""),
    apiKey: process.env.JUSTINTUBE_API_KEY,
    mysqlHost: process.env.JUSTINTUBE_MYSQL_HOST,
    mysqlPort: Number(process.env.JUSTINTUBE_MYSQL_PORT || 3306),
    mysqlDatabase: process.env.JUSTINTUBE_MYSQL_DATABASE,
    mysqlUser: process.env.JUSTINTUBE_MYSQL_USER,
    mysqlPassword: process.env.JUSTINTUBE_MYSQL_PASSWORD || "",
  };
}

/**
 * Confirms the presented API key belongs to an admin — required for
 * `POST /videos/:id/media-type/repopulate`, which is admin-only. Fails fast
 * with one clear error rather than letting every row 403 individually.
 *
 * @param {string} apiBaseUrl Justintube API base URL.
 * @param {string} apiKey Bearer API key.
 * @returns {Promise<void>} Resolves if the key belongs to an admin; throws otherwise.
 */
async function verifyApiKeyIsAdmin(apiBaseUrl, apiKey) {
  const res = await fetch(`${apiBaseUrl}/me/settings`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to authenticate JUSTINTUBE_API_KEY (HTTP ${res.status}).`);
  }
  const me = await res.json();
  if (me.role !== "admin") {
    throw new Error(
      `JUSTINTUBE_API_KEY belongs to justintube user ${me.id} (role: ${me.role ?? "none"}), ` +
        `but POST /videos/:id/media-type/repopulate is admin-only.`,
    );
  }
}

/**
 * Queries justintube's own MySQL database directly for every
 * ORIGINAL_UPLOADS id with no media_type set. Read-only, and only reason
 * this script needs direct database access at all — media_type isn't
 * filterable (or even readable in bulk) via any public endpoint.
 *
 * @param {object} env Validated env config from `loadEnvConfig`.
 * @returns {Promise<Array<{id: number, videoId: string}>>} Affected uploads.
 */
async function findUploadsMissingMediaType(env) {
  const mysql = require("mysql2/promise");
  const conn = await mysql.createConnection({
    host: env.mysqlHost,
    port: env.mysqlPort,
    database: env.mysqlDatabase,
    user: env.mysqlUser,
    password: env.mysqlPassword,
  });
  try {
    const [rows] = await conn.execute(
      "SELECT id, video_id FROM ORIGINAL_UPLOADS WHERE media_type IS NULL OR media_type = '' ORDER BY id ASC",
    );
    // video_id is declared BINARY(6) in the schema - mysql2 can hand that
    // back as a Buffer rather than a string.
    return rows.map((row) => ({
      id: row.id,
      videoId: Buffer.isBuffer(row.video_id) ? row.video_id.toString("utf8") : row.video_id,
    }));
  } finally {
    await conn.end();
  }
}

/**
 * Calls `POST /videos/:id/media-type/repopulate` for a single upload.
 *
 * @param {string} apiBaseUrl Justintube API base URL.
 * @param {string} apiKey Bearer API key (must belong to an admin).
 * @param {number} uploadId ORIGINAL_UPLOADS id to repair.
 * @returns {Promise<{mediaType: "video"|"audio"}>} The mediaType that was persisted.
 */
async function repopulateMediaType(apiBaseUrl, apiKey, uploadId) {
  const res = await fetch(`${apiBaseUrl}/videos/${uploadId}/media-type/repopulate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  const bodyText = await res.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { raw: bodyText };
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Entry point: queries justintube's database directly for every upload with
 * no media_type set, then calls justintube's public
 * `POST /videos/:id/media-type/repopulate` for each one. Rows that fail
 * (upload deleted since the query ran, processing unreachable, ffprobe
 * inconclusive, etc.) are logged to a JSON-Lines failure log rather than
 * retried automatically.
 *
 * @returns {Promise<void>} Resolves when the run completes.
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = loadEnvConfig();

  console.log("Verifying JUSTINTUBE_API_KEY belongs to an admin...");
  await verifyApiKeyIsAdmin(env.apiBaseUrl, env.apiKey);

  console.log(`Querying justintube database ${env.mysqlHost}:${env.mysqlPort}/${env.mysqlDatabase}...`);
  const uploads = await findUploadsMissingMediaType(env);
  console.log(`Found ${uploads.length} upload(s) with no mediaType set.`);

  if (opts.dryRun) {
    for (const upload of uploads) {
      console.log(`[dry-run] would repopulate upload ${upload.id} (${upload.videoId})`);
    }
    console.log("");
    console.log(`${uploads.length} upload(s) would be repopulated (dry run, nothing called).`);
    return;
  }

  const failureLogPath = path.join(LOG_DIR, "fix-missing-media-types-failures.jsonl");
  const failures = [];
  const counts = { updated: 0, failed: 0 };

  for (const upload of uploads) {
    const label = `upload ${upload.id} (${upload.videoId})`;
    try {
      const { mediaType } = await repopulateMediaType(env.apiBaseUrl, env.apiKey, upload.id);
      counts.updated += 1;
      console.log(`[${label}] -> mediaType=${mediaType}`);
    } catch (err) {
      counts.failed += 1;
      failures.push({
        uploadId: upload.id,
        videoId: upload.videoId,
        error: err.message,
        timestamp: new Date().toISOString(),
      });
      console.error(`[${label}] FAILED: ${err.message}`);
    }
  }

  console.log("");
  console.log(`Done: ${counts.updated} updated, ${counts.failed} failed`);
  if (failures.length > 0) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(failureLogPath, `${failures.map((f) => JSON.stringify(f)).join("\n")}\n`);
    console.log(`Failure log (${failures.length} entr${failures.length === 1 ? "y" : "ies"}): ${failureLogPath}`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
