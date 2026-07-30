/**
 * Parses CORS_ORIGIN into a trimmed allowlist of origins.
 *
 * @param {string|undefined} raw Raw CORS_ORIGIN env value.
 * @returns {string[]} Allowed origin URLs (may be empty).
 */
export function parseCorsOrigins(raw = process.env.CORS_ORIGIN) {
  return String(raw || "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

/**
 * Builds `cors` package options: all origins are reflected and credentialed,
 * regardless of environment or CORS_ORIGIN.
 *
 * @param {object} [options] Override hooks for tests (unused, kept for call-site compatibility).
 * @returns {import('cors').CorsOptions} Options object for the cors middleware.
 */
export function createCorsOptions(options = {}) {
  void options;
  return {
    credentials: true,
    origin: true,
  };
}
