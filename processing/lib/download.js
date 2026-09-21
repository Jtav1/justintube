import { execFile } from "node:child_process";
import { readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { originalDir } from "./media-paths.js";
import { probeVideoDimensions } from "./probe.js";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * Maximum accepted length for pasted cookies.txt content (bytes), a generous
 * ceiling for a real Netscape-format cookie jar that still bounds request size.
 *
 * @type {number}
 */
const MAX_COOKIES_LENGTH = 1_000_000;

/**
 * Maximum accepted value for the optional `retries` yt-dlp option.
 *
 * @type {number}
 */
const MAX_RETRIES = Number(process.env.MAX_YTDLP_RETRIES) || 20;

/**
 * Default/maximum number of entries {@link probePlaylist} enumerates.
 *
 * @type {number}
 */
const MAX_PLAYLIST_PROBE_ITEMS = Number(process.env.MAX_PLAYLIST_PROBE_ITEMS) || 200;

/**
 * Default/maximum number of entries {@link downloadPlaylist} actually
 * downloads in one request (sequential, synchronous — kept small since this
 * isn't queued).
 *
 * @type {number}
 */
const MAX_PLAYLIST_DOWNLOAD_ITEMS = Number(process.env.MAX_PLAYLIST_DOWNLOAD_ITEMS) || 25;

/**
 * Audio formats accepted by yt-dlp's `--audio-format` (`-x` extraction).
 * `"best"` skips re-encoding — yt-dlp just remuxes into whichever container
 * matches the source's native audio codec (e.g. aac -> m4a, opus -> opus) —
 * everything else forces a re-encode into that specific codec/container.
 *
 * @type {Set<string>}
 */
const ALLOWED_AUDIO_FORMATS = new Set([
  "best",
  "aac",
  "alac",
  "flac",
  "m4a",
  "mp3",
  "opus",
  "vorbis",
  "wav",
]);

/**
 * Allowed pattern for a yt-dlp format id (e.g. `"137"`, `"audio_only-0"`,
 * `"hls-2500"`) — built directly into a `-f` selector string, so this both
 * rejects obvious garbage and keeps that string free of selector syntax
 * (spaces, `+`, `/`, brackets, quotes) a caller could otherwise use to widen
 * the selection beyond the single id they claim to be requesting.
 *
 * @type {RegExp}
 */
const FORMAT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

/**
 * Format selector: best video+audio at 1080p or lower, with fallbacks. The
 * final `bestaudio` alternative lets audio-only sources (no format carries a
 * `height`) resolve instead of failing outright — `--merge-output-format`
 * only applies when a merge actually happens, so it doesn't affect this
 * single-stream branch.
 *
 * @type {string}
 */
export const FORMAT_SELECTOR =
  "bv*[height<=1080]+ba/b[height<=1080]/best[height<=1080]/bestaudio";

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
 * Validates the optional `rateLimit` yt-dlp option (`--limit-rate`), e.g.
 * `"2M"`, `"500K"`, or a bare byte count.
 *
 * @param {unknown} value Raw value from the request body.
 * @returns {string|undefined} Trimmed rate-limit token, or `undefined` when absent.
 * @throws {DownloadValidationError} When present but not a valid rate token.
 */
export function validateOptionalRateLimit(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string" && typeof value !== "number") {
    throw new DownloadValidationError("rateLimit must be a string or number");
  }
  const trimmed = String(value).trim();
  if (!/^\d+(\.\d+)?[KkMmGg]?$/.test(trimmed)) {
    throw new DownloadValidationError(
      'rateLimit must look like a byte rate, e.g. "2M" or "500K"',
    );
  }
  return trimmed;
}

/**
 * Validates the optional `retries` yt-dlp option (`--retries`).
 *
 * @param {unknown} value Raw value from the request body.
 * @returns {number|undefined} Validated integer, or `undefined` when absent.
 * @throws {DownloadValidationError} When present but not a valid integer in range.
 */
export function validateOptionalRetries(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 0 || value > MAX_RETRIES) {
    throw new DownloadValidationError(
      `retries must be an integer between 0 and ${MAX_RETRIES}`,
    );
  }
  return value;
}

