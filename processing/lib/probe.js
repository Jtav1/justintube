import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

/**
 * Maps a frame height to the nearest Justintube resolution label.
 *
 * @param {number} height Frame height in pixels.
 * @returns {string|null} Resolution label, or null when height is invalid.
 */
export function heightToResolution(height) {
  if (!Number.isFinite(height) || height <= 0) {
    return null;
  }

  /** @type {Array<{ label: string, height: number }>} */
  const ladder = [
    { label: "240p", height: 240 },
    { label: "360p", height: 360 },
    { label: "480p", height: 480 },
    { label: "720p", height: 720 },
    { label: "1080p", height: 1080 },
    { label: "2kHD", height: 1440 },
    { label: "4kHD", height: 2160 },
  ];

  let best = ladder[0];
  let bestDelta = Math.abs(height - best.height);
  for (const step of ladder) {
    const delta = Math.abs(height - step.height);
    if (delta < bestDelta) {
      best = step;
      bestDelta = delta;
    }
  }
  return best.label;
}

/**
 * Infers a MIME type from a container / file extension token.
 *
 * @param {string} container Container or extension (e.g. mp4, webm).
 * @returns {string|null} MIME type, or null when unknown.
 */
export function mimeTypeForContainer(container) {
  const key = String(container || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  /** @type {Record<string, string>} */
  const map = {
    mp4: "video/mp4",
    webm: "video/webm",
    mkv: "video/x-matroska",
    mov: "video/quicktime",
  };
  return map[key] || null;
}

/**
 * Probes a media file with ffprobe and returns primary video stream dimensions.
 *
 * @param {string} filePath Absolute path to the media file.
 * @returns {Promise<{ videoWidth: number|null, videoHeight: number|null }>}
 *   Stream dimensions when available.
 * @throws {Error} When ffprobe exits non-zero or cannot be spawned.
 */
export async function probeVideoDimensions(filePath) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    { maxBuffer: 2 * 1024 * 1024 },
  );

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { videoWidth: null, videoHeight: null };
  }

  const stream = Array.isArray(parsed?.streams) ? parsed.streams[0] : null;
  const videoWidth =
    stream && Number.isInteger(stream.width) && stream.width > 0
      ? stream.width
      : null;
  const videoHeight =
    stream && Number.isInteger(stream.height) && stream.height > 0
      ? stream.height
      : null;

  return { videoWidth, videoHeight };
}

/**
 * Returns true when applying `profile` would upscale the source (profile
 * height or width exceeds the source). Profiles at or below the source size
 * are eligible for downscale / same-size re-encode.
 *
 * @param {{ outputWidth: number, outputHeight: number }} profile Target profile dims.
 * @param {{ videoWidth: number|null, videoHeight: number|null }} source
 *   Probed source stream dimensions.
 * @returns {boolean} `true` when this profile should be skipped.
 */
