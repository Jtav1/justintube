import { Router } from "express";
import { generateStreamKey, maskStreamKeyPrefix } from "../lib/auth/stream-key.js";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { requireUploader } from "../lib/auth/require-uploader.js";
import { Livestream, StreamKey } from "../lib/models/index.js";

/**
 * Maps a StreamKey row to the public JSON shape. Never includes `keyHash` or
 * the plaintext key.
 *
 * @param {import('sequelize').Model} row StreamKey instance.
 * @returns {{
 *   keyDisplay: string,
 *   ingestUrl: string|null,
 *   createdAt: Date,
 *   lastUsedAt: Date|null,
 *   revokedAt: Date|null
 * }} Public stream key payload.
 */
function serializeStreamKey(row) {
  return {
    keyDisplay: maskStreamKeyPrefix(row.keyPrefix),
    // Same ingest URL for every user - OBS concatenates Server + "/" +
    // Stream Key itself, so the raw key (pasted into OBS's separate "Stream
    // Key" field) is what makes the resulting publish path unique per user.
    ingestUrl: process.env.RTMP_INGEST_URL || null,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt ?? null,
    revokedAt: row.revokedAt ?? null,
  };
}

/**
 * Builds the Me stream-key router (mounted under `/api/v1`), for issuing and
 * managing the RTMP credential OBS (or any RTMP encoder) uses to publish to
 * the livestream ingest server.
 *
 * @returns {import('express').Router} Configured stream-key router.
 */
export function createMeStreamKeyRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Returns the authenticated user's stream key metadata (masked - never the
   * raw key).
   * GET /api/v1/me/stream-key
   * Auth: session cookie or Bearer API key; uploader status + verified email required.
   *
   * @openapi
   * /api/v1/me/stream-key:
   *   get:
   *     tags: [Me]
   *     summary: Get my stream key
   *     operationId: getMyStreamKey
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Masked stream key metadata
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Uploader access and a verified email are required
   *       404:
   *         description: No stream key has been generated yet
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends masked key metadata or an error response.
   */
  router.get("/me/stream-key", requireAuth, requireUploader, async (req, res) => {
    try {
      const row = await StreamKey.findOne({ where: { userId: req.user.id } });
      if (!row) {
        res.status(404).json({
          error: "not_found",
          message: "No stream key has been generated yet.",
        });
        return;
      }
      res.json(serializeStreamKey(row));
    } catch (err) {
      console.error("getMyStreamKey failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to fetch stream key.",
      });
    }
  });

  /**
   * Generates a fresh stream key for the authenticated user, invalidating any
   * previous one. Also used to create the first key (STREAM_KEYS.userId is
   * unique, so this is a find-or-create-then-replace). Also find-or-creates
   * the user's LIVESTREAMS "channel" row so the Go Live page can configure
   * title/description/visibility immediately, without waiting for an ingest
   * server (not deployed yet) to call `/internal/livestreams/authorize` on a
   * first publish. The plaintext `key` is returned only in this response.
   * POST /api/v1/me/stream-key/rotate
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions;
   * uploader status + verified email required.
   *
   * @openapi
   * /api/v1/me/stream-key/rotate:
   *   post:
   *     tags: [Me]
   *     summary: Rotate (or create) my stream key
   *     operationId: rotateMyStreamKey
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: New stream key created; plaintext key returned once
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Uploader access and a verified email are required
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ ...metadata, key }` or an error.
   */
  router.post(
    "/me/stream-key/rotate",
    requireAuth,
    requireUploader,
    async (req, res) => {
      try {
        const { rawKey, keyHash, keyPrefix } = generateStreamKey();
        const [row] = await StreamKey.findOrCreate({
          where: { userId: req.user.id },
          defaults: { userId: req.user.id, keyHash, keyPrefix },
        });
        await row.update({ keyHash, keyPrefix, revokedAt: null, lastUsedAt: null });
        // findOrCreate's in-memory instance doesn't reliably hydrate
        // createdAt's real timestamp (it can surface the raw
        // CURRENT_TIMESTAMP SQL literal instead) - reload from the DB so the
        // response reflects what a subsequent GET would return.
        await row.reload();

        const [livestream] = await Livestream.findOrCreate({
          where: { userId: req.user.id },
          defaults: { userId: req.user.id },
        });

        res.status(200).json({
          ...serializeStreamKey(row),
          livestreamId: livestream.id,
          key: rawKey,
        });
      } catch (err) {
        console.error("rotateMyStreamKey failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to rotate stream key.",
        });
      }
    },
  );

  /**
   * Soft-revokes the authenticated user's stream key.
   * DELETE /api/v1/me/stream-key
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions;
   * uploader status + verified email required.
   *
   * @openapi
   * /api/v1/me/stream-key:
   *   delete:
   *     tags: [Me]
   *     summary: Revoke my stream key
   *     operationId: revokeMyStreamKey
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Key revoked (or already revoked, or none existed)
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Uploader access and a verified email are required
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }` or an error response.
   */
  router.delete(
    "/me/stream-key",
    requireAuth,
    requireUploader,
    async (req, res) => {
      try {
        const row = await StreamKey.findOne({ where: { userId: req.user.id } });
        if (row && !row.revokedAt) {
          await row.update({ revokedAt: new Date() });
        }
        res.status(200).json({ success: true });
      } catch (err) {
        console.error("revokeMyStreamKey failed:", err);
        res.status(500).json({
          success: false,
          error: "internal_error",
          message: "Failed to revoke stream key.",
        });
      }
    },
  );

  return router;
}
