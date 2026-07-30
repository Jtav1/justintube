import { Router } from "express";
import { OriginalUpload, VideoThumbnail } from "../lib/models/index.js";
import { syncVideoIndex } from "../lib/search.js";

/**
 * Express middleware that requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 * Duplicated from `internal-file-versions.js` rather than shared, matching
 * that file's existing precedent of one small self-contained internal router
 * per caller (see also `internal-livestreams.js`).
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
  if (!provided || provided !== expected) {
    res.status(401).json({
      error: "unauthorized",
      message: "Valid internal service token required.",
    });
    return;
  }

  next();
}

/**
 * Builds the router for processing → API thumbnail-generation callbacks.
 *
 * @returns {import('express').Router} Router mounted at `/internal`.
 */
export function createInternalThumbnailsRouter() {
  const router = Router();
  router.use(requireInternalToken);

  /**
   * Marks a video's auto-generated thumbnail complete, creating (or
   * updating, on re-run) the VIDEO_THUMBNAIL row. Unlike file-version
   * renditions, a thumbnail has no pending placeholder row beforehand — the
   * row is created here, on first success.
   * POST /internal/thumbnails/:uploadUuid/complete with { thumbnailFilename }.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/thumbnails/{uploadUuid}/complete:
   *   post:
   *     tags: [Internal]
   *     summary: Mark a video's thumbnail generation complete
   *     operationId: thumbnailComplete
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: uploadUuid
   *         in: path
   *         required: true
   *         schema: { type: string }
   *         description: The upload's public videoId.
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [thumbnailFilename]
   *             properties:
   *               thumbnailFilename: { type: string }
   *     responses:
   *       200:
   *         description: Thumbnail recorded
   *       400:
   *         description: Missing uploadUuid or thumbnailFilename
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `uploadUuid` param + `{ thumbnailFilename }` body.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success, videoId, status }`, 400, 404, or error.
   */
  router.post("/thumbnails/:uploadUuid/complete", async (req, res) => {
    const uploadUuid = String(req.params.uploadUuid || "").trim();
    if (!uploadUuid) {
      res.status(400).json({
        success: false,
        error: "missing_uuid",
        message: "uploadUuid is required.",
      });
      return;
    }

    const thumbnailFilename =
      req.body && typeof req.body.thumbnailFilename === "string"
        ? req.body.thumbnailFilename.trim()
        : "";
    if (!thumbnailFilename) {
      res.status(400).json({
        success: false,
        error: "invalid_body",
        message: "thumbnailFilename is required.",
      });
      return;
    }

    const upload = await OriginalUpload.findOne({ where: { videoId: uploadUuid } });
    if (!upload) {
      res.status(404).json({
        success: false,
        error: "not_found",
        message: "Upload not found.",
      });
      return;
    }

    const [thumbnail, created] = await VideoThumbnail.findOrCreate({
      where: { originalUploadId: upload.id },
      defaults: { thumbnailFilename },
    });
    if (!created && thumbnail.thumbnailFilename !== thumbnailFilename) {
      await thumbnail.update({ thumbnailFilename });
    }

    syncVideoIndex(upload.id);

    res.status(200).json({
      success: true,
      videoId: upload.videoId,
      status: "complete",
    });
  });

  return router;
}