export function shouldSkipProfileForSource(profile, source) {
  const sourceWidth = source?.videoWidth;
  const sourceHeight = source?.videoHeight;
  if (
    !Number.isInteger(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isInteger(sourceHeight) ||
    sourceHeight <= 0
  ) {
    // Cannot compare — do not skip (fail open).
    return false;
  }

  return (
    profile.outputWidth > sourceWidth || profile.outputHeight > sourceHeight
  );
}

/**
 * Returns true when `profile`'s orientation (horizontal: width > height,
 * vertical: height > width) does not match the source's orientation. Square
 * dimensions (width === height), for either the profile or the source, are
 * treated as orientation-agnostic and never cause a skip.
 *
 * @param {{ outputWidth: number, outputHeight: number }} profile Target profile dims.
 * @param {{ videoWidth: number|null, videoHeight: number|null }} source
 *   Probed source stream dimensions.
 * @returns {boolean} `true` when this profile should be skipped.
 */
export function shouldSkipProfileForOrientation(profile, source) {
  const sourceWidth = source?.videoWidth;
  const sourceHeight = source?.videoHeight;
  if (
    !Number.isInteger(sourceWidth) ||
    sourceWidth <= 0 ||
    !Number.isInteger(sourceHeight) ||
    sourceHeight <= 0 ||
    sourceWidth === sourceHeight
  ) {
    // Cannot compare, or source is square — do not skip (fail open).
    return false;
  }

  if (profile.outputWidth === profile.outputHeight) {
    return false;
  }

  const sourceIsHorizontal = sourceWidth > sourceHeight;
  const profileIsHorizontal = profile.outputWidth > profile.outputHeight;
  return sourceIsHorizontal !== profileIsHorizontal;
}

/**
 * Probes a media file with ffprobe and returns its duration in whole seconds.
 *
 * @param {string} filePath Absolute path to the media file.
 * @returns {Promise<number|null>} Duration rounded to the nearest second, or
 *   null when ffprobe didn't report a usable duration.
 * @throws {Error} When ffprobe exits non-zero or cannot be spawned.
 */
export async function probeVideoDuration(filePath) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "json", filePath],
    { maxBuffer: 2 * 1024 * 1024 },
  );

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }

  const seconds = Number(parsed?.format?.duration);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return null;
  }
  return Math.round(seconds);
}

/**
 * Computes a content-based hash of a media file's primary video stream via
 * ffmpeg's `hash` muxer. Unlike a raw file checksum, this hashes decoded
 * frame data, so it stays stable across container remuxes or re-encodes of
 * the same visual source (e.g. two yt-dlp downloads of the same URL at
 * different times/qualities) — the "consistent and re-creatable" property
 * duplicate-upload detection needs. This decodes the entire video stream, so
 * it can be slow for long files; callers should run it as its own
 * fire-and-forget job rather than inline in a request handler.
 *
 * @param {string} filePath Absolute path to the media file.
 * @returns {Promise<string>} Hash string of the form `sha256:<hex>`.
 * @throws {Error} When ffmpeg exits non-zero, cannot be spawned, or its
 *   output doesn't contain a parseable hash.
 */
export async function computeContentHash(filePath) {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-f",
      "hash",
      "-hash",
      "sha256",
      "-",
    ],
    { maxBuffer: 2 * 1024 * 1024 },
  );

  const match = stdout.match(/SHA256=([0-9a-fA-F]+)/);
  if (!match) {
    throw new Error("ffmpeg did not return a content hash");
  }
  return `sha256:${match[1].toLowerCase()}`;
}

/**
 * Collects on-disk size and probed dimensions for a completed transcode output.
 *
 * @param {object} options Probe inputs.
 * @param {string} options.outputPath Absolute path to the output file.
 * @param {string} options.outputFilename Basename under `/media/transcoded`.
 * @param {string} options.outputContainer Container / extension token.
 * @returns {Promise<{
 *   fileSizeBytes: number,
 *   videoWidth: number|null,
 *   videoHeight: number|null,
 *   resolution: string|null,
 *   storagePath: string,
 *   mimeType: string|null
 * }>} Metadata payload suitable for the API complete callback.
 */
export async function collectOutputMetadata({
  outputPath,
  outputFilename,
  outputContainer,
}) {
  const fileStat = await stat(outputPath);
  let videoWidth = null;
  let videoHeight = null;

  try {
    const probed = await probeVideoDimensions(outputPath);
    videoWidth = probed.videoWidth;
    videoHeight = probed.videoHeight;
  } catch (err) {
    logger.error({ err }, "ffprobe failed for transcode output");
  }

  return {
    fileSizeBytes: fileStat.size,
    videoWidth,
    videoHeight,
    resolution: heightToResolution(videoHeight ?? 0),
    storagePath: `transcoded/${outputFilename}`,
    mimeType: mimeTypeForContainer(outputContainer),
  };
}
