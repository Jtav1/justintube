import { Router } from "express";
import { OriginalUpload } from "../lib/models/index.js";
import { markJobRunComplete, markJobRunFailed } from "../lib/processing-job-runs.js";
import { timingSafeStringEqual } from "../lib/auth/timing-safe-equal.js";
import { logger } from "../lib/logger.js";
import { VIDEO_ID_LENGTH } from "../lib/video-id.js";

/**
 * Recovers the `videoId` a `preview-<videoId>-<uuid>` BullMQ job id was
 * built from. Mirrors `videoIdFromStoryboardJobId` in `internal-storyboard.js`
 * - the trailing UUID means this can't just take everything after the
 * prefix, so it takes exactly `VIDEO_ID_LENGTH` characters instead.
 *
 * @private
 * @param {string} jobId Raw `:jobId` route param.
 * @returns {string} The video id, or an empty string when the prefix doesn't match.
 */
function videoIdFromPreviewJobId(jobId) {
  return jobId.startsWith("preview-")
    ? jobId.slice("preview-".length, "preview-".length + VIDEO_ID_LENGTH)
    : "";
}

/**
 * Express middleware that requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 * Duplicated from `internal-storyboard.js` rather than shared, matching that
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
 * Builds the router for processing → API hover-preview clip packaging
 * callbacks (a short, muted, looping clip shown on a video grid card on
 * hover - see `buildPreviewClipFfmpegArgs`, processing).
 *
 * @returns {import('express').Router} Router mounted at `/internal`.
 */
export function createInternalPreviewRouter() {
  const router = Router();
  router.use(requireInternalToken);

  /**
   * Marks an upload's preview-clip job complete, recording the generated
   * clip's storage path and dimensions so `GET /videos/:id/preview-clip`
   * and the video detail/list responses can serve/advertise it.
   * POST /internal/preview/:jobId/complete with { storagePath, videoWidth?, videoHeight? }.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/preview/{jobId}/complete:
   *   post:
   *     tags: [Internal]
   *     summary: Mark an upload's hover-preview clip packaging job complete
   *     operationId: previewClipComplete
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *         description: >
   *           The preview clip job's id, `preview-<videoId>-<uuid>` (the
   *           upload's public videoId is embedded as a fixed-width prefix,
   *           not the whole value).
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [storagePath]
   *             properties:
   *               storagePath: { type: string }
   *               videoWidth: { type: integer, nullable: true }
   *               videoHeight: { type: integer, nullable: true }
   *     responses:
   *       200:
   *         description: Preview clip path recorded
   *       400:
   *         description: Missing/malformed jobId or storagePath
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `jobId` param + `{ storagePath, videoWidth?, videoHeight? }` body.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success, videoId, status }`, 400, 404, or error.
   */
  router.post("/preview/:jobId/complete", async (req, res) => {
    const jobId = String(req.params.jobId || "").trim();
    const videoId = videoIdFromPreviewJobId(jobId);
    if (!videoId) {
      res.status(400).json({
        success: false,
        error: "missing_uuid",
        message: "jobId must be of the form preview-<videoId>-<uuid>.",
      });
      return;
    }

    const storagePath =
      req.body && typeof req.body.storagePath === "string" ? req.body.storagePath.trim() : "";
    if (!storagePath) {
      res.status(400).json({
        success: false,
        error: "invalid_body",
        message: "storagePath is required.",
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

    await upload.update({
      previewClipStoragePath: storagePath,
      previewClipWidth: typeof req.body.videoWidth === "number" ? req.body.videoWidth : null,
      previewClipHeight: typeof req.body.videoHeight === "number" ? req.body.videoHeight : null,
    });
    await markJobRunComplete(jobId);

    res.status(200).json({
      success: true,
      videoId: upload.videoId,
      status: "complete",
    });
  });

  /**
   * Records a failed preview-clip packaging attempt. Purely informational -
   * `previewClipStoragePath` simply stays unset, so the card just has no
   * hover-preview clip, exactly as before this feature existed.
   * POST /internal/preview/:jobId/fail with { error? }.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/preview/{jobId}/fail:
   *   post:
   *     tags: [Internal]
   *     summary: Record a failed hover-preview clip packaging attempt
   *     operationId: previewClipFailed
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *         description: >
   *           The preview clip job's id, `preview-<videoId>-<uuid>`.
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
  router.post("/preview/:jobId/fail", async (req, res) => {
    const jobId = String(req.params.jobId || "").trim();
    const videoId = videoIdFromPreviewJobId(jobId);
    if (!videoId) {
      res.status(400).json({
        success: false,
        error: "missing_uuid",
        message: "jobId must be of the form preview-<videoId>-<uuid>.",
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
      req.body && typeof req.body.error === "string" ? req.body.error : "preview clip packaging failed";
    logger.error({ message }, `[preview] packaging failed for upload ${upload.videoId}`);
    await markJobRunFailed(jobId, message);

    res.status(200).json({ success: true, videoId: upload.videoId });
  });

  return router;
}
