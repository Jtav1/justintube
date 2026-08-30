import { accessSync, constants, mkdirSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

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
 * Validates that `value` is either a plain basename, or exactly one
 * subfolder segment plus a basename (`<segment>/<basename>`), where
 * `segment` is a positive-integer userId or the literal `_unowned` — the
 * per-user media layout convention shared with webapi. Rejects traversal,
 * absolute paths, multiple nesting levels, and empty segments.
 *
 * @param {unknown} value Value from the request body.
 * @param {string} fieldLabel Field name to use in error messages.
 * @returns {string} Sanitized relative path string.
 * @throws {TranscodeValidationError} When the value is missing or unsafe.
 */
function validateRelativeMediaPath(value, fieldLabel) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TranscodeValidationError(
      `${fieldLabel} is required and must be a string`,
    );
  }

  const trimmed = value.trim();
  if (
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.includes(sep) ||
    isAbsolute(trimmed)
  ) {
    throw new TranscodeValidationError(
      `${fieldLabel} must not contain traversal or absolute paths`,
    );
  }

  const parts = trimmed.split("/");
  if (parts.length > 2 || parts.some((part) => !part)) {
    throw new TranscodeValidationError(
      `${fieldLabel} must be a basename, or "<userId|_unowned>/<basename>"`,
    );
  }

  if (parts.length === 2) {
    const [segment, name] = parts;
    if (segment !== "_unowned" && !/^[1-9][0-9]*$/.test(segment)) {
      throw new TranscodeValidationError(
        `${fieldLabel} subfolder must be a positive integer userId or "_unowned"`,
      );
    }
    if (name !== basename(name)) {
      throw new TranscodeValidationError(`${fieldLabel} basename is invalid`);
    }
  } else if (trimmed !== basename(trimmed)) {
    throw new TranscodeValidationError(
      `${fieldLabel} must be a basename without path separators`,
    );
  }

  return trimmed;
}

/**
 * Validates that `filename` is a plain basename, or a
 * `<userId|_unowned>/<basename>` relative path (see
 * {@link validateRelativeMediaPath}).
 *
 * @param {unknown} filename Value from the request body.
 * @returns {string} Sanitized relative path string.
 * @throws {TranscodeValidationError} When the filename is missing or unsafe.
 */
export function validateInputFilename(filename) {
  return validateRelativeMediaPath(filename, "filename");
}

/**
 * Resolves an original-media relative path to an absolute path under
 * `originalDir` and confirms the file is readable. Deliberately does not
 * create any directory — a missing subfolder here means "not found", not
 * "create it for me" (unlike the output resolvers below, which do write into
 * a not-yet-existing per-user subfolder).
 *
 * @param {string} filename Validated relative path under `/media/original`.
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
 * Validates `outputFilename` and resolves it to an absolute path under
 * `baseDir`, creating its parent directory (e.g. a not-yet-existing per-user
 * subfolder) if needed.
 *
 * @param {string} baseDir Absolute directory the output belongs under.
 * @param {string} outputFilename Relative path to write under `baseDir`.
 * @param {string} fieldLabel Field name to use in error messages.
 * @returns {string} Absolute path for the output file.
 */
function resolveOutputPath(baseDir, outputFilename, fieldLabel) {
  const safeName = validateRelativeMediaPath(outputFilename, fieldLabel);
  const absolutePath = join(baseDir, safeName);
  mkdirSync(dirname(absolutePath), { recursive: true });
  return absolutePath;
}

/**
 * Builds the absolute output path for a transcoded rendition under
 * `transcodedDir`, e.g. `<userId>/<uuid>.<ext>`.
 *
 * @param {string} outputFilename Relative path to write under `/media/transcoded`.
 * @returns {string} Absolute path for the output file.
 */
export function resolveTranscodedOutputPath(outputFilename) {
  return resolveOutputPath(transcodedDir, outputFilename, "outputFilename");
}

/**
 * Builds the absolute output path for a normalize job's output under
 * `originalDir` — the normalized (H.264/AAC MP4) file becomes the upload's
 * new "original", so it belongs alongside other original uploads rather than
 * in `transcodedDir` (which holds derived renditions, not sources). Its
 * basename always differs from the source input's (new extension/new uuid),
 * so this never collides with the file ffmpeg is reading.
 *
 * @param {string} outputFilename Relative path to write under `/media/original`.
 * @returns {string} Absolute path for the output file.
 */
export function resolveNormalizedOutputPath(outputFilename) {
  return resolveOutputPath(originalDir, outputFilename, "outputFilename");
}

/**
 * Builds the absolute output path for a thumbnail under `thumbnailsDir`, e.g.
 * `<userId>/<basename>`.
 *
 * @param {string} outputFilename Relative path to write under `/media/thumbnails`.
 * @returns {string} Absolute path for the output file.
 */
export function resolveThumbnailOutputPath(outputFilename) {
  return resolveOutputPath(thumbnailsDir, outputFilename, "outputFilename");
}
