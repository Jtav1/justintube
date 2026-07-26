import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { originalDir } from "./media-paths.js";

const execFileAsync = promisify(execFile);

/**
 * Format selector: best video+audio at 1080p or lower, with fallbacks.
 *
 * @type {string}
 */
const FORMAT_SELECTOR =
  "bv*[height<=1080]+ba/b[height<=1080]/best[height<=1080]";

/**
 * Error thrown for invalid client input (maps to HTTP 400).
 */
export class DownloadValidationError extends Error {
  /**
   * @param {string} message Human-readable validation failure.
   */
  constructor(message) {
    super(message);
    this.name = "DownloadValidationError";
  }
}

/**
 * Validates that `url` is a non-empty absolute http(s) URL string.
 *
 * @param {unknown} url Value from the request body.
 * @returns {string} Trimmed URL string.
 * @throws {DownloadValidationError} When the URL is missing or malformed.
 */
export function validateDownloadUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new DownloadValidationError("url is required and must be a string");
  }

  const trimmed = url.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new DownloadValidationError("url must be a valid absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new DownloadValidationError("url must use http or https");
  }

  return trimmed;
}

/**
 * Returns true if any file in originalDir uses the given stem (stem.ext).
 *
 * @param {string[]} names Directory entries in originalDir.
 * @param {string} stem Filename stem without extension.
 * @returns {boolean} Whether a file for this stem already exists.
 */
function stemExists(names, stem) {
  const prefix = `${stem}.`;
  return names.some((name) => name.startsWith(prefix));
}

/**
 * Picks an unused output stem for this unix epoch: bare epoch first, then
 * epoch+a, epoch+b, … epoch+z when collisions exist in the same second.
 *
 * @param {string} epoch Unix epoch seconds as a string.
 * @returns {string} Stem to use for `-o` (without extension).
 * @throws {Error} When all a–z suffixes are already taken for this epoch.
 */
function nextEpochStem(epoch) {
  const names = readdirSync(originalDir);

  if (!stemExists(names, epoch)) {
    return epoch;
  }

  for (let i = 0; i < 26; i++) {
    const stem = `${epoch}${String.fromCharCode(97 + i)}`;
    if (!stemExists(names, stem)) {
      return stem;
    }
  }

  throw new Error(
    `too many downloads in the same second for epoch ${epoch}`,
  );
}

/**
 * Finds the basename written for a given stem prefix in `originalDir`.
 *
 * @param {string} stem Filename stem used in the yt-dlp output template.
 * @returns {string | undefined} Matching basename, or undefined if none.
 */
function findStemFile(stem) {
  const prefix = `${stem}.`;
  return readdirSync(originalDir).find((name) => name.startsWith(prefix));
}

/**
 * Downloads a single URL with yt-dlp (≤1080p) into `MEDIA_STORAGE_DIRECTORY/original`
 * (same directory `/transcode` reads its input from) using a unix-epoch
 * basename (with a–z suffix on collision) and `--js-runtimes node`.
 *
 * @param {string} url Absolute http(s) URL to download.
 * @returns {Promise<string>} Basename of the saved file (name + extension).
 * @throws {DownloadValidationError} When `url` is invalid.
 * @throws {Error} When yt-dlp fails or the output file is missing.
 */
export async function downloadUrl(url) {
  const validatedUrl = validateDownloadUrl(url);
  const epoch = String(Math.floor(Date.now() / 1000));
  const stem = nextEpochStem(epoch);
  const outputTemplate = join(originalDir, `${stem}.%(ext)s`);

  const args = [
    "--js-runtimes",
    "node",
    "--no-playlist",
    "-f",
    FORMAT_SELECTOR,
    "--merge-output-format",
    "mp4",
    "-o",
    outputTemplate,
    "--",
    validatedUrl,
  ];

  try {
    await execFileAsync("yt-dlp", args, {
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const stderr =
      typeof err?.stderr === "string" && err.stderr.trim()
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : "yt-dlp failed";
    throw new Error(stderr);
  }

  const filename = findStemFile(stem);
  if (!filename) {
    throw new Error("yt-dlp finished but no output file was found");
  }

  return filename;
}
