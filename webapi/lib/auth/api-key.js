import { createHash, timingSafeEqual } from "node:crypto";
import { Op } from "sequelize";
import { Role, User, UserApiKey } from "../models/index.js";

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
