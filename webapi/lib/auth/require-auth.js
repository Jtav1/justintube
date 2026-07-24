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
    const token = bearerToken(req);
    if (token) {
      const result = await findUserByApiKey(token);
      if (!result) {
        res.status(401).json({
          error: "unauthorized",
          message: "Valid authentication required.",
        });
        return;
      }
      req.user = result.user;
      req.authRole = result.role;
      req.authMethod = "api_key";
      next();
      return;
    }

    const sessionUserId = req.session?.userId;
    const result = await loadSessionUser(sessionUserId);
    if (!result) {
      res.status(401).json({
        error: "unauthorized",
        message: "Valid authentication required.",
      });
      return;
    }

    req.user = result.user;
    req.authRole = result.role;
    req.authMethod = "session";
    next();
  } catch (err) {
    console.error("requireAuth failed:", err);
    res.status(500).json({
      error: "internal_error",
      message: "Authentication failed.",
    });
  }
}