/**
 * Validates the optional `cookies` option: raw Netscape-format cookies.txt
 * content, passed to yt-dlp via a short-lived temp file (see {@link
 * withCookiesFile}) rather than persisted anywhere.
 *
 * @param {unknown} value Raw value from the request body.
 * @returns {string|undefined} Cookie file content, or `undefined` when absent.
 * @throws {DownloadValidationError} When present but not a reasonably-sized string.
 */
export function validateOptionalCookies(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new DownloadValidationError("cookies must be a string");
  }
  if (value.length > MAX_COOKIES_LENGTH) {
    throw new DownloadValidationError("cookies exceeds the maximum allowed size");
  }
  return value;
}

/**
 * Validates the optional `limit` option used by playlist routes.
 *
 * @param {unknown} value Raw value from the request body.
 * @returns {number|undefined} Validated positive integer, or `undefined` when absent.
 * @throws {DownloadValidationError} When present but not a positive integer.
 */
export function validateOptionalLimit(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Number.isInteger(value) || value < 1) {
    throw new DownloadValidationError("limit must be a positive integer");
  }
  return value;
}

/**
 * Validates the optional `audioFormat` option for {@link downloadAudioOnly}
 * (`--audio-format`). Defaults to `"best"` (no forced re-encode) when absent.
 *
 * @param {unknown} value Raw value from the request body.
 * @returns {string} Validated audio format token.
 * @throws {DownloadValidationError} When present but not a recognized format.
 */
export function validateOptionalAudioFormat(value) {
  if (value === undefined || value === null || value === "") {
    return "best";
  }
  if (typeof value !== "string" || !ALLOWED_AUDIO_FORMATS.has(value.trim().toLowerCase())) {
    throw new DownloadValidationError(
      `audioFormat must be one of: ${[...ALLOWED_AUDIO_FORMATS].join(", ")}`,
    );
  }
  return value.trim().toLowerCase();
}

/**
 * Validates a `formatId` for {@link downloadFormat} — required, a non-empty
 * string matching {@link FORMAT_ID_PATTERN}. Whether it's actually an
 * available format for a given URL is checked separately, against a live
 * probe, inside {@link downloadFormat} itself.
 *
 * @param {unknown} value Raw value from the request body.
 * @returns {string} Trimmed, validated format id.
 * @throws {DownloadValidationError} When missing or malformed.
 */
export function validateFormatId(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw new DownloadValidationError("formatId is required and must be a string");
  }
  const trimmed = value.trim();
  if (!FORMAT_ID_PATTERN.test(trimmed)) {
    throw new DownloadValidationError("formatId contains unsupported characters");
  }
  return trimmed;
}

/**
 * Validates the shared yt-dlp options (`cookies`, `rateLimit`, `retries`)
 * accepted by every route in this file.
 *
 * @param {unknown} body Raw request body.
 * @returns {{ cookies: string|undefined, rateLimit: string|undefined, retries: number|undefined }}
 *   Validated options.
 * @throws {DownloadValidationError} When any option is present but invalid.
 */
export function parseYtDlpOptions(body) {
  const source = body && typeof body === "object" ? body : {};
  return {
    cookies: validateOptionalCookies(source.cookies),
    rateLimit: validateOptionalRateLimit(source.rateLimit),
    retries: validateOptionalRetries(source.retries),
  };
}

/**
 * Builds the `--limit-rate`/`--retries` argument pair for a yt-dlp invocation.
 *
 * @param {{ rateLimit?: string, retries?: number }} options Validated options.
 * @returns {string[]} Argument vector fragment (possibly empty).
 */
function buildOptionalYtDlpArgs({ rateLimit, retries }) {
  const args = [];
  if (rateLimit) {
    args.push("--limit-rate", rateLimit);
  }
  if (retries !== undefined) {
    args.push("--retries", String(retries));
  }
  return args;
}

/**
 * Runs `task` with `--cookies <path>` args pointing at a freshly-written temp
 * file containing `cookies`, then unconditionally deletes that temp file (and
 * its containing directory) once `task` settles — success or failure — so
 * cookie content never outlives a single yt-dlp invocation on disk. When
 * `cookies` is absent, runs `task` with no extra args and skips all of this.
 *
 * @param {string|undefined} cookies Raw cookies.txt content, or undefined.
 * @param {(cookieArgs: string[]) => Promise<T>} task Callback invoked with
 *   the `--cookies` arg pair (or `[]`).
 * @returns {Promise<T>} Whatever `task` resolves to.
 * @template T
 */
