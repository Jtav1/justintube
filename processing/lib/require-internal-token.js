import { timingSafeStringEqual } from "./timing-safe-equal.js";

/**
 * Express middleware that requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 * This service is meant to be reachable only from `webapi` over the private
 * Docker network; this is a defense-in-depth check for the case where that
 * network boundary doesn't hold (e.g. the port is inadvertently published).
 * Mirrors `webapi/routes/internal-file-versions.js`'s equivalent check, using
 * the same shared secret both services already carry for the reverse
 * direction (processing's completion/failure callbacks into webapi).
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when authorized.
 * @returns {void} Sends 401/503 when the token is missing, mismatched, or unconfigured.
 */
export function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_TOKEN || "";
  if (!expected) {
    res.status(503).json({
      success: false,
      error: "internal_auth_unconfigured",
    });
    return;
  }

  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match ? match[1].trim() : "";
  if (!timingSafeStringEqual(expected, provided)) {
    res.status(401).json({
      success: false,
      error: "unauthorized",
    });
    return;
  }

  next();
}
