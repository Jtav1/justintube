import { randomBytes, timingSafeEqual } from "node:crypto";

/**
 * HTTP methods that mutate state and therefore require a CSRF token for
 * cookie-authenticated (non-API-key) requests.
 *
 * @type {Set<string>}
 */
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Generates a new random CSRF token string.
 *
 * @returns {string} Hex-encoded CSRF token.
 */
function generateCsrfToken() {
  return randomBytes(32).toString("hex");
}

/**
 * Ensures `req.session.csrfToken` exists, creating one when missing.
 *
 * @param {import('express').Request} req Incoming request with a session.
 * @returns {string} Current CSRF token for the session.
 */
export function ensureCsrfToken(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = generateCsrfToken();
  }
  return req.session.csrfToken;
}

/**
 * Replaces the session CSRF token (call after session.regenerate / login).
 *
 * @param {import('express').Request} req Incoming request with a session.
 * @returns {string} Newly issued CSRF token.
 */
export function rotateCsrfToken(req) {
  req.session.csrfToken = generateCsrfToken();
  return req.session.csrfToken;
}

/**
 * Constant-time comparison of two CSRF token strings.
 *
 * @param {string} expected Token stored in the session.
 * @param {string} provided Token from the X-CSRF-Token header.
 * @returns {boolean} True when tokens match.
 */
function tokensMatch(expected, provided) {
  const left = Buffer.from(String(expected || ""), "utf8");
  const right = Buffer.from(String(provided || ""), "utf8");
  if (left.length === 0 || left.length !== right.length) {
    return false;
  }
  return timingSafeEqual(left, right);
}

/**
 * Express middleware that enforces the synchronizer CSRF token for unsafe
 * methods when the client is not presenting an API-key Bearer token.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when CSRF is valid or skipped.
 * @returns {void} Sends 403 when the CSRF token is missing or mismatched.
 */
export function csrfProtection(req, res, next) {
  const method = String(req.method || "").toUpperCase();
  if (!UNSAFE_METHODS.has(method)) {
    next();
    return;
  }

  const authHeader = String(req.headers.authorization || "");
  if (/^Bearer\s+\S+/i.test(authHeader)) {
    next();
    return;
  }

  const expected = req.session?.csrfToken;
  const provided = String(req.headers["x-csrf-token"] || "");
  if (!expected || !tokensMatch(expected, provided)) {
    res.status(403).json({
      error: "csrf_invalid",
      message: "Valid X-CSRF-Token header required.",
    });
    return;
  }

  next();
}
