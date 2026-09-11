#!/usr/bin/env node
"use strict";

// Migrates one MediaCMS user's videos into justintube via justintube's public
// API (POST /videos/upload -> POST /videos/:id/thumbnail -> PATCH /videos/:id),
// so the normal upload/validation/transcode pipeline runs exactly as it would
// for a live user upload. See /migration-tools/README (or the plan this was
// built from) for the field mapping and failure-log/retry behavior.

require("dotenv").config();

const path = require("node:path");
const fs = require("node:fs");
const { openAsBlob } = fs;
const { Client } = require("pg");

const STATE_DIR = path.join(__dirname, "state");
const LOG_DIR = path.join(__dirname, "logs");

const MEDIA_TYPES_TO_MIGRATE = ["video", "audio"];
const MAX_TAGS = 50;

/**
 * Parses CLI flags into an options object.
 *
 * @param {string[]} argv Raw argv slice (after `node script.js`).
 * @returns {{justintubeUserId: number, mediacmsUserId: number, dryRun: boolean, retryFrom: string|null}}
 *   Parsed options.
 */
function parseArgs(argv) {
  const opts = { justintubeUserId: null, mediacmsUserId: null, dryRun: false, retryFrom: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--justintube-user-id") {
      opts.justintubeUserId = Number(argv[++i]);
    } else if (arg === "--mediacms-user-id") {
      opts.mediacmsUserId = Number(argv[++i]);
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--retry-from") {
      opts.retryFrom = argv[++i];
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.justintubeUserId) || opts.justintubeUserId <= 0) {
    throw new Error("--justintube-user-id <id> is required and must be a positive integer.");
  }
  if (!Number.isInteger(opts.mediacmsUserId) || opts.mediacmsUserId <= 0) {
    throw new Error("--mediacms-user-id <id> is required and must be a positive integer.");
  }
  return opts;
}

/**
 * Reads required env vars, throwing with a clear message if any are missing.
 *
 * @returns {Record<string, string>} Validated env config.
 */
