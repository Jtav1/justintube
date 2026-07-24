import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { Op } from "sequelize";
import { Role, User, UserApiKey } from "../models/index.js";

/**
 * Number of trailing asterisks appended after the stored key prefix in list UIs.
 *
 * @type {number}
 */
const KEY_DISPLAY_MASK_LENGTH = 24;

/**
 * Computes the SHA-256 hex digest of a raw API key for storage and lookup.
 *
 * @param {string} rawKey Plaintext API key presented by the client.
 * @returns {string} Lowercase hex SHA-256 digest.
 */
export function hashApiKey(rawKey) {
  return createHash("sha256").update(String(rawKey), "utf8").digest("hex");
}

/**
 * Returns a short non-secret prefix suitable for list UIs.
 *
 * @param {string} rawKey Plaintext API key.
 * @param {number} [length=8] Number of leading characters to keep.
 * @returns {string} Key prefix string.
 */
export function apiKeyPrefix(rawKey, length = 8) {
  return String(rawKey).slice(0, length);
}

/**
 * Generates a new API key and its storage fields. The plaintext is returned
 * once for the create response; only hash + prefix should be persisted.
 *
 * @returns {{ rawKey: string, keyHash: string, keyPrefix: string }} Fresh key
 *   material ready for insertion into USER_API_KEYS.
 */
export function generateApiKey() {
  const rawKey = `jt_${randomBytes(32).toString("hex")}`;
  return {
    rawKey,
    keyHash: hashApiKey(rawKey),
    keyPrefix: apiKeyPrefix(rawKey),
  };
}

/**
 * Builds a masked display string from a stored non-secret key prefix for list
 * and admin UIs. Never reconstructs or reveals the full key.
 *
 * @param {string} keyPrefix Leading characters stored on the API key row.
 * @returns {string} Prefix followed by a fixed run of asterisks.
 */
export function maskApiKeyPrefix(keyPrefix) {
  return `${String(keyPrefix || "")}${"*".repeat(KEY_DISPLAY_MASK_LENGTH)}`;
}

/**
 * Compares two hex digests in constant time when lengths match.
 *
 * @param {string} a First hex digest.
 * @param {string} b Second hex digest.
 * @returns {boolean} True when digests are equal.
 */
function safeEqualHex(a, b) {
  const left = Buffer.from(String(a), "utf8");
  const right = Buffer.from(String(b), "utf8");
  if (left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Resolves an active (non-expired, non-revoked) API key to its owning user and
 * role. Returns null when the key is missing, invalid, expired, revoked, or
 * the owner is locked.
 *
 * @param {string} rawKey Plaintext API key from Authorization Bearer.
 * @returns {Promise<{user: import('sequelize').Model, role: import('sequelize').Model|null, apiKey: import('sequelize').Model}|null>}
 *   Authenticated user context, or null when auth fails.
 */
export async function findUserByApiKey(rawKey) {
  const trimmed = String(rawKey || "").trim();
  if (!trimmed) {
    return null;
  }

  const keyHash = hashApiKey(trimmed);
  const row = await UserApiKey.findOne({
    where: {
      keyHash,
      revokedAt: { [Op.is]: null },
      expiresAt: { [Op.gt]: new Date() },
    },
    include: [
      {
        model: User,
        required: true,
        include: [{ model: Role, required: false }],
      },
    ],
  });

  if (!row || !safeEqualHex(row.keyHash, keyHash)) {
    return null;
  }

  const user = row.User;
  if (!user) {
    return null;
  }

  const role = user.Role || null;
  if (role && role.name === "locked") {
    return null;
  }

  return { user, role, apiKey: row };
}
