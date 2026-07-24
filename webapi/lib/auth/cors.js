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
 * Builds `cors` package options: credentialed allowlist in all envs; production
 * never reflects arbitrary Origins when the allowlist is empty.
 *
 * @param {object} [options] Override hooks for tests.
 * @param {string} [options.nodeEnv] Effective NODE_ENV (defaults to process.env).
 * @param {string} [options.corsOrigin] Effective CORS_ORIGIN string.
 * @param {(message: string) => void} [options.warn] Logger for production warnings.
 * @returns {import('cors').CorsOptions} Options object for the cors middleware.
 */
export function createCorsOptions(options = {}) {
  const nodeEnv = options.nodeEnv ?? process.env.NODE_ENV ?? "";
  const allowlist = parseCorsOrigins(
    options.corsOrigin ?? process.env.CORS_ORIGIN,
  );
  const warn = options.warn ?? ((message) => console.warn(message));
  const isProduction = nodeEnv === "production";

  if (allowlist.length > 0) {
    return {
      credentials: true,
      origin(origin, callback) {
        // Non-browser / same-origin tools may omit Origin.
        if (!origin || allowlist.includes(origin)) {
          callback(null, true);
          return;
        }
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      },
    };
  }

  if (isProduction) {
    warn(
      "[api]: CORS_ORIGIN is unset in production; credentialed cross-origin requests are disabled.",
    );
    return {
      credentials: true,
      origin: false,
    };
  }

  return {
    credentials: true,
    origin: true,
  };
}
