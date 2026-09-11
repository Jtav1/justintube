import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { subtitlesDir } from "./videos.js";
import { OriginalUpload, VideoSubtitle } from "../lib/models/index.js";
import { timingSafeStringEqual } from "../lib/auth/timing-safe-equal.js";
import { logger } from "../lib/logger.js";
import { VIDEO_ID_LENGTH } from "../lib/video-id.js";

/**
 * Express middleware that requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 * Duplicated from `internal-thumbnails.js` rather than shared, matching that
 * file's existing precedent of one small self-contained internal router per
 * caller (see also `internal-original-uploads.js`).
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
 * Recovers the `videoId` a `subtitle-<videoId>-<uuid>` BullMQ job id was
 * built from. Mirrors `videoIdFromThumbnailJobId` in `internal-thumbnails.js`
 * — the trailing UUID (appended so a "regenerate captions" call gets a fresh
 * jobId instead of silently no-opping against the first, already-completed
 * job with the same id) means this can't just take everything after the
 * prefix, so it takes exactly `VIDEO_ID_LENGTH` characters instead.
 *
 * @private
 * @param {string} jobId Raw `:jobId` route param.
 * @returns {string} The video id, or an empty string when the prefix doesn't match.
 */
function videoIdFromSubtitleJobId(jobId) {
  return jobId.startsWith("subtitle-")
    ? jobId.slice("subtitle-".length, "subtitle-".length + VIDEO_ID_LENGTH)
    : "";
}

/**
 * Builds the router for processing → API subtitle-extraction callbacks.
 *
 * @returns {import('express').Router} Router mounted at `/internal`.
 */
export function createInternalSubtitlesRouter() {
  const router = Router();
  router.use(requireInternalToken);

  /**
   * Marks a video's subtitle extraction complete, replacing the full set of
   * `source: "auto"` VIDEO_SUBTITLE rows with whatever text streams
   * processing found this run (possibly none, possibly several — one per
   * embedded language/track). This handler serves both first-time
   * auto-extraction (no prior auto rows to delete) and a "regenerate
   * captions" re-run (`POST /videos/:id/subtitles/regenerate`) — it never
   * touches `source: "user"` rows, which are a caller's own uploads and
   * independent of auto-extraction.
   *
   * Skipped entirely (still 200, but no rows written) when
   * `upload.skipAutoSubtitles` is set — a user-provided subtitle always wins
   * and, once set, no further auto-extraction may overwrite the auto set
   * unless the user explicitly requests a regeneration (which clears the
   * flag first).
   * POST /internal/subtitles/:jobId/complete with { subtitles: [{ outputFilename, language?, title? }] }.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/subtitles/{jobId}/complete:
   *   post:
   *     tags: [Internal]
   *     summary: Mark a video's subtitle extraction complete
   *     operationId: subtitleComplete
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *         description: >
   *           The subtitle job's id, `subtitle-<videoId>-<uuid>` (the
   *           upload's public videoId is embedded as a fixed-width prefix,
   *           not the whole value).
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [subtitles]
   *             properties:
   *               subtitles:
   *                 type: array
   *                 description: One entry per extracted text stream (may be empty).
   *                 items:
   *                   type: object
   *                   required: [outputFilename]
   *                   properties:
   *                     outputFilename: { type: string }
   *                     language: { type: string }
   *                     title: { type: string }
   *     responses:
   *       200:
   *         description: Subtitles recorded
   *       400:
   *         description: Missing/malformed jobId or subtitles
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `jobId` param + `{ subtitles }` body.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success, videoId, status }`, 400, 404, or error.
   */
  router.post("/subtitles/:jobId/complete", async (req, res) => {
    const videoId = videoIdFromSubtitleJobId(String(req.params.jobId || "").trim());
    if (!videoId) {
      res.status(400).json({
        success: false,
        error: "missing_uuid",
        message: "jobId must be of the form subtitle-<videoId>-<uuid>.",
      });
      return;
    }

    const subtitles = Array.isArray(req.body?.subtitles) ? req.body.subtitles : null;
    if (!subtitles) {
      res.status(400).json({
        success: false,
        error: "invalid_body",
        message: "subtitles (array) is required.",
      });
      return;
    }
    const entries = subtitles.map((entry) => ({
      outputFilename:
        entry && typeof entry.outputFilename === "string" ? entry.outputFilename.trim() : "",
      language: entry && typeof entry.language === "string" ? entry.language.trim() : "",
      title: entry && typeof entry.title === "string" ? entry.title.trim() : "",
    }));
    if (entries.some((entry) => !entry.outputFilename)) {
      res.status(400).json({
        success: false,
        error: "invalid_body",
        message: "Every subtitles entry requires an outputFilename.",
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

    if (upload.skipAutoSubtitles) {
      res.status(200).json({
        success: true,
        videoId: upload.videoId,
        status: "skipped_user_provided",
      });
      return;
    }

    const staleAuto = await VideoSubtitle.findAll({
      where: { originalUploadId: upload.id, source: "auto" },
    });
    await VideoSubtitle.destroy({ where: { originalUploadId: upload.id, source: "auto" } });
    await Promise.all(
      staleAuto.map((row) => unlink(join(subtitlesDir, row.subtitleFilename)).catch(() => {})),
    );

    if (entries.length > 0) {
      await VideoSubtitle.bulkCreate(
        entries.map((entry, index) => ({
          originalUploadId: upload.id,
          subtitleFilename: entry.outputFilename,
          source: "auto",
          label: entry.title || entry.language || `Subtitle ${index + 1}`,
        })),
      );
    }

    res.status(200).json({
      success: true,
      videoId: upload.videoId,
      status: entries.length > 0 ? "complete" : "no_subtitle_streams",
    });
  });

  /**
   * Records a failed (or gracefully-skipped, e.g. no text-based subtitle
   * stream present) subtitle-extraction attempt. Unlike thumbnails, there is
   * no placeholder fallback — subtitles are optional, so this is a pure
   * no-op beyond logging: whatever `VideoSubtitle` row already existed (a
   * prior auto-extraction, or a user upload) is left completely untouched.
   * This is what makes "regenerate captions" safe to call speculatively:
   * a regeneration that finds nothing never destroys a working subtitle.
   * POST /internal/subtitles/:jobId/failed with { error? }.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/subtitles/{jobId}/failed:
   *   post:
   *     tags: [Internal]
   *     summary: Record a failed or skipped subtitle-extraction attempt
   *     operationId: subtitleFailed
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *         description: >
   *           The subtitle job's id, `subtitle-<videoId>-<uuid>`.
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
  router.post("/subtitles/:jobId/failed", async (req, res) => {
    const videoId = videoIdFromSubtitleJobId(String(req.params.jobId || "").trim());
    if (!videoId) {
      res.status(400).json({
        success: false,
        error: "missing_uuid",
        message: "jobId must be of the form subtitle-<videoId>-<uuid>.",
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
      req.body && typeof req.body.error === "string" ? req.body.error : "subtitle extraction failed";
    logger.error({ message }, `[subtitles] auto-extraction failed for upload ${upload.videoId}`);

    res.status(200).json({ success: true, videoId: upload.videoId });
  });

  return router;
}
