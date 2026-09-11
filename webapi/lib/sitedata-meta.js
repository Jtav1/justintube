import { isAbsolute, join, resolve } from "node:path";

const SITEDATA_STORAGE_DIRECTORY =
  process.env.SITEDATA_STORAGE_DIRECTORY || "media/sitedata";

/**
 * Absolute path to the sitedata root (avatars and other site-owned images,
 * distinct from the video `media` root). Relative env values are resolved
 * against the process working directory, mirroring `mediaDir` in
 * `lib/media-meta.js`.
 *
 * @type {string}
 */
export const sitedataDir = isAbsolute(SITEDATA_STORAGE_DIRECTORY)
  ? SITEDATA_STORAGE_DIRECTORY
  : resolve(process.cwd(), SITEDATA_STORAGE_DIRECTORY);

/**
 * Resolves a relative storage path (e.g. `"avatars/<filename>"`) to an
 * absolute path under the sitedata root.
 *
 * @param {string} relativeStoragePath Path relative to `sitedataDir`.
 * @returns {string} Absolute filesystem path.
 */
export function resolveSitedataPath(relativeStoragePath) {
  return join(sitedataDir, relativeStoragePath);
}
