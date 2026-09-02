import { Router } from "express";
import { DEFAULT_AUDIO_THUMBNAIL_FILENAME } from "../lib/media-meta.js";
import { OriginalUpload, VideoThumbnail } from "../lib/models/index.js";
import { syncVideoIndex } from "../lib/search.js";
import { timingSafeStringEqual } from "../lib/auth/timing-safe-equal.js";
import { logger } from "../lib/logger.js";
import { VIDEO_ID_LENGTH } from "../lib/video-id.js";
import { enqueueAudioEmbedVideo } from "./uploads.js";

/**
 * Recovers the `videoId` a `thumbnail-<videoId>-<uuid>` BullMQ job id was
 * built from. Mirrors `videoIdFromEmbedJobId` in `internal-original-uploads.js`
 * — the trailing UUID (appended so a regenerated thumbnail gets a fresh
 * jobId instead of silently no-opping against the first, already-completed
 * job with the same id) means this can't just take everything after the
 * prefix, so it takes exactly `VIDEO_ID_LENGTH` characters instead.
 *
 * @private
 * @param {string} jobId Raw `:uploadUuid` route param (actually the full jobId).
 * @returns {string} The video id, or an empty string when the prefix doesn't match.
 */
function videoIdFromThumbnailJobId(jobId) {
  return jobId.startsWith("thumbnail-")
    ? jobId.slice("thumbnail-".length, "thumbnail-".length + VIDEO_ID_LENGTH)
    : "";
}

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
   *
   * Skipped entirely (still 200, but no row written and no embed job fired)
   * when `upload.skipThumbnail` is set — a user-provided thumbnail always
   * wins and, once set, no further auto-generation may ever overwrite it.
   * The auto-thumbnail job normally isn't even enqueued in that case (see
   * `finalizeUploadTranscodes`), but this guards the race where a user
   * uploads a custom thumbnail while an earlier auto-generation attempt (from
   * before they did so) is still in flight.
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
   *         description: >
   *           The thumbnail job's id, `thumbnail-<videoId>-<uuid>` (the
   *           upload's public videoId is embedded as a fixed-width prefix,
   *           not the whole value).
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
    const videoId = videoIdFromThumbnailJobId(String(req.params.uploadUuid || "").trim());
    if (!videoId) {
      res.status(400).json({
        success: false,
        error: "missing_uuid",
        message: "jobId must be of the form thumbnail-<videoId>-<uuid>.",
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

    const upload = await OriginalUpload.findOne({ where: { videoId } });
    if (!upload) {
      res.status(404).json({
        success: false,
        error: "not_found",
        message: "Upload not found.",
      });
      return;
    }

    if (upload.skipThumbnail) {
      res.status(200).json({
        success: true,
        videoId: upload.videoId,
        status: "skipped_user_provided",
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
    const storedFilename = upload.storagePath.replace(/^original\//, "");
    enqueueAudioEmbedVideo(upload, thumbnailFilename, storedFilename);

    res.status(200).json({
      success: true,
      videoId: upload.videoId,
      status: "complete",
    });
  });

  /**
   * Records a failed auto-thumbnail-generation attempt (see
   * `processThumbnailJob` in processing - tries embedded cover art first,
   * then a timestamped frame grab; a failure here means *neither* found
   * anything, e.g. an audio-only file with no embedded art at all). For an
   * upload with no genuine video stream (`hasVideoStream === false` - not
   * `mediaType`, see `enqueueAudioEmbedVideo`), no thumbnail yet, and no
   * user-provided one (`skipThumbnail`), this is exactly the "we truly have
   * nothing" signal that the priority order (user-provided > embedded art >
   * video-frame grab > placeholder) resolves to the bundled speaker-icon
   * placeholder - enqueues an `"embed"` job for it so link-unfurl embedding
   * still works. Uploads with a real video stream get no fallback here - a
   * failed frame grab just means no thumbnail, same as before this endpoint
   * existed.
   * POST /internal/thumbnails/:uploadUuid/failed with { error? }.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/thumbnails/{uploadUuid}/failed:
   *   post:
   *     tags: [Internal]
   *     summary: Record a failed auto-thumbnail-generation attempt
   *     operationId: thumbnailFailed
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: uploadUuid
   *         in: path
   *         required: true
   *         schema: { type: string }
   *         description: >
   *           The thumbnail job's id, `thumbnail-<videoId>-<uuid>` (the
   *           upload's public videoId is embedded as a fixed-width prefix,
   *           not the whole value).
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               error: { type: string }
   *     responses:
   *       200:
   *         description: Failure recorded (and, for an eligible audio upload, a placeholder embed video was enqueued)
   *       400:
   *         description: Missing uploadUuid
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `uploadUuid` param + optional `{ error }` body.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200, 400, or 404.
   */
  router.post("/thumbnails/:uploadUuid/failed", async (req, res) => {
    const videoId = videoIdFromThumbnailJobId(String(req.params.uploadUuid || "").trim());
    if (!videoId) {
      res.status(400).json({
        success: false,
        error: "missing_uuid",
        message: "jobId must be of the form thumbnail-<videoId>-<uuid>.",
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
      req.body && typeof req.body.error === "string" ? req.body.error : "thumbnail generation failed";
    logger.error({ message }, `[thumbnails] auto-generation failed for upload ${upload.videoId}`);

    const existingThumbnail = await VideoThumbnail.findOne({ where: { originalUploadId: upload.id } });
    const shouldUsePlaceholder =
      upload.hasVideoStream === false && !upload.skipThumbnail && !existingThumbnail;

    if (shouldUsePlaceholder) {
      const storedFilename = upload.storagePath.replace(/^original\//, "");
      enqueueAudioEmbedVideo(upload, DEFAULT_AUDIO_THUMBNAIL_FILENAME, storedFilename, {
        isDefault: true,
      });
    }

    res.status(200).json({ success: true, videoId: upload.videoId });
  });

  return router;
}
