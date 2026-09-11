import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time comparison of two strings, safe for comparing secrets
 * (tokens, keys) without leaking timing information about where they first
 * differ. Differing lengths short-circuit (length itself isn't secret).
 *
 * @param {string} expected Known-good value.
 * @param {string} provided Value supplied by the caller.
 * @returns {boolean} True when both strings are non-empty and equal.
 */
export function timingSafeStringEqual(expected, provided) {
  const left = Buffer.from(String(expected || ""), "utf8");
  const right = Buffer.from(String(provided || ""), "utf8");
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}
