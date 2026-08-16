import { unlink } from "node:fs/promises";
import { Router } from "express";
import { Op } from "sequelize";
import { timingSafeStringEqual } from "../lib/auth/timing-safe-equal.js";
import { buildPublicLink } from "../lib/email/mailer.js";
import { resolveMediaPath } from "../lib/media-meta.js";
import {
  DuplicateUploadFlag,
  OriginalUpload,
  Role,
  User,
} from "../lib/models/index.js";
import { createNotification } from "../lib/notifications.js";
import { logger } from "../lib/logger.js";
import { enqueueDuplicateHashCheck, finalizeUploadTranscodes } from "./uploads.js";

/**
 * Express middleware that requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
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
 * Recovers the `videoId` a `hash-<videoId>` BullMQ job id was built from.
 *
 * @private
 * @param {string} jobId Raw `:jobId` route param.
 * @returns {string} The video id, or an empty string when the prefix doesn't match.
 */
function videoIdFromHashJobId(jobId) {
  return jobId.startsWith("hash-") ? jobId.slice("hash-".length) : "";
}

/**
 * Recovers the `videoId` a `normalize-<videoId>` BullMQ job id was built from.
 *
 * @private
 * @param {string} jobId Raw `:jobId` route param.
 * @returns {string} The video id, or an empty string when the prefix doesn't match.
 */
function videoIdFromNormalizeJobId(jobId) {
  return jobId.startsWith("normalize-") ? jobId.slice("normalize-".length) : "";
}

/**
 * Notifies every admin/moderator that a possible duplicate upload needs
 * review, linking to both the new upload and the existing match. The
 * in-app message embeds `[label](/video?v=...)` markdown-style links -
 * `NotificationItem` (webview) renders those as clickable in-app links
 * rather than literal text. Mirrors `notifyReportCreated` in
 * `webapi/routes/reports.js`. Never throws - `createNotification` swallows
 * its own delivery failures.
 *
 * @private
 * @param {import('sequelize').Model} flag Newly created DuplicateUploadFlag row.
 * @param {import('sequelize').Model} newUpload The new (possibly duplicate) upload.
 * @param {import('sequelize').Model} existingUpload The matched existing upload.
 * @returns {Promise<void>} Resolves once delivery has been attempted.
 */
async function notifyDuplicateUploadFlagged(flag, newUpload, existingUpload) {
  const moderators = await User.findAll({
    attributes: ["id"],
    include: [{ model: Role, where: { name: ["admin", "moderator"] }, attributes: [] }],
  });

  const newVideoPath = `/video?v=${encodeURIComponent(newUpload.videoId)}`;
  const existingVideoPath = `/video?v=${encodeURIComponent(existingUpload.videoId)}`;

  await Promise.all(
    moderators.map((moderator) =>
      createNotification({
        recipientUserId: moderator.id,
        typeName: "duplicate_upload",
        title: "Possible duplicate upload flagged",
        message:
          `A new upload may duplicate an existing video and is pending review. ` +
          `[New upload](${newVideoPath}) — [Existing video](${existingVideoPath})`,
        target: String(flag.id),
        link: buildPublicLink(newVideoPath),
      }),
    ),
  );
}

/**
 * Builds the router for processing → API `ORIGINAL_UPLOADS`-scoped
 * callbacks: duplicate-upload content-hash results and
 * FILETYPES_CONVERTIBLE normalize job results.
 *
 * @returns {import('express').Router} Router mounted at `/internal`.
 */
