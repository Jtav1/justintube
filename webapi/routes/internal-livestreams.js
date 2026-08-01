import { Router } from "express";
import { notImplemented } from "./stubs.js";
import { timingSafeStringEqual } from "../lib/auth/timing-safe-equal.js";

/**
 * Express middleware that requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 * Duplicated from `internal-file-versions.js` rather than shared, matching that
 * file's existing precedent of one small self-contained internal router per caller.
 *
 * @private
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when authorized.
 * @returns {void} Sends 401/503 when the token is missing, mismatched, or unconfigured.
 */
function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_TOKEN || "";
  if (!expected) {
    res.status(503).json({
      error: "internal_auth_unconfigured",
      message: "INTERNAL_SERVICE_TOKEN is not configured.",
    });
    return;
  }

  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match ? match[1].trim() : "";
  if (!timingSafeStringEqual(expected, provided)) {
    res.status(401).json({
      error: "unauthorized",
      message: "Valid internal service token required.",
    });
    return;
  }

  next();
}

/**
 * Builds the (stub) router for RTMP ingest server → API livestream lifecycle
 * callbacks. Every operation currently responds 501; this only reserves the
 * shape (path + auth + operationId) ahead of the ingest server existing.
 *
 * @returns {import('express').Router} Router mounted at `/internal`.
 */
export function createInternalLivestreamsRouter() {
  const router = Router();
  router.use(requireInternalToken);

  /**
   * POST /internal/livestreams/authorize — livestreamAuthorize
   * Called by the RTMP ingest server's on-publish webhook with the presented
   * stream key. Not implemented: will validate the key against STREAM_KEYS,
   * find-or-create the LIVESTREAMS row for that user, and accept/reject the
   * publish attempt.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   */
  router.post("/livestreams/authorize", notImplemented("livestreamAuthorize"));

  /**
   * POST /internal/livestreams/:id/start — livestreamStart
   * Not implemented: will flip a livestream to `live` and record `startedAt`.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   */
  router.post("/livestreams/:id/start", notImplemented("livestreamStart"));

  /**
   * POST /internal/livestreams/:id/stop — livestreamStop
   * Not implemented: will flip a livestream to `offline` and, optionally,
   * hand the recording off to the processing service to become a VOD.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   */
  router.post("/livestreams/:id/stop", notImplemented("livestreamStop"));

  return router;
}