export async function withCookiesFile(cookies, task) {
  if (!cookies) {
    return task([]);
  }

  const dir = await mkdtemp(join(tmpdir(), "jt-ytdlp-cookies-"));
  const file = join(dir, "cookies.txt");
  try {
    await writeFile(file, cookies, { mode: 0o600 });
    return await task(["--cookies", file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
 * basename (with a–z suffix on collision) and `--js-runtimes node`. Also
 * probes the result for a video stream so callers (webapi's import handler)
 * can classify audio-only downloads correctly regardless of container
 * (yt-dlp's `bestaudio` fallback can land in an ambiguous container like
 * `.webm`, which extension alone can't distinguish from a video webm).
 *
 * @param {string} url Absolute http(s) URL to download.
 * @param {object} [options] Optional yt-dlp options (see {@link parseYtDlpOptions}).
 * @param {string} [options.cookies] Netscape cookies.txt content, written to a
 *   short-lived temp file for this invocation only (see {@link withCookiesFile}).
 * @param {string} [options.rateLimit] `--limit-rate` value, e.g. `"2M"`.
 * @param {number} [options.retries] `--retries` value.
 * @returns {Promise<{ filename: string, hasVideo: boolean }>} Saved basename
 *   (name + extension) and whether a video stream was found.
 * @throws {DownloadValidationError} When `url` is invalid.
 * @throws {Error} When yt-dlp fails or the output file is missing.
 */
export async function downloadUrl(url, options = {}) {
  const validatedUrl = validateDownloadUrl(url);
  const { cookies, rateLimit, retries } = options;
  const epoch = String(Math.floor(Date.now() / 1000));
  const stem = nextEpochStem(epoch);
  const outputTemplate = join(originalDir, `${stem}.%(ext)s`);

  logger.info(`[import ${stem}] started: ${validatedUrl}`);

  const baseArgs = [
    "--js-runtimes",
    "node",
    "--no-playlist",
    "-f",
    FORMAT_SELECTOR,
    "--merge-output-format",
    "mp4",
    ...buildOptionalYtDlpArgs({ rateLimit, retries }),
    "-o",
    outputTemplate,
  ];

  try {
    await withCookiesFile(cookies, (cookieArgs) =>
      execFileAsync("yt-dlp", [...baseArgs, ...cookieArgs, "--", validatedUrl], {
        maxBuffer: 10 * 1024 * 1024,
      }),
    );
  } catch (err) {
    const stderr =
      typeof err?.stderr === "string" && err.stderr.trim()
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : "yt-dlp failed";
    logger.error({ stderr }, `[import ${stem}] failed`);
    throw new Error(stderr);
  }

  const filename = findStemFile(stem);
  if (!filename) {
    const message = "yt-dlp finished but no output file was found";
    logger.error({ message }, `[import ${stem}] failed`);
    throw new Error(message);
  }

  const { videoWidth, videoHeight } = await probeVideoDimensions(
    join(originalDir, filename),
  );
  const hasVideo = videoWidth != null && videoHeight != null;

  logger.info(`[import ${stem}] completed: ${filename} (hasVideo=${hasVideo})`);

  return { filename, hasVideo };
}

/**
 * Downloads only the audio from a URL, with no video stream and no muxed
 * container — yt-dlp's `-x`/`--audio-format` extraction (backed by ffmpeg)
 * strips/never-fetches video, unlike `downloadUrl` (which always keeps
 * video when present) or the `"embed"` transcode job (which muxes audio
 * back into a video container for link-unfurl purposes). Prefers a
 * genuinely audio-only source format (`bestaudio`) so no video is even
 * downloaded in the first place; falls back to `best` (downloads combined
 * video+audio, then extracts) only for sources with no separate audio
 * stream.
 *
 * @param {string} url Absolute http(s) URL to download audio from.
 * @param {object} [options] Optional yt-dlp options (see {@link parseYtDlpOptions}),
 *   plus:
 * @param {string} [options.audioFormat] `--audio-format` value (see {@link
 *   validateOptionalAudioFormat}); defaults to `"best"` (no forced re-encode).
 * @returns {Promise<{ filename: string }>} Saved basename (name + extension)
 *   under `MEDIA_STORAGE_DIRECTORY/original`.
 * @throws {DownloadValidationError} When `url` or `audioFormat` is invalid.
 * @throws {Error} When yt-dlp fails or the output file is missing.
 */
export async function downloadAudioOnly(url, options = {}) {
  const validatedUrl = validateDownloadUrl(url);
  const { cookies, rateLimit, retries } = options;
  const audioFormat = validateOptionalAudioFormat(options.audioFormat);
  const epoch = String(Math.floor(Date.now() / 1000));
  const stem = nextEpochStem(epoch);
  const outputTemplate = join(originalDir, `${stem}.%(ext)s`);

  logger.info(`[import-audio ${stem}] started: ${validatedUrl} (audioFormat=${audioFormat})`);

  const baseArgs = [
    "--js-runtimes",
    "node",
    "--no-playlist",
    "-f",
    "bestaudio/best",
    "-x",
    "--audio-format",
    audioFormat,
    ...buildOptionalYtDlpArgs({ rateLimit, retries }),
    "-o",
    outputTemplate,
  ];

  try {
    await withCookiesFile(cookies, (cookieArgs) =>
      execFileAsync("yt-dlp", [...baseArgs, ...cookieArgs, "--", validatedUrl], {
        maxBuffer: 10 * 1024 * 1024,
      }),
    );
  } catch (err) {
    const stderr =
      typeof err?.stderr === "string" && err.stderr.trim()
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : "yt-dlp failed";
    logger.error({ stderr }, `[import-audio ${stem}] failed`);
    throw new Error(stderr);
  }

  const filename = findStemFile(stem);
  if (!filename) {
    const message = "yt-dlp finished but no output file was found";
    logger.error({ message }, `[import-audio ${stem}] failed`);
    throw new Error(message);
  }

  logger.info(`[import-audio ${stem}] completed: ${filename}`);

  return { filename };
}

/**
 * Downloads a URL in a specific, caller-chosen format (by `formatId`), as
 * opposed to `downloadUrl`'s fixed `FORMAT_SELECTOR` (≤1080p, automatic best
 * pick). Always re-probes the URL first and rejects a `formatId` that isn't
 * in the live result — formats aren't a fixed catalog per site, they vary
 * per video and change over time, so the only reliable check is a fresh one
 * right before downloading, not trusting whatever the caller last saw from
 * `POST /download/probe`.
 *
 * When the chosen format is video-only (common for high-resolution adaptive
 * formats), pairs it with the best available audio via a `"<formatId>+bestaudio/<formatId>"`
 * selector — the `/` fallback still resolves to the plain format alone if
 * the merge attempt isn't possible for some reason.
 *
 * @param {string} url Absolute http(s) URL to download.
 * @param {string} formatId yt-dlp format id, validated against a live probe.
 * @param {object} [options] Optional yt-dlp options (see {@link parseYtDlpOptions}).
 * @returns {Promise<{ filename: string, hasVideo: boolean }>} Saved basename
 *   (name + extension) and whether a video stream was found.
 * @throws {DownloadValidationError} When `url`/`formatId` is invalid, or
 *   `formatId` isn't currently available for this URL.
 * @throws {Error} When yt-dlp fails or the output file is missing.
 */
export async function downloadFormat(url, formatId, options = {}) {
  const validatedUrl = validateDownloadUrl(url);
  const validatedFormatId = validateFormatId(formatId);
  const { cookies, rateLimit, retries } = options;

  const info = await probeUrl(validatedUrl, { cookies, rateLimit, retries });
  const isAvailable = info.formats.some((format) => format.formatId === validatedFormatId);
  if (!isAvailable) {
    throw new DownloadValidationError(
      `formatId "${validatedFormatId}" is not currently available for this URL — ` +
        "call POST /download/probe first to determine valid formats",
    );
  }

  const epoch = String(Math.floor(Date.now() / 1000));
  const stem = nextEpochStem(epoch);
  const outputTemplate = join(originalDir, `${stem}.%(ext)s`);

  logger.info(
    `[import-format ${stem}] started: ${validatedUrl} (formatId=${validatedFormatId})`,
  );

  const baseArgs = [
    "--js-runtimes",
    "node",
    "--no-playlist",
    "-f",
    `${validatedFormatId}+bestaudio/${validatedFormatId}`,
    "--merge-output-format",
    "mp4",
    ...buildOptionalYtDlpArgs({ rateLimit, retries }),
    "-o",
    outputTemplate,
  ];

  try {
    await withCookiesFile(cookies, (cookieArgs) =>
      execFileAsync("yt-dlp", [...baseArgs, ...cookieArgs, "--", validatedUrl], {
        maxBuffer: 10 * 1024 * 1024,
      }),
    );
  } catch (err) {
    const stderr =
      typeof err?.stderr === "string" && err.stderr.trim()
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : "yt-dlp failed";
    logger.error({ stderr }, `[import-format ${stem}] failed`);
    throw new Error(stderr);
  }

  const filename = findStemFile(stem);
  if (!filename) {
    const message = "yt-dlp finished but no output file was found";
    logger.error({ message }, `[import-format ${stem}] failed`);
    throw new Error(message);
  }

  const { videoWidth, videoHeight } = await probeVideoDimensions(
    join(originalDir, filename),
  );
  const hasVideo = videoWidth != null && videoHeight != null;

  logger.info(`[import-format ${stem}] completed: ${filename} (hasVideo=${hasVideo})`);

  return { filename, hasVideo };
}

/**
 * Maps a single yt-dlp format entry (from `-J` output) down to the fields a
 * client needs to offer a quality/format picker.
 *
 * @param {Record<string, unknown>} format Raw yt-dlp format object.
 * @returns {object} Mapped format summary.
 */
function mapProbeFormat(format) {
  return {
    formatId: format.format_id ?? null,
    ext: format.ext ?? null,
    height: typeof format.height === "number" ? format.height : null,
    width: typeof format.width === "number" ? format.width : null,
    vcodec: typeof format.vcodec === "string" && format.vcodec !== "none" ? format.vcodec : null,
    acodec: typeof format.acodec === "string" && format.acodec !== "none" ? format.acodec : null,
    fps: typeof format.fps === "number" ? format.fps : null,
    filesizeBytes:
      typeof format.filesize === "number"
        ? format.filesize
        : typeof format.filesize_approx === "number"
          ? format.filesize_approx
          : null,
    tbr: typeof format.tbr === "number" ? format.tbr : null,
    formatNote: format.format_note ?? null,
  };
}

/**
 * Maps a full yt-dlp `-J` info object (single video) down to the fields
 * useful for an import preview.
 *
 * @param {Record<string, unknown>} info Raw yt-dlp info object.
 * @returns {object} Mapped metadata summary.
 */
function mapProbeInfo(info) {
  return {
    id: info.id ?? null,
    title: info.title ?? null,
    description: info.description ?? null,
    uploader: info.uploader ?? null,
    durationSeconds: typeof info.duration === "number" ? info.duration : null,
    thumbnail: info.thumbnail ?? null,
    webpageUrl: info.webpage_url ?? null,
    extractor: info.extractor ?? null,
    formats: Array.isArray(info.formats) ? info.formats.map(mapProbeFormat) : [],
  };
}

/**
 * Fetches metadata for a single URL without downloading anything
 * (`--skip-download -J`), so callers can preview a title/thumbnail/duration
 * and available formats before committing to `downloadUrl`. Like
 * `downloadUrl`, forces single-video mode (`--no-playlist`) — a playlist URL
 * here returns metadata for just its first entry; use {@link probePlaylist}
 * for playlist enumeration.
 *
 * @param {string} url Absolute http(s) URL to probe.
 * @param {object} [options] Optional yt-dlp options (see {@link parseYtDlpOptions}).
 * @returns {Promise<object>} Mapped metadata summary (see {@link mapProbeInfo}).
 * @throws {DownloadValidationError} When `url` is invalid.
 * @throws {Error} When yt-dlp fails or returns unparseable output.
 */
export async function probeUrl(url, options = {}) {
  const validatedUrl = validateDownloadUrl(url);
  const { cookies, rateLimit, retries } = options;

  logger.info(`[probe] started: ${validatedUrl}`);

  const baseArgs = [
    "--js-runtimes",
    "node",
    "--no-playlist",
    "--skip-download",
    "-J",
    ...buildOptionalYtDlpArgs({ rateLimit, retries }),
  ];

  let stdout;
  try {
    ({ stdout } = await withCookiesFile(cookies, (cookieArgs) =>
      execFileAsync("yt-dlp", [...baseArgs, ...cookieArgs, "--", validatedUrl], {
        maxBuffer: 20 * 1024 * 1024,
      }),
    ));
  } catch (err) {
    const stderr =
      typeof err?.stderr === "string" && err.stderr.trim()
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : "yt-dlp failed";
    logger.error({ stderr }, "[probe] failed");
    throw new Error(stderr);
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    const message = "yt-dlp returned malformed metadata";
    logger.error({ message }, "[probe] failed");
    throw new Error(message);
  }

  logger.info(`[probe] completed: ${info?.title ?? validatedUrl}`);

  return mapProbeInfo(info);
}

/**
 * Clamps an optional caller-supplied `limit` to `[1, max]`, defaulting to
 * `max` when absent.
 *
 * @param {number|undefined} limit Validated positive integer, or undefined.
 * @param {number} max Upper bound for this operation.
 * @returns {number} Clamped limit.
 */
function clampPlaylistLimit(limit, max) {
  if (limit === undefined) {
    return max;
  }
  return Math.min(limit, max);
}

/**
 * Maps a single flat-playlist entry (from `--flat-playlist -J` output) down
 * to a downloadable URL plus display metadata. Returns `null` for entries
 * that don't resolve to a valid absolute http(s) URL (e.g. an unsupported
 * extractor's bare id) rather than throwing, so one bad entry doesn't fail
 * enumeration of the rest of the playlist.
 *
 * @param {Record<string, unknown>} entry Raw yt-dlp flat-playlist entry.
 * @returns {object|null} Mapped entry, or `null` when unusable.
 */
function mapPlaylistEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }

  const candidateUrl =
    typeof entry.webpage_url === "string" && entry.webpage_url
      ? entry.webpage_url
      : typeof entry.url === "string"
        ? entry.url
        : null;
  if (!candidateUrl) {
    return null;
  }

  let url;
  try {
    url = validateDownloadUrl(candidateUrl);
  } catch {
    return null;
  }

  return {
    url,
    id: entry.id ?? null,
    title: entry.title ?? null,
    durationSeconds: typeof entry.duration === "number" ? entry.duration : null,
    uploader: entry.uploader ?? null,
  };
}

/**
 * Enumerates a playlist/channel URL's entries via yt-dlp's flat mode
 * (`--flat-playlist -J`), which lists entries without fetching each one's
 * full metadata — fast, and safe to call on very large playlists/channels.
 * Requests one more entry than the cap so `truncated` can be reported
 * accurately, then slices back down to `cap`.
 *
 * @param {string} url Absolute http(s) playlist/channel URL to enumerate.
 * @param {object} [options] Optional yt-dlp options (see {@link parseYtDlpOptions}),
 *   plus:
 * @param {number} [options.limit] Max entries to return (clamped to
 *   `MAX_PLAYLIST_PROBE_ITEMS`).
 * @returns {Promise<{
 *   playlistTitle: string|null,
 *   playlistId: string|null,
 *   entryCount: number,
 *   truncated: boolean,
 *   entries: object[]
 * }>} Enumerated entries plus playlist-level metadata.
 * @throws {DownloadValidationError} When `url` or `limit` is invalid.
 * @throws {Error} When yt-dlp fails or returns unparseable output.
 */
export async function probePlaylist(url, options = {}) {
  const validatedUrl = validateDownloadUrl(url);
  const { cookies, rateLimit, retries, limit } = options;
  const cap = clampPlaylistLimit(limit, MAX_PLAYLIST_PROBE_ITEMS);

  logger.info(`[playlist-probe] started: ${validatedUrl}`);

  const baseArgs = [
    "--js-runtimes",
    "node",
    "--flat-playlist",
    "--skip-download",
    "--playlist-end",
    String(cap + 1),
    "-J",
    ...buildOptionalYtDlpArgs({ rateLimit, retries }),
  ];

  let stdout;
  try {
    ({ stdout } = await withCookiesFile(cookies, (cookieArgs) =>
      execFileAsync("yt-dlp", [...baseArgs, ...cookieArgs, "--", validatedUrl], {
        maxBuffer: 20 * 1024 * 1024,
      }),
    ));
  } catch (err) {
    const stderr =
      typeof err?.stderr === "string" && err.stderr.trim()
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : "yt-dlp failed";
    logger.error({ stderr }, "[playlist-probe] failed");
    throw new Error(stderr);
  }

  let info;
  try {
    info = JSON.parse(stdout);
  } catch {
    const message = "yt-dlp returned malformed playlist metadata";
    logger.error({ message }, "[playlist-probe] failed");
    throw new Error(message);
  }

  const rawEntries = Array.isArray(info.entries) ? info.entries : [info];
  const entries = rawEntries
    .slice(0, cap)
    .map(mapPlaylistEntry)
    .filter((entry) => entry !== null);

  logger.info(
    `[playlist-probe] completed: ${entries.length} entrie(s) from ${info?.title ?? validatedUrl}`,
  );

  return {
    playlistTitle: info.title ?? null,
    playlistId: info.id ?? null,
    entryCount: entries.length,
    truncated: rawEntries.length > cap,
    entries,
  };
}

/**
 * Enumerates a playlist/channel (via {@link probePlaylist}, capped to
 * `MAX_PLAYLIST_DOWNLOAD_ITEMS`) and downloads each entry sequentially with
 * {@link downloadUrl}. Mirrors `downloadUrl`'s own synchronous request model —
 * this isn't queued, so it's deliberately capped small and processes entries
 * one at a time rather than in parallel. One entry failing doesn't abort the
 * rest; each result is reported individually.
 *
 * @param {string} url Absolute http(s) playlist/channel URL.
 * @param {object} [options] Optional yt-dlp options (see {@link parseYtDlpOptions}),
 *   plus:
 * @param {number} [options.limit] Max entries to download (clamped to
 *   `MAX_PLAYLIST_DOWNLOAD_ITEMS`).
 * @returns {Promise<{
 *   playlistTitle: string|null,
 *   playlistId: string|null,
 *   total: number,
 *   succeeded: number,
 *   failed: number,
 *   results: Array<{ url: string, title: string|null } & (
 *     { success: true, filename: string, hasVideo: boolean } |
 *     { success: false, error: string }
 *   )>
 * }>} Per-entry download outcomes.
 * @throws {DownloadValidationError} When `url` or `limit` is invalid.
 * @throws {Error} When enumerating the playlist itself fails.
 */
export async function downloadPlaylist(url, options = {}) {
  const { cookies, rateLimit, retries, limit } = options;
  const cap = clampPlaylistLimit(limit, MAX_PLAYLIST_DOWNLOAD_ITEMS);

  const { playlistTitle, playlistId, entries } = await probePlaylist(url, {
    cookies,
    rateLimit,
    retries,
    limit: cap,
  });

  logger.info(`[playlist-download] downloading ${entries.length} entrie(s) from ${url}`);

  const results = [];
  for (const entry of entries) {
    try {
      const { filename, hasVideo } = await downloadUrl(entry.url, {
        cookies,
        rateLimit,
        retries,
      });
      results.push({ url: entry.url, title: entry.title, success: true, filename, hasVideo });
    } catch (err) {
      const message = err instanceof Error ? err.message : "download failed";
      results.push({ url: entry.url, title: entry.title, success: false, error: message });
    }
  }

  const succeeded = results.filter((result) => result.success).length;

  logger.info(
    `[playlist-download] completed: ${succeeded}/${results.length} succeeded from ${playlistTitle ?? url}`,
  );

  return {
    playlistTitle,
    playlistId,
    total: results.length,
    succeeded,
    failed: results.length - succeeded,
    results,
  };
}
