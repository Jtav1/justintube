import { accessSync, constants, mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

const MEDIA_STORAGE_DIRECTORY = process.env.MEDIA_STORAGE_DIRECTORY || "media";

/**
 * Absolute path to the media root. Relative env values are resolved against
 * the process working directory.
 *
 * @type {string}
 */
export const mediaDir = isAbsolute(MEDIA_STORAGE_DIRECTORY)
  ? MEDIA_STORAGE_DIRECTORY
  : resolve(process.cwd(), MEDIA_STORAGE_DIRECTORY);

/**
 * Absolute path where original uploads are read (`media/original`).
 *
 * @type {string}
 */
export const originalDir = join(mediaDir, "original");

/**
 * Absolute path where transcoded outputs are written (`media/transcoded`).
 *
 * @type {string}
 */
export const transcodedDir = join(mediaDir, "transcoded");

/**
 * Absolute path where generated video thumbnails are written (`media/thumbnails`).
 *
 * @type {string}
 */
export const thumbnailsDir = join(mediaDir, "thumbnails");

mkdirSync(originalDir, { recursive: true });
mkdirSync(transcodedDir, { recursive: true });
mkdirSync(thumbnailsDir, { recursive: true });

/**
 * Error thrown for invalid client input (maps to HTTP 400).
 */
export class TranscodeValidationError extends Error {
  /**
   * @param {string} message Human-readable validation failure.
   */
  constructor(message) {
    super(message);
    this.name = "TranscodeValidationError";
  }
}

/**
 * Validates that `filename` is a plain basename (no path separators or `..`).
 *
 * @param {unknown} filename Value from the request body.
 * @returns {string} Sanitized basename string.
 * @throws {TranscodeValidationError} When the filename is missing or unsafe.
 */
export function validateInputFilename(filename) {
  if (typeof filename !== "string" || !filename.trim()) {
    throw new TranscodeValidationError(
      "filename is required and must be a string",
    );
  }

  const trimmed = filename.trim();
  if (
    trimmed !== basename(trimmed) ||
    trimmed.includes("..") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes(sep)
  ) {
    throw new TranscodeValidationError(
      "filename must be a basename without path separators",
    );
  }

  return trimmed;
}

/**
 * Resolves an original-media basename to an absolute path under `originalDir`
 * and confirms the file is readable.
 *
 * @param {string} filename Validated basename under `/media/original`.
 * @returns {string} Absolute path to the readable original file.
 * @throws {TranscodeValidationError} When the file is missing or unreadable.
 */
export function resolveOriginalInputPath(filename) {
  const safeName = validateInputFilename(filename);
  const absolutePath = join(originalDir, safeName);

  try {
    accessSync(absolutePath, constants.R_OK);
  } catch {
    throw new TranscodeValidationError(
      `input file not found in original/: ${safeName}`,
    );
  }

  return absolutePath;
}

/**
 * Builds the absolute output path for a transcoded basename under
 * `transcodedDir`.
 *
 * @param {string} outputFilename Basename to write under `/media/transcoded`.
 * @returns {string} Absolute path for the output file.
 */
export function resolveTranscodedOutputPath(outputFilename) {
  return join(transcodedDir, outputFilename);
}

/**
 * Builds the absolute output path for a normalize job's basename under
 * `originalDir` — the normalized (H.264/AAC MP4) file becomes the upload's
 * new "original", so it belongs alongside other original uploads rather than
 * in `transcodedDir` (which holds derived renditions, not sources). Its
 * basename always differs from the source input's (new extension), so this
 * never collides with the file ffmpeg is reading.
 *
 * @param {string} outputFilename Basename to write under `/media/original`.
 * @returns {string} Absolute path for the output file.
 */
export function resolveNormalizedOutputPath(outputFilename) {
  return join(originalDir, outputFilename);
}

/**
 * Builds the absolute output path for a thumbnail basename under
 * `thumbnailsDir`.
 *
 * @param {string} outputFilename Basename to write under `/media/thumbnails`.
 * @returns {string} Absolute path for the output file.
 */
export function resolveThumbnailOutputPath(outputFilename) {
  return join(thumbnailsDir, outputFilename);
}