function loadEnvConfig() {
  const required = [
    "JUSTINTUBE_API_BASE_URL",
    "JUSTINTUBE_API_KEY",
    "MEDIACMS_DB_HOST",
    "MEDIACMS_DB_NAME",
    "MEDIACMS_DB_USER",
    "MEDIACMS_MEDIA_ROOT",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env var(s): ${missing.join(", ")}. See .env.example.`);
  }
  return {
    apiBaseUrl: process.env.JUSTINTUBE_API_BASE_URL.replace(/\/+$/, ""),
    apiKey: process.env.JUSTINTUBE_API_KEY,
    dbHost: process.env.MEDIACMS_DB_HOST,
    dbPort: Number(process.env.MEDIACMS_DB_PORT || 5432),
    dbName: process.env.MEDIACMS_DB_NAME,
    dbUser: process.env.MEDIACMS_DB_USER,
    dbPassword: process.env.MEDIACMS_DB_PASSWORD || "",
    mediaRoot: process.env.MEDIACMS_MEDIA_ROOT,
  };
}

/**
 * Confirms the presented API key belongs to the target justintube user.
 * Justintube ties every API-key-authenticated write to the key's own owner
 * (no on-behalf-of/admin override), so this is the closest available
 * substitute for an explicit ownership check.
 *
 * @param {string} apiBaseUrl Justintube API base URL.
 * @param {string} apiKey Bearer API key.
 * @param {number} expectedUserId Justintube user id the caller expects the key to belong to.
 * @returns {Promise<void>} Resolves if the key belongs to the expected user; throws otherwise.
 */
async function verifyApiKeyOwner(apiBaseUrl, apiKey, expectedUserId) {
  const res = await fetch(`${apiBaseUrl}/me/settings`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`Failed to authenticate JUSTINTUBE_API_KEY (HTTP ${res.status}).`);
  }
  const me = await res.json();
  if (me.id !== expectedUserId) {
    throw new Error(
      `JUSTINTUBE_API_KEY belongs to justintube user ${me.id}, not the requested ` +
        `--justintube-user-id ${expectedUserId}. Justintube has no admin/on-behalf-of ` +
        `upload path, so the key must belong to the user being migrated into.`,
    );
  }
  if (!me.uploader) {
    throw new Error(
      `Justintube user ${me.id} does not have uploader access; uploads would be rejected.`,
    );
  }
}

/**
 * Fetches the MediaCMS media rows to migrate for a given user.
 *
 * @param {import('pg').Client} db Connected pg client.
 * @param {number} mediacmsUserId MediaCMS user id whose media to fetch.
 * @param {number[]|null} restrictToIds When set, only these `files_media.id`s are returned
 *   (used by `--retry-from`).
 * @returns {Promise<object[]>} Rows with an added `tags` string array field.
 */
async function fetchMediaCmsVideos(db, mediacmsUserId, restrictToIds) {
  const { rows } = await db.query(
    `SELECT
       m.id, m.uid, m.title, m.description, m.media_file, m.thumbnail,
       m.uploaded_thumbnail, m.duration, m.enable_comments, m.state,
       m.media_type, m.add_date,
       COALESCE(array_agg(DISTINCT t.title) FILTER (WHERE t.title IS NOT NULL), '{}') AS tags
     FROM files_media m
     LEFT JOIN files_media_tags mt ON mt.media_id = m.id
     LEFT JOIN files_tag t ON t.id = mt.tag_id
     WHERE m.user_id = $1
       AND m.media_type = ANY($2::text[])
       AND ($3::int[] IS NULL OR m.id = ANY($3::int[]))
     GROUP BY m.id
     ORDER BY m.id ASC`,
    [mediacmsUserId, MEDIA_TYPES_TO_MIGRATE, restrictToIds],
  );
  return rows;
}

/**
 * Maps a MediaCMS media row to a justintube visibility value.
 *
 * @param {{state: string}} row MediaCMS media row.
 * @returns {"public"|"private"|"unlisted"} Justintube visibility.
 */
function mapVisibility(row) {
  switch (row.state) {
    case "public":
      return "public";
    case "unlisted":
      return "unlisted";
    case "friends":
      // No justintube equivalent for a friends-only audience; fall back to
      // the most restrictive option rather than over-exposing the video.
      return "private";
    case "private":
    default:
      return "private";
  }
}

/**
 * Loads a JSON file, returning a default value if it doesn't exist yet.
 *
 * @param {string} filePath Path to read.
 * @param {*} fallback Value to return when the file is missing.
 * @returns {*} Parsed JSON, or `fallback`.
 */
function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

/**
 * Writes a JSON file atomically (write to a temp file, then rename).
 *
 * @param {string} filePath Destination path.
 * @param {*} data Value to serialize.
 * @returns {void}
 */
function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  fs.renameSync(tmpPath, filePath);
}

/**
 * Loads a JSON-Lines failure log into a Map keyed by mediacmsVideoId.
 *
 * @param {string} filePath Path to the `.jsonl` failure log.
 * @returns {Map<number, object>} Failure entries by MediaCMS video id.
 */
function loadFailureLog(filePath) {
  const map = new Map();
  if (!fs.existsSync(filePath)) return map;
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    const entry = JSON.parse(line);
    map.set(entry.mediacmsVideoId, entry);
  }
  return map;
}

/**
 * Rewrites the JSON-Lines failure log from the current in-memory Map, so the
 * file always reflects only currently-outstanding failures.
 *
 * @param {string} filePath Path to the `.jsonl` failure log.
 * @param {Map<number, object>} map Current failure entries.
 * @returns {void}
 */
function saveFailureLog(filePath, map) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [...map.values()].map((entry) => JSON.stringify(entry));
  fs.writeFileSync(filePath, lines.length > 0 ? `${lines.join("\n")}\n` : "");
}

/**
 * Resolves the on-disk path for a MediaCMS-relative media path, or null if
 * the field is empty or the file doesn't exist.
 *
 * @param {string} mediaRoot MediaCMS MEDIA_ROOT mount point.
 * @param {string|null|undefined} relativePath Relative path from a `files_media` field.
 * @returns {string|null} Absolute path, or null.
 */
function resolveMediaPath(mediaRoot, relativePath) {
  if (!relativePath) return null;
  const abs = path.join(mediaRoot, relativePath);
  return fs.existsSync(abs) ? abs : null;
}

/**
 * Performs a justintube API request and throws a descriptive error on
 * non-2xx responses.
 *
 * @param {string} url Full request URL.
 * @param {RequestInit} init Fetch options.
 * @param {string} step Label identifying which migration step this call is part of.
 * @returns {Promise<object>} Parsed JSON response body.
 */
async function apiRequest(url, init, step) {
  const res = await fetch(url, init);
  const bodyText = await res.text();
  let body;
  try {
    body = bodyText ? JSON.parse(bodyText) : {};
  } catch {
    body = { raw: bodyText };
  }
  if (!res.ok) {
    const err = new Error(`${step} failed: HTTP ${res.status} ${JSON.stringify(body)}`);
    err.step = step;
    err.status = res.status;
    err.body = body;
    throw err;
  }
  return body;
}

/**
 * Migrates a single MediaCMS video into justintube: upload, optional
 * thumbnail reuse, then metadata PATCH.
 *
 * @param {object} row MediaCMS media row (with `tags` array attached).
 * @param {object} ctx Shared config: apiBaseUrl, apiKey, mediaRoot.
 * @param {object} entry This video's mutable state-file entry (updated in place).
 * @returns {Promise<void>} Resolves once the video reaches a terminal state.
 */
async function migrateVideo(row, ctx, entry) {
  const authHeaders = { Authorization: `Bearer ${ctx.apiKey}` };

  const originalPath = resolveMediaPath(ctx.mediaRoot, row.media_file);
  if (!originalPath) {
    entry.status = "skipped";
    entry.reason = "original_file_missing";
    return;
  }

  // Resolved up front (not just inside the "uploaded" step below) so the
  // upload call itself knows whether a MediaCMS thumbnail is actually
  // available to reuse. `skipThumbnail` must only be sent when one is -
  // sending it unconditionally (as this previously did) suppressed
  // justintube's own auto-generated-frame fallback too, so any row missing
  // (or with a moved/renamed) MediaCMS thumbnail ended up with no thumbnail
  // at all and no job ever queued to fix that.
  const thumbPath =
    resolveMediaPath(ctx.mediaRoot, row.uploaded_thumbnail) ||
    resolveMediaPath(ctx.mediaRoot, row.thumbnail);

  if (entry.status === "pending" || !entry.justintubeVideoId) {
    const form = new FormData();
    form.append("file", await openAsBlob(originalPath), path.basename(row.media_file));
    if (thumbPath) {
      form.append("skipThumbnail", "true");
    }
    const uploadBody = await apiRequest(
      `${ctx.apiBaseUrl}/videos/upload`,
      { method: "POST", headers: authHeaders, body: form },
      "upload",
    );
    entry.justintubeVideoId = uploadBody.id;
    entry.status = "uploaded";
  }

  const videoId = entry.justintubeVideoId;

  if (entry.status === "uploaded") {
    if (thumbPath) {
      const form = new FormData();
      form.append("file", await openAsBlob(thumbPath), path.basename(thumbPath));
      await apiRequest(
        `${ctx.apiBaseUrl}/videos/${videoId}/thumbnail`,
        { method: "POST", headers: authHeaders, body: form },
        "thumbnail",
      );
    }
    // No MediaCMS thumbnail to reuse - since skipThumbnail wasn't sent
    // above, justintube already queued its own auto-generated-frame
    // thumbnail job as part of the normal upload flow; nothing further to
    // do here.
    entry.status = "thumbnail_set";
  }

  if (entry.status === "thumbnail_set") {
    const tags = (row.tags || []).slice(0, MAX_TAGS);
    if ((row.tags || []).length > MAX_TAGS) {
      console.warn(
        `  [video ${row.id}] has ${row.tags.length} tags, truncating to ${MAX_TAGS}.`,
      );
    }
    // Backdate to MediaCMS's original upload date - otherwise every migrated
    // video would carry the migration run's timestamp, breaking chronological
    // sort order and the "Uploaded" date shown on justintube. Omitted (rather
    // than sent as invalid) when add_date is missing or unparseable, so the
    // video still migrates with a "now" createdAt instead of failing outright.
    const addDate = row.add_date ? new Date(row.add_date) : null;
    const createdAt =
      addDate && !Number.isNaN(addDate.getTime()) ? addDate.toISOString() : undefined;
    if (row.add_date && createdAt === undefined) {
      console.warn(`  [video ${row.id}] has an unparseable add_date "${row.add_date}"; leaving createdAt unset.`);
    }
    await apiRequest(
      `${ctx.apiBaseUrl}/videos/${videoId}`,
      {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: row.title || "Untitled",
          description: row.description || "",
          visibility: mapVisibility(row),
          commentsEnabled: Boolean(row.enable_comments),
          tags,
          ...(createdAt !== undefined ? { createdAt } : {}),
        }),
      },
      "metadata",
    );
    entry.status = "metadata_set";
  }

  entry.status = "done";
}

/**
 * Entry point: parses args/env, fetches MediaCMS videos, and migrates each
 * one into justintube, tracking progress in a local state file and
 * outstanding failures in a JSON-Lines log.
 *
 * @returns {Promise<void>} Resolves when the run completes.
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = loadEnvConfig();

  const statePath = path.join(STATE_DIR, `${opts.justintubeUserId}-${opts.mediacmsUserId}.json`);
  const defaultFailureLogPath = path.join(
    LOG_DIR,
    `${opts.justintubeUserId}-${opts.mediacmsUserId}-failures.jsonl`,
  );
  const failureLogPath = opts.retryFrom || defaultFailureLogPath;

  console.log(`Verifying JUSTINTUBE_API_KEY belongs to user ${opts.justintubeUserId}...`);
  await verifyApiKeyOwner(env.apiBaseUrl, env.apiKey, opts.justintubeUserId);

  const failureMap = loadFailureLog(failureLogPath);
  const restrictToIds = opts.retryFrom ? [...failureMap.keys()] : null;
  if (opts.retryFrom && restrictToIds.length === 0) {
    console.log(`No entries found in ${failureLogPath}; nothing to retry.`);
    return;
  }

  console.log(
    `Connecting to MediaCMS database ${env.dbHost}:${env.dbPort}/${env.dbName}...`,
  );
  const db = new Client({
    host: env.dbHost,
    port: env.dbPort,
    database: env.dbName,
    user: env.dbUser,
    password: env.dbPassword,
  });
  await db.connect();

  let rows;
  try {
    rows = await fetchMediaCmsVideos(db, opts.mediacmsUserId, restrictToIds);
  } finally {
    await db.end();
  }

  console.log(`Found ${rows.length} candidate video(s) for MediaCMS user ${opts.mediacmsUserId}.`);

  const state = loadJson(statePath, {});
  const ctx = { apiBaseUrl: env.apiBaseUrl, apiKey: env.apiKey, mediaRoot: env.mediaRoot };

  const counts = { done: 0, skipped: 0, failed: 0 };

  for (const row of rows) {
    const existing = state[row.id];
    if (existing && (existing.status === "done" || existing.status === "skipped")) {
      counts[existing.status] += 1;
      continue;
    }

    const visibility = mapVisibility(row);
    if (opts.dryRun) {
      console.log(
        `[dry-run] video ${row.id} "${row.title}" -> visibility=${visibility}, ` +
          `tags=${(row.tags || []).length}`,
      );
      continue;
    }

    const entry = existing || { status: "pending" };
    state[row.id] = entry;

    try {
      await migrateVideo(row, ctx, entry);
      failureMap.delete(row.id);
      counts[entry.status === "skipped" ? "skipped" : "done"] += 1;
      console.log(`[video ${row.id}] "${row.title}" -> ${entry.status}`);
    } catch (err) {
      entry.status = "failed";
      entry.error = err.message;
      failureMap.set(row.id, {
        mediacmsVideoId: row.id,
        title: row.title,
        step: err.step || "unknown",
        error: err.message,
        timestamp: new Date().toISOString(),
      });
      counts.failed += 1;
      console.error(`[video ${row.id}] "${row.title}" FAILED: ${err.message}`);
    }

    saveJson(statePath, state);
    saveFailureLog(defaultFailureLogPath, failureMap);
  }

  console.log("");
  console.log(
    `Done: ${counts.done}, skipped: ${counts.skipped}, failed: ${counts.failed}` +
      (opts.dryRun ? " (dry run, nothing written)" : ""),
  );
  if (!opts.dryRun) {
    console.log(`State file: ${statePath}`);
    if (failureMap.size > 0) {
      console.log(`Failure log (${failureMap.size} outstanding): ${defaultFailureLogPath}`);
      console.log(`Retry with: --retry-from ${defaultFailureLogPath}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
