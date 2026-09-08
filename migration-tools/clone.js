#!/usr/bin/env node
"use strict";

// Downloads a video from a URL via yt-dlp and uploads it into justintube
// through its public API (POST /videos/upload -> PATCH /videos/:id), the same
// upload/validation/transcode pipeline a normal browser upload goes through.
// See README for setup and usage.

const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { openAsBlob } = fs;
const { execFileSync } = require("node:child_process");

require("dotenv").config({ path: path.join(__dirname, ".env") });

/**
 * Reads required env vars, throwing with a clear message if any are missing.
 *
 * @returns {{apiBaseUrl: string, apiKey: string, ytdlpExe: string, downloadDir: string}}
 *   Validated env config.
 */
function loadEnvConfig() {
  const required = ["JUSTINTUBE_API_BASE_URL", "JUSTINTUBE_API_KEY"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(
      `Missing required env var(s): ${missing.join(", ")}. Copy .env.example to .env and fill them in.`,
    );
  }
  return {
    apiBaseUrl: process.env.JUSTINTUBE_API_BASE_URL.replace(/\/+$/, ""),
    apiKey: process.env.JUSTINTUBE_API_KEY,
    ytdlpExe: process.env.YTDLP_EXE || "yt-dlp",
    downloadDir: process.env.YTDLP_DOWNLOAD_DIR || os.tmpdir(),
  };
}

/**
 * Parses CLI arguments.
 *
 * @param {string[]} argv Raw argv slice (after `node clone.js`).
 * @returns {{url: string, title: string|null, visibility: "public"|"unlisted"|"private", keepFile: boolean}}
 *   Parsed options.
 */
function parseArgs(argv) {
  const opts = { url: null, title: null, visibility: "public", keepFile: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--title") {
      opts.title = argv[++i];
    } else if (arg === "--visibility") {
      opts.visibility = argv[++i];
    } else if (arg === "--keep-file") {
      opts.keepFile = true;
    } else if (!opts.url && !arg.startsWith("--")) {
      opts.url = arg;
    } else {
      throw new Error(`Unrecognized argument: ${arg}`);
    }
  }
  if (!opts.url) {
    throw new Error(
      "Usage: node clone.js <url> [--title <title>] [--visibility public|unlisted|private] [--keep-file]",
    );
  }
  if (!["public", "unlisted", "private"].includes(opts.visibility)) {
    throw new Error(
      `--visibility must be public, unlisted, or private (got "${opts.visibility}").`,
    );
  }
  return opts;
}

/**
 * Runs yt-dlp against the given URL and returns the downloaded file's path.
 *
 * @param {string} url Source video URL.
 * @param {{ytdlpExe: string, downloadDir: string}} env yt-dlp config.
 * @returns {string} Absolute path to the downloaded (and merged, if needed) video file.
 */
function downloadVideo(url, env) {
  fs.mkdirSync(env.downloadDir, { recursive: true });
  console.log(`Downloading with yt-dlp: ${url}`);
  // Note: capping the video codec to x264 (via "bv*+ba/b" format selection on
  // most sites) keeps output under 1080p on some sources, since 4k sources
  // often only offer vp9, which justintube's transcode pipeline doesn't
  // accept as input.
  const output = execFileSync(
    env.ytdlpExe,
    [
      "--no-mtime",
      "-f",
      "bv*+ba/b",
      "--merge-output-format",
      "mp4",
      "-P",
      env.downloadDir,
      "-o",
      "%(title)s.%(ext)s",
      "--print",
      "after_move:filepath",
      url,
    ],
    { encoding: "utf8" },
  );
  const filePath = output.trim().split("\n").pop();
  if (!filePath || !fs.existsSync(filePath)) {
    throw new Error(
      `yt-dlp did not produce a downloaded file (output: ${JSON.stringify(output)}).`,
    );
  }
  console.log(`Downloaded: ${filePath}`);
  return filePath;
}

/**
 * Performs a justintube API request and throws a descriptive error on
 * non-2xx responses.
 *
 * @param {string} url Full request URL.
 * @param {RequestInit} init Fetch options.
 * @param {string} step Label identifying which step this call is part of.
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
    throw new Error(
      `${step} failed: HTTP ${res.status} ${JSON.stringify(body)}`,
    );
  }
  return body;
}

/**
 * Uploads a downloaded video file into justintube and sets its metadata.
 *
 * @param {string} filePath Local path to the video file.
 * @param {{apiBaseUrl: string, apiKey: string}} env Justintube API config.
 * @param {"public"|"unlisted"|"private"} visibility Visibility to set on the video.
 * @param {string|null} titleOverride Title to use instead of one derived from the filename.
 * @returns {Promise<object>} The final PATCHed video object.
 */
async function uploadVideo(filePath, env, visibility, titleOverride) {
  const authHeaders = { Authorization: `Bearer ${env.apiKey}` };

  console.log(`Uploading: ${filePath}`);
  const form = new FormData();
  form.append("file", await openAsBlob(filePath), path.basename(filePath));
  const uploadBody = await apiRequest(
    `${env.apiBaseUrl}/videos/upload`,
    { method: "POST", headers: authHeaders, body: form },
    "upload",
  );

  const title = (
    titleOverride ||
    path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, " ")
  ).substring(0, 99);
  const description = `Auto-uploaded by clone.js at ${new Date().toLocaleString()}`;

  console.log(`Setting metadata: title="${title}", visibility=${visibility}`);
  const patchBody = await apiRequest(
    `${env.apiBaseUrl}/videos/${uploadBody.id}`,
    {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title, description, visibility }),
    },
    "metadata",
  );

  return patchBody;
}

/**
 * Entry point: parses args/env, downloads via yt-dlp, and uploads into justintube.
 *
 * @returns {Promise<void>} Resolves once the video is uploaded.
 */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const env = loadEnvConfig();

  const filePath = downloadVideo(opts.url, env);
  try {
    const video = await uploadVideo(filePath, env, opts.visibility, opts.title);
    console.log("");
    console.log(`Done. justintube video id: ${video.videoId}`);
  } finally {
    if (!opts.keepFile) {
      fs.rmSync(filePath, { force: true });
      console.log(`Removed local file: ${filePath}`);
    }
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