export function createInternalOriginalUploadsRouter() {
  const router = Router();
  router.use(requireInternalToken);

  /**
   * Records a computed content hash for an already-live upload and, when it
   * matches another upload's hash, creates a `DuplicateUploadFlag` and
   * notifies admins/moderators for manual review. This never touches the
   * upload's own status or transcode pipeline — hashing runs purely in the
   * background after the upload has already been finalized for the user;
   * the only visible side effect of a match is the notification.
   * POST /internal/original-uploads/:jobId/hash-complete with { contentHash }.
   * `:jobId` is `hash-<videoId>`. Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/original-uploads/{jobId}/hash-complete:
   *   post:
   *     tags: [Internal]
   *     summary: Record a completed duplicate-upload content hash
   *     operationId: originalUploadHashComplete
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [contentHash]
   *             properties:
   *               contentHash: { type: string }
   *     responses:
   *       200:
   *         description: Hash recorded; a review flag was created when it matched another upload
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `jobId` param + `{ contentHash }` body.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200, 400, or 404.
   */
  router.post("/original-uploads/:jobId/hash-complete", async (req, res) => {
    const videoId = videoIdFromHashJobId(String(req.params.jobId || "").trim());
    if (!videoId) {
      res.status(400).json({
        error: "invalid_job_id",
        message: "jobId must be of the form hash-<videoId>.",
      });
      return;
    }

    const contentHash =
      req.body && typeof req.body.contentHash === "string" ? req.body.contentHash.trim() : "";
    if (!contentHash) {
      res.status(400).json({
        error: "missing_content_hash",
        message: "contentHash is required.",
      });
      return;
    }

    const upload = await OriginalUpload.findOne({ where: { videoId } });
    if (!upload) {
      res.status(404).json({
        error: "not_found",
        message: "Upload not found.",
      });
      return;
    }

    await upload.update({ contentHash });

    const existing = await OriginalUpload.findOne({
      where: {
        contentHash,
        id: { [Op.ne]: upload.id },
        status: { [Op.notIn]: ["failed", "downloading"] },
      },
      order: [["uploadedAt", "ASC"]],
    });

    if (!existing) {
      res.status(200).json({ success: true, status: "no_duplicate" });
      return;
    }

    const flag = await DuplicateUploadFlag.create({
      newOriginalUploadId: upload.id,
      existingOriginalUploadId: existing.id,
      contentHash,
      status: "pending",
    });
    await notifyDuplicateUploadFlagged(flag, upload, existing);

    res.status(200).json({ success: true, status: "duplicate_flagged", flagId: flag.id });
  });

  /**
   * Logs a failed duplicate-upload content-hash job. Purely informational —
   * the upload was never blocked on this job in the first place (hashing
   * runs entirely in the background after the upload is already live), so
   * there's nothing to release or roll back.
   * POST /internal/original-uploads/:jobId/hash-failed with { error? }.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/original-uploads/{jobId}/hash-failed:
   *   post:
   *     tags: [Internal]
   *     summary: Record a failed duplicate-upload content-hash job
   *     operationId: originalUploadHashFailed
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               error: { type: string }
   *     responses:
   *       200:
   *         description: Failure logged
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `jobId` param + optional `error` string.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200, 400, or 404.
   */
  router.post("/original-uploads/:jobId/hash-failed", async (req, res) => {
    const videoId = videoIdFromHashJobId(String(req.params.jobId || "").trim());
    if (!videoId) {
      res.status(400).json({
        error: "invalid_job_id",
        message: "jobId must be of the form hash-<videoId>.",
      });
      return;
    }

    const upload = await OriginalUpload.findOne({ where: { videoId } });
    if (!upload) {
      res.status(404).json({
        error: "not_found",
        message: "Upload not found.",
      });
      return;
    }

    const message =
      req.body && typeof req.body.error === "string" ? req.body.error : "content hash job failed";
    logger.error({ message }, `[original-uploads] hash job failed for upload ${upload.videoId}`);

    res.status(200).json({ success: true });
  });

  /**
   * Finishes a FILETYPES_CONVERTIBLE upload's normalization: the raw source
   * file is replaced by the processing service's H.264/AAC MP4 (or M4A)
   * output, the upload transitions out of `"converting"`, and the
   * rendition/thumbnail enqueue + duplicate-hash check that were deferred at
   * upload time both run now — against the normalized file rather than the
   * raw source.
   * POST /internal/original-uploads/:jobId/normalize-complete with
   * { fileSizeBytes?, videoWidth?, videoHeight?, resolution?, storagePath,
   *   fileExtension, mimeType? }. `:jobId` is `normalize-<videoId>`.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/original-uploads/{jobId}/normalize-complete:
   *   post:
   *     tags: [Internal]
   *     summary: Finish a FILETYPES_CONVERTIBLE upload's normalization
   *     operationId: originalUploadNormalizeComplete
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [storagePath, fileExtension]
   *             properties:
   *               fileSizeBytes: { type: number }
   *               videoWidth: { type: number, nullable: true }
   *               videoHeight: { type: number, nullable: true }
   *               resolution: { type: string, nullable: true }
   *               storagePath: { type: string }
   *               fileExtension: { type: string }
   *               mimeType: { type: string, nullable: true }
   *     responses:
   *       200:
   *         description: Upload normalized; rendition/thumbnail jobs enqueued
   *       400:
   *         description: Invalid jobId or missing required fields
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `jobId` param + completion body.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200, 400, or 404.
   */
  router.post("/original-uploads/:jobId/normalize-complete", async (req, res) => {
    const videoId = videoIdFromNormalizeJobId(String(req.params.jobId || "").trim());
    if (!videoId) {
      res.status(400).json({
        error: "invalid_job_id",
        message: "jobId must be of the form normalize-<videoId>.",
      });
      return;
    }

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const storagePath = typeof body.storagePath === "string" ? body.storagePath.trim() : "";
    const fileExtension =
      typeof body.fileExtension === "string" ? body.fileExtension.trim().toLowerCase() : "";
    if (!storagePath || !fileExtension) {
      res.status(400).json({
        error: "invalid_body",
        message: "storagePath and fileExtension are required.",
      });
      return;
    }

    const upload = await OriginalUpload.findOne({ where: { videoId } });
    if (!upload) {
      res.status(404).json({
        error: "not_found",
        message: "Upload not found.",
      });
      return;
    }

    const previousStoragePath = upload.storagePath;
    const newStoredFilename = storagePath.split("/").pop();

    await upload.update({
      fileExtension,
      mimeType: typeof body.mimeType === "string" ? body.mimeType : null,
      storagePath,
      videoWidth: typeof body.videoWidth === "number" ? body.videoWidth : null,
      videoHeight: typeof body.videoHeight === "number" ? body.videoHeight : null,
      resolution: typeof body.resolution === "string" ? body.resolution : null,
      fileSizeBytes:
        typeof body.fileSizeBytes === "number" ? body.fileSizeBytes : upload.fileSizeBytes,
      status: "uploaded",
      statusMessage: null,
    });

    if (previousStoragePath && previousStoragePath !== storagePath) {
      await unlink(resolveMediaPath(previousStoragePath)).catch(() => {});
    }

    await finalizeUploadTranscodes(upload, newStoredFilename, {
      skipThumbnail: upload.skipThumbnail,
    });
    enqueueDuplicateHashCheck(upload, newStoredFilename);

    res.status(200).json({ success: true, videoId, status: "uploaded" });
  });

  /**
   * Records a failed normalize job for a FILETYPES_CONVERTIBLE upload.
   * Deliberately leaves the raw source file under `original/` in place — the
   * upload row (and its file) stay around as a failed, inspectable record
   * rather than silently destroying the user's uploaded data.
   * POST /internal/original-uploads/:jobId/normalize-failed with { error? }.
   * `:jobId` is `normalize-<videoId>`. Auth: Bearer INTERNAL_SERVICE_TOKEN
   * (router-level).
   *
   * @openapi
   * /internal/original-uploads/{jobId}/normalize-failed:
   *   post:
   *     tags: [Internal]
   *     summary: Record a failed FILETYPES_CONVERTIBLE normalize job
   *     operationId: originalUploadNormalizeFailed
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     requestBody:
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               error: { type: string }
   *     responses:
   *       200:
   *         description: Failure recorded; upload marked failed
   *       400:
   *         description: Invalid jobId
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Request with `jobId` param + optional `error` string.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200, 400, or 404.
   */
  router.post("/original-uploads/:jobId/normalize-failed", async (req, res) => {
    const videoId = videoIdFromNormalizeJobId(String(req.params.jobId || "").trim());
    if (!videoId) {
      res.status(400).json({
        error: "invalid_job_id",
        message: "jobId must be of the form normalize-<videoId>.",
      });
      return;
    }

    const upload = await OriginalUpload.findOne({ where: { videoId } });
    if (!upload) {
      res.status(404).json({
        error: "not_found",
        message: "Upload not found.",
      });
      return;
    }

    const message =
      req.body && typeof req.body.error === "string"
        ? req.body.error
        : "format conversion failed";
    logger.error(
      { message },
      `[original-uploads] normalize job failed for upload ${upload.videoId}`,
    );

    await upload.update({
      status: "failed",
      statusMessage: message.slice(0, 255),
    });

    res.status(200).json({ success: true, videoId, status: "failed" });
  });

  return router;
}
