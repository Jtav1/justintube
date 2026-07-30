import { randomInt } from "node:crypto";
import { OriginalUpload } from "./models/index.js";

/**
 * Alphabet for public video ids: uppercase, lowercase, and digits.
 *
 * @type {string}
 */
export const VIDEO_ID_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Length of a generated video id, in characters.
 *
 * @type {number}
 */
export const VIDEO_ID_LENGTH = 6;

/**
 * Generates a random 6-character alphanumeric video id (case-sensitive —
 * upper and lowercase letters are distinct). Pure, no DB access.
 *
 * @returns {string} A freshly generated video id.
 */
export function generateVideoId() {
  let id = "";
  for (let i = 0; i < VIDEO_ID_LENGTH; i += 1) {
    id += VIDEO_ID_ALPHABET[randomInt(VIDEO_ID_ALPHABET.length)];
  }
  return id;
}

/**
 * Generates a video id guaranteed not to already exist on ORIGINAL_UPLOADS,
 * retrying on the rare collision.
 *
 * @param {object} [options] Generation options.
 * @param {number} [options.maxAttempts=10] Maximum generation attempts before giving up.
 * @returns {Promise<string>} A video id confirmed unique at generation time.
 * @throws {Error} If no unique id could be generated within `maxAttempts`.
 */
export async function generateUniqueVideoId({ maxAttempts = 10 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateVideoId();
    const existing = await OriginalUpload.findOne({ where: { videoId: candidate } });
    if (!existing) {
      return candidate;
    }
  }
  throw new Error("Failed to generate a unique video id after multiple attempts.");
}
