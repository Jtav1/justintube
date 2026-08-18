import { randomInt } from "node:crypto";
import { CastSession } from "../models/index.js";

/**
 * Alphabet for CAST session join codes: uppercase letters and digits, with
 * visually ambiguous characters (0/O, 1/I) removed since these codes are
 * meant to be read off a screen and typed on another device.
 *
 * @type {string}
 */
export const CAST_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/**
 * Length of a generated CAST join code, in characters.
 *
 * @type {number}
 */
export const CAST_CODE_LENGTH = 6;

/**
 * Generates a random 6-character join code. Pure, no DB access.
 *
 * @returns {string} A freshly generated code.
 */
export function generateCastCode() {
  let code = "";
  for (let i = 0; i < CAST_CODE_LENGTH; i += 1) {
    code += CAST_CODE_ALPHABET[randomInt(CAST_CODE_ALPHABET.length)];
  }
  return code;
}

/**
 * Generates a join code guaranteed not to already belong to another
 * `status: "active"` CAST_SESSIONS row, retrying on the rare collision.
 * Uniqueness is scoped to active sessions only (mirrors how `code` is looked
 * up in `joinSessionByCode`), so an ended session's old code can be reused.
 *
 * @param {object} [options] Generation options.
 * @param {number} [options.maxAttempts=10] Maximum generation attempts before giving up.
 * @returns {Promise<string>} A code confirmed unique among active sessions at generation time.
 * @throws {Error} If no unique code could be generated within `maxAttempts`.
 */
export async function generateUniqueCastCode({ maxAttempts = 10 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = generateCastCode();
    const existing = await CastSession.findOne({
      where: { code: candidate, status: "active" },
    });
    if (!existing) {
      return candidate;
    }
  }
  throw new Error("Failed to generate a unique CAST session code after multiple attempts.");
}
