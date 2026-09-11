import bcrypt from "bcryptjs";

/**
 * bcrypt cost factor for password hashes.
 *
 * @type {number}
 */
const BCRYPT_ROUNDS = 12;

/**
 * Hashes a plaintext password with bcrypt.
 *
 * @param {string} plain Plaintext password.
 * @returns {Promise<string>} Bcrypt password hash.
 */
export async function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_ROUNDS);
}

/**
 * Verifies a plaintext password against a stored bcrypt hash.
 *
 * @param {string} plain Plaintext password.
 * @param {string|null|undefined} hash Stored bcrypt hash (nullable for SSO-only).
 * @returns {Promise<boolean>} True when the password matches the hash.
 */
export async function verifyPassword(plain, hash) {
  if (!hash || typeof hash !== "string") {
    return false;
  }
  return bcrypt.compare(plain, hash);
}
