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
 * Builds `cors` package options. When `CORS_ORIGIN` lists one or more
 * origins, only those are allowed (credentialed). When it's empty, requests
 * are reflected outside production (for local/dev convenience) but rejected
 * in production, since a credentialed wildcard would defeat CORS entirely.
 *
 * @param {object} [options] Overrides, primarily for tests.
 * @param {string} [options.nodeEnv] Overrides `process.env.NODE_ENV`.
 * @param {string} [options.corsOrigin] Overrides `process.env.CORS_ORIGIN`.
 * @returns {import('cors').CorsOptions} Options object for the cors middleware.
 */
export function createCorsOptions(options = {}) {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV;
  const allowlist = parseCorsOrigins(options.corsOrigin ?? process.env.CORS_ORIGIN);

  if (allowlist.length > 0) {
    return {
      credentials: true,
      origin(origin, callback) {
        if (!origin || allowlist.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error("Not allowed by CORS"));
      },
    };
  }

  return {
    credentials: true,
    origin: nodeEnv !== "production",
  };
}
