import { Router } from "express";
import { OriginalUpload } from "../lib/models/index.js";
import { markJobRunComplete, markJobRunFailed } from "../lib/processing-job-runs.js";
import { timingSafeStringEqual } from "../lib/auth/timing-safe-equal.js";
import { logger } from "../lib/logger.js";
import { VIDEO_ID_LENGTH } from "../lib/video-id.js";

/**
 * Recovers the `videoId` an `hls-<videoId>-<uuid>` BullMQ job id was built
 * from. Mirrors `videoIdFromThumbnailJobId` in `internal-thumbnails.js` — the
 * trailing UUID means this can't just take everything after the prefix, so
 * it takes exactly `VIDEO_ID_LENGTH` characters instead.
 *
 * @private
 * @param {string} jobId Raw `:jobId` route param.
 * @returns {string} The video id, or an empty string when the prefix doesn't match.
 */
function videoIdFromHlsJobId(jobId) {
  return jobId.startsWith("hls-")
    ? jobId.slice("hls-".length, "hls-".length + VIDEO_ID_LENGTH)
    : "";
}

/**
 * Express middleware that requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 * Duplicated from `internal-thumbnails.js` rather than shared, matching that
 * file's existing precedent of one small self-contained internal router per
 * caller.
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
 * Builds the router for processing → API "Best" (HLS) packaging callbacks.
 *
 * @returns {import('express').Router} Router mounted at `/internal`.
 */
export function createInternalHlsRouter() {
  const router = Router();
  router.use(requireInternalToken);

  /**
   * Marks an upload's "Best" HLS packaging job complete, recording the
   * variant playlist's storage path so `GET /videos/:id/hls/:filename` and
   * the quality list (`GET /videos/:id`) can serve/advertise it.
   * POST /internal/hls/:jobId/complete with { playlistPath, bitRateBps? }.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/hls/{jobId}/complete:
   *   post:
   *     tags: [Internal]
   *     summary: Mark an upload's "Best" HLS packaging job complete
   *     operationId: hlsComplete
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *         description: >
   *           The HLS job's id, `hls-<videoId>-<uuid>` (the upload's public
   *           videoId is embedded as a fixed-width prefix, not the whole value).
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [playlistPath]
   *             properties:
   *               playlistPath: { type: string }
   *               bitRateBps: { type: number, nullable: true }
   *     responses:
   *       200:
   *         description: HLS playlist path recorded
   *       400:
   *         description: Missing/malformed jobId or playlistPath
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `jobId` param + `{ playlistPath, bitRateBps? }` body.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success, videoId, status }`, 400, 404, or error.
   */
  router.post("/hls/:jobId/complete", async (req, res) => {
    const jobId = String(req.params.jobId || "").trim();
    const videoId = videoIdFromHlsJobId(jobId);
    if (!videoId) {
      res.status(400).json({
        success: false,
        error: "missing_uuid",
        message: "jobId must be of the form hls-<videoId>-<uuid>.",
      });
      return;
    }

    const playlistPath =
      req.body && typeof req.body.playlistPath === "string" ? req.body.playlistPath.trim() : "";
    if (!playlistPath) {
      res.status(400).json({
        success: false,
        error: "invalid_body",
        message: "playlistPath is required.",
      });
      return;
    }

    const upload = await OriginalUpload.findOne({ where: { videoId } });
    if (!upload) {
      res.status(404).json({
        success: false,
        error: "not_found",
        message: "Upload not found.",
      });
      return;
    }

    await upload.update({ hlsPlaylistStoragePath: playlistPath });
    await markJobRunComplete(jobId);

    res.status(200).json({
      success: true,
      videoId: upload.videoId,
      status: "complete",
    });
  });

  /**
   * Records a failed "Best" HLS packaging attempt. Purely informational -
   * `hlsPlaylistStoragePath` simply stays unset, so the "Best" quality option
   * never appears for this upload and every other quality keeps working
   * exactly as before this feature existed.
   * POST /internal/hls/:jobId/fail with { error? }.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/hls/{jobId}/fail:
   *   post:
   *     tags: [Internal]
   *     summary: Record a failed "Best" HLS packaging attempt
   *     operationId: hlsFailed
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *         description: >
   *           The HLS job's id, `hls-<videoId>-<uuid>`.
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               error: { type: string }
   *     responses:
   *       200:
   *         description: Failure recorded (no other action taken)
   *       400:
   *         description: Missing/malformed jobId
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `jobId` param + optional `{ error }` body.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200, 400, or 404.
   */
  router.post("/hls/:jobId/fail", async (req, res) => {
    const jobId = String(req.params.jobId || "").trim();
    const videoId = videoIdFromHlsJobId(jobId);
    if (!videoId) {
      res.status(400).json({
        success: false,
        error: "missing_uuid",
        message: "jobId must be of the form hls-<videoId>-<uuid>.",
      });
      return;
    }

    const upload = await OriginalUpload.findOne({ where: { videoId } });
    if (!upload) {
      res.status(404).json({
        success: false,
        error: "not_found",
        message: "Upload not found.",
      });
      return;
    }

    const message =
      req.body && typeof req.body.error === "string" ? req.body.error : "hls packaging failed";
    logger.error({ message }, `[hls] packaging failed for upload ${upload.videoId}`);
    await markJobRunFailed(jobId, message);

    res.status(200).json({ success: true, videoId: upload.videoId });
  });

  return router;
}
