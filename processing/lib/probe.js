import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import { promisify } from "node:util";

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
    console.error(
      "ffprobe failed for transcode output:",
      err instanceof Error ? err.message : err,
    );
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
