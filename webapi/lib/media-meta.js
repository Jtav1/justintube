import { isAbsolute, join, resolve } from "node:path";

const MEDIA_STORAGE_DIRECTORY = process.env.MEDIA_STORAGE_DIRECTORY || "media";

/**
 * Absolute path to the media root. Relative env values are resolved against
 * the process working directory. Mirrors the same computation in
 * `routes/uploads.js` and `processing/lib/media-paths.js`.
 *
 * @type {string}
 */
export const mediaDir = isAbsolute(MEDIA_STORAGE_DIRECTORY)
  ? MEDIA_STORAGE_DIRECTORY
  : resolve(process.cwd(), MEDIA_STORAGE_DIRECTORY);

/**
 * Resolves a relative storage path (as stored on ORIGINAL_UPLOADS,
 * FILE_VERSIONS, etc., e.g. `"transcoded/<uuid>.mp4"`) to an absolute path
 * under the media root.
 *
 * @param {string} relativeStoragePath Path relative to `mediaDir`.
 * @returns {string} Absolute filesystem path.
 */
export function resolveMediaPath(relativeStoragePath) {
  return join(mediaDir, relativeStoragePath);
}

/**
 * Infers an image MIME type from a thumbnail filename's extension.
 *
 * @param {string} filename Thumbnail filename (e.g. "abc123.jpg").
 * @returns {string|null} MIME type, or null when unknown.
 */
export function mimeTypeForImage(filename) {
  const ext = String(filename || "")
    .trim()
    .toLowerCase()
    .split(".")
    .pop();
  /** @type {Record<string, string>} */
  const map = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
  };
  return map[ext] || null;
}

/**
 * Height → resolution ladder shared with processing probe semantics.
 *
 * @type {Array<{ label: string, height: number }>}
 */
const RESOLUTION_LADDER = [
  { label: "240p", height: 240 },
  { label: "360p", height: 360 },
  { label: "480p", height: 480 },
  { label: "720p", height: 720 },
  { label: "1080p", height: 1080 },
  { label: "2kHD", height: 1440 },
  { label: "4kHD", height: 2160 },
];

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

  let best = RESOLUTION_LADDER[0];
  let bestDelta = Math.abs(height - best.height);
  for (const step of RESOLUTION_LADDER) {
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
    avi: "video/x-msvideo",
    wmv: "video/x-ms-wmv",
    flv: "video/x-flv",
    mpg: "video/mpeg",
    mpeg: "video/mpeg",
    m4v: "video/x-m4v",
    "3gp": "video/3gpp",
    ts: "video/mp2t",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    aac: "audio/aac",
    flac: "audio/flac",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/opus",
    wma: "audio/x-ms-wma",
    aiff: "audio/aiff",
    aif: "audio/aiff",
    amr: "audio/amr",
  };
  return map[key] || null;
}

/**
 * Fixed set of file extensions recognized as audio-only containers,
 * independent of the deployment-configurable FILETYPES_ALLOWED allowlist —
 * classification must stay deterministic regardless of what an admin has
 * enabled for upload.
 *
 * @type {Set<string>}
 */
const AUDIO_EXTENSIONS = new Set([
  "mp3",
  "wav",
  "m4a",
  "aac",
  "flac",
  "ogg",
  "oga",
  "opus",
  "wma",
  "aiff",
  "aif",
  "amr",
]);

/**
 * Classifies a file extension as an audio-only or video media type.
 *
 * @param {string} extension Container/extension (e.g. "mp3", "mp4"), with or without a leading dot.
 * @returns {"audio"|"video"} "audio" for a recognized audio-only container, "video" otherwise.
 */
export function mediaTypeForExtension(extension) {
  const key = String(extension || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  return AUDIO_EXTENSIONS.has(key) ? "audio" : "video";
}

/**
 * Builds the planned relative storage path for a transcoded file version.
 *
 * @param {string} uuidName File version UUID (no extension).
 * @param {string} fileExtension Container / extension without a leading dot.
 * @returns {string} Path like `transcoded/<uuid>.<ext>`.
 */
export function plannedTranscodedStoragePath(uuidName, fileExtension) {
  const ext = String(fileExtension || "")
    .trim()
    .toLowerCase()
    .replace(/^\./, "");
  return ext ? `transcoded/${uuidName}.${ext}` : `transcoded/${uuidName}`;
}
