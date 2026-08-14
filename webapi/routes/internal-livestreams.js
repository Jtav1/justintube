import { Router } from "express";
import { hashStreamKey } from "../lib/auth/stream-key.js";
import { timingSafeStringEqual } from "../lib/auth/timing-safe-equal.js";
import { Livestream, StreamKey } from "../lib/models/index.js";
import { logger } from "../lib/logger.js";

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
 * Parses a route `:id` param as a positive integer primary key.
 *
 * @private
 * @param {unknown} raw Route parameter value.
 * @returns {number|null} Parsed id, or null when invalid.
 */
function parsePositiveInt(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return null;
  }
  return n;
}

/**
 * Looks up a raw stream key, rejecting missing/revoked keys, and
 * find-or-creates the owner's LIVESTREAMS row, touching `lastUsedAt`.
 * Shared by the Bearer-gated `authorize` route and the query-token-gated
 * `mediamtx-auth` route so both stay consistent with a single lookup path.
 *
 * @private
 * @param {string} rawKey Raw stream key as presented by the publisher.
 * @returns {Promise<{keyRow: object, livestream: object}|null>}
 *   The matched STREAM_KEYS row and its LIVESTREAMS row, or null when the key is invalid/revoked.
 */
async function resolveAndTouchStreamKey(rawKey) {
  const keyRow = await StreamKey.findOne({
    where: { keyHash: hashStreamKey(rawKey) },
  });
  if (!keyRow || keyRow.revokedAt) {
    return null;
  }

  const [livestream] = await Livestream.findOrCreate({
    where: { userId: keyRow.userId },
    defaults: { userId: keyRow.userId },
  });
  await keyRow.update({ lastUsedAt: new Date() });

  return { keyRow, livestream };
}

/**
 * Builds the router for RTMP ingest server → API livestream lifecycle
 * callbacks.
 *
 * @returns {import('express').Router} Router mounted at `/internal`.
 */
export function createInternalLivestreamsRouter() {
  const router = Router();

  /**
   * POST /internal/livestreams/authorize — livestreamAuthorize
   * Called by the RTMP ingest server's on-publish webhook with the presented
   * stream key. Validates the key against STREAM_KEYS and find-or-creates the
   * LIVESTREAMS row for that user; the row stays `offline` until `/start` is
   * called separately once the ingest server confirms the publish succeeded.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN.
   */
  router.post("/livestreams/authorize", requireInternalToken, async (req, res) => {
    try {
      const streamKey = String(req.body?.streamKey || "");
      if (!streamKey) {
        res.status(400).json({
          error: "invalid_body",
          message: "streamKey is required.",
        });
        return;
      }

      const resolved = await resolveAndTouchStreamKey(streamKey);
      if (!resolved) {
        res.status(403).json({
          error: "forbidden",
          message: "Invalid or revoked stream key.",
        });
        return;
      }

      res.status(200).json({ livestreamId: resolved.livestream.id, userId: resolved.keyRow.userId });
    } catch (err) {
      logger.error({ err }, "livestreamAuthorize failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to authorize stream.",
      });
    }
  });

  /**
   * POST /internal/livestreams/mediamtx-auth — livestreamMediamtxAuth
   * Called by MediaMTX's `authHTTPAddress` webhook on every publish attempt.
   * MediaMTX can't send an `Authorization` header on this call, so it's gated
   * by a token in the query string instead of `requireInternalToken`. Body is
   * MediaMTX's fixed shape: `{ action, path, ... }`. OBS concatenates its
   * "Server" and "Stream Key" fields into one publish path, so the raw stream
   * key itself *is* the path segment (`live/{rawKey}`) - there's no separate
   * userId to cross-check, since possession of a valid, unrevoked key is
   * itself the identity check. Response body is ignored by MediaMTX - only
   * the status code matters.
   */
  router.post("/livestreams/mediamtx-auth", async (req, res) => {
    try {
      const expected = process.env.INTERNAL_SERVICE_TOKEN || "";
      const provided = String(req.query?.token || "");
      if (!expected || !timingSafeStringEqual(expected, provided)) {
        res.status(401).end();
        return;
      }

      if (req.body?.action !== "publish") {
        res.status(403).end();
        return;
      }

      const pathMatch = /^live\/(.+)$/.exec(String(req.body?.path || ""));
      const rawKey = pathMatch ? pathMatch[1] : "";
      if (!rawKey) {
        res.status(403).end();
        return;
      }

      const resolved = await resolveAndTouchStreamKey(rawKey);
      if (!resolved) {
        res.status(403).end();
        return;
      }

      res.status(200).end();
    } catch (err) {
      logger.error({ err }, "livestreamMediamtxAuth failed");
      res.status(500).end();
    }
  });

  /**
   * POST /internal/livestreams/:id/start — livestreamStart
   * Flips a livestream to `live` and records `startedAt`.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN.
   */
  router.post("/livestreams/:id/start", requireInternalToken, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const row = await Livestream.findByPk(id);
      if (!row) {
        res.status(404).json({ error: "not_found", message: "Livestream not found." });
        return;
      }

      await row.update({ status: "live", startedAt: new Date() });
      res.status(200).json({ id: row.id, status: row.status, startedAt: row.startedAt });
    } catch (err) {
      logger.error({ err }, "livestreamStart failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to start livestream.",
      });
    }
  });

  /**
   * POST /internal/livestreams/:id/stop — livestreamStop
   * Flips a livestream to `offline` and resets its viewer count.
   * TODO(livestreaming VOD): once the processing service can accept a
   * recording handoff, this is where it would be triggered - see the
   * "Livestreaming (FUTURE)" note in docs/api-checklist.md. Not built yet;
   * out of scope until that pipeline exists.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN.
   */
  router.post("/livestreams/:id/stop", requireInternalToken, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const row = await Livestream.findByPk(id);
      if (!row) {
        res.status(404).json({ error: "not_found", message: "Livestream not found." });
        return;
      }

      await row.update({ status: "offline", viewerCount: 0 });
      res.status(200).json({ id: row.id, status: row.status });
    } catch (err) {
      logger.error({ err }, "livestreamStop failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to stop livestream.",
      });
    }
  });

  return router;
}
