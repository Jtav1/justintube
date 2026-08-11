import { createHash, randomBytes } from "node:crypto";

/**
 * Number of trailing asterisks appended after the stored key prefix in list UIs.
 *
 * @type {number}
 */
const KEY_DISPLAY_MASK_LENGTH = 24;

/**
 * Computes the SHA-256 hex digest of a raw stream key for storage and lookup.
 *
 * @param {string} rawKey Plaintext stream key presented by the encoder.
 * @returns {string} Lowercase hex SHA-256 digest.
 */
export function hashStreamKey(rawKey) {
  return createHash("sha256").update(String(rawKey), "utf8").digest("hex");
}

/**
 * Generates a new RTMP stream key and its storage fields. The plaintext is
 * returned once for the rotate response; only hash + prefix should be
 * persisted to STREAM_KEYS.
 *
 * @returns {{ rawKey: string, keyHash: string, keyPrefix: string }} Fresh key
 *   material ready for insertion into STREAM_KEYS.
 */
export function generateStreamKey() {
  const rawKey = `sk_${randomBytes(32).toString("hex")}`;
  return {
    rawKey,
    keyHash: hashStreamKey(rawKey),
    keyPrefix: rawKey.slice(0, 8),
  };
}

/**
 * Builds a masked display string from a stored non-secret key prefix for the
 * Go Live page. Never reconstructs or reveals the full key.
 *
 * @param {string} keyPrefix Leading characters stored on the stream key row.
 * @returns {string} Prefix followed by a fixed run of asterisks.
 */
export function maskStreamKeyPrefix(keyPrefix) {
  return `${String(keyPrefix || "")}${"*".repeat(KEY_DISPLAY_MASK_LENGTH)}`;
}
