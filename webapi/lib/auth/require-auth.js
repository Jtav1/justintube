import { findUserByApiKey } from "./api-key.js";
import { Role, User } from "../models/index.js";

/**
 * Extracts a Bearer token from the Authorization header, if present.
 *
 * @param {import('express').Request} req Incoming request.
 * @returns {string} Trimmed token, or empty string when absent.
 */
function bearerToken(req) {
  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match ? match[1].trim() : "";
}

/**
 * Loads a user (with Role) by primary key, returning null when missing or locked.
 *
 * @param {number} userId User id from the session.
 * @returns {Promise<{user: import('sequelize').Model, role: import('sequelize').Model|null}|null>}
 *   User context or null.
 */
async function loadSessionUser(userId) {
  if (!userId) {
    return null;
  }

  const user = await User.findByPk(userId, {
    include: [{ model: Role, required: false }],
  });
  if (!user) {
    return null;
  }

  const role = user.Role || null;
  if (role && role.name === "locked") {
    return null;
  }

  return { user, role };
}

/**
 * Per-request cache key for the resolved auth context, so middleware that
 * runs earlier in the chain (e.g. the global rate limiter) and `requireAuth`
 * itself don't each re-run the session/API-key lookup for the same request.
 *
 * @type {symbol}
 */
const AUTH_CONTEXT_CACHE = Symbol("authContext");

/**
 * Resolves the authenticated user from a Bearer API key or session cookie.
 *
 * @private
 * @param {import('express').Request} req Incoming request.
 * @returns {Promise<{
 *   user: import('sequelize').Model,
 *   role: import('sequelize').Model|null,
 *   authMethod: "session"|"api_key"
 * }|null>} Auth context, or null when unauthenticated / locked.
 */
async function resolveAuth(req) {
  const token = bearerToken(req);
  if (token) {
    const result = await findUserByApiKey(token);
    if (!result) {
      return null;
    }
    return {
      user: result.user,
      role: result.role,
      authMethod: "api_key",
    };
  }

  const sessionUserId = req.session?.userId;
  const result = await loadSessionUser(sessionUserId);
  if (!result) {
    return null;
  }

  return {
    user: result.user,
    role: result.role,
    authMethod: "session",
  };
}

/**
 * Resolves (and caches on `req`) the auth context for the current request.
 * Safe to call multiple times per request - e.g. from a rate-limit `skip`
 * check and later from `requireAuth` - without repeating the session/API-key
 * lookup.
 *
 * @param {import('express').Request} req Incoming request.
 * @returns {Promise<{
 *   user: import('sequelize').Model,
 *   role: import('sequelize').Model|null,
 *   authMethod: "session"|"api_key"
 * }|null>} Auth context, or null when unauthenticated / locked.
 */
export async function getAuthContext(req) {
  if (!(AUTH_CONTEXT_CACHE in req)) {
    req[AUTH_CONTEXT_CACHE] = await resolveAuth(req);
  }
  return req[AUTH_CONTEXT_CACHE];
}

/**
 * Attaches auth context to `req` when credentials are present and valid.
 * Never rejects; leaves `req.user` unset when anonymous or invalid.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} _res Express response (unused).
 * @param {import('express').NextFunction} next Continues after optional attach.
 * @returns {Promise<void>} Always calls `next` unless an unexpected error occurs.
 */
export async function optionalAuth(req, _res, next) {
  try {
    const result = await getAuthContext(req);
    if (result) {
      req.user = result.user;
      req.authRole = result.role;
      req.authMethod = result.authMethod;
    }
    next();
  } catch (err) {
    console.error("optionalAuth failed:", err);
    next();
  }
}

/**
 * Express middleware that requires a valid session cookie or user API key.
 * Sets `req.user`, `req.authRole`, and `req.authMethod` (`"session"` | `"api_key"`).
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when authenticated.
 * @returns {Promise<void>} Sends 401 when authentication fails.
 */
export async function requireAuth(req, res, next) {
  try {
    const result = await getAuthContext(req);
    if (!result) {
      res.status(401).json({
        error: "unauthorized",
        message: "Valid authentication required.",
      });
      return;
    }

    req.user = result.user;
    req.authRole = result.role;
    req.authMethod = result.authMethod;
    next();
  } catch (err) {
    console.error("requireAuth failed:", err);
    res.status(500).json({
      error: "internal_error",
      message: "Authentication failed.",
    });
  }
}
