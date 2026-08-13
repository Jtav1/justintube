import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { requireModerator } from "../lib/auth/require-moderator.js";
import {
  DuplicateUploadFlag,
  OriginalUpload,
  User,
  VideoMetadata,
  VideoThumbnail,
} from "../lib/models/index.js";
import { removeVideoDocument } from "../lib/search.js";
import { parsePagination } from "../lib/pagination.js";
import { mediaDir } from "./uploads.js";
import { serializeVideo } from "./videos.js";

/**
 * Resolution values a moderator may set when resolving a flag.
 *
 * @type {Set<string>}
 */
const RESOLUTION_VALUES = new Set(["kept_new", "kept_existing"]);

/**
 * Maximum length for a moderator's resolution comment.
 *
 * @type {number}
 */
const MAX_COMMENT_LENGTH = 500;

/**
 * Eager-load spec used everywhere a DuplicateUploadFlag's two sides need to
 * be rendered as video-card summaries (`serializeVideo`).
 *
 * @type {Array<object>}
 */
const FLAG_UPLOAD_INCLUDES = [
  {
    model: OriginalUpload,
    as: "NewUpload",
    required: false,
    include: [
      { model: User, required: false },
      { model: VideoThumbnail, required: false },
      { model: VideoMetadata, as: "VideoMetadata", required: false },
    ],
  },
  {
    model: OriginalUpload,
    as: "ExistingUpload",
    required: false,
    include: [
      { model: User, required: false },
      { model: VideoThumbnail, required: false },
      { model: VideoMetadata, as: "VideoMetadata", required: false },
    ],
  },
];

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
 * Serializes an eager-loaded OriginalUpload side of a flag as a video-card
 * summary, or null when that side has since been deleted (e.g. its owner
 * removed it independently, or an earlier moderation resolved it away).
 *
 * @private
 * @param {import('sequelize').Model|null|undefined} upload Eager-loaded upload, if present.
 * @returns {object|null} `serializeVideo` payload, or null.
 */
function serializeFlagUpload(upload) {
  if (!upload || !upload.VideoMetadata) {
    return null;
  }
  return serializeVideo(upload, upload.VideoMetadata);
}

/**
 * Serializes a DuplicateUploadFlag row for JSON responses, including both
 * sides' video-card summaries so a moderator can compare them without a
 * follow-up request.
 *
 * @private
 * @param {import('sequelize').Model} row Flag instance, with `FLAG_UPLOAD_INCLUDES` loaded.
 * @returns {object} Public flag payload.
 */
function serializeFlag(row) {
  return {
    id: row.id,
    contentHash: row.contentHash,
    status: row.status,
    resolution: row.resolution ?? null,
    moderatorUserId: row.moderatorUserId ?? null,
    moderatorComment: row.moderatorComment ?? null,
    createdAt: row.createdAt,
    resolvedAt: row.resolvedAt ?? null,
    newUpload: serializeFlagUpload(row.NewUpload),
    existingUpload: serializeFlagUpload(row.ExistingUpload),
  };
}

/**
 * Validates a `PATCH /admin/duplicate-uploads/:id/moderate` request body.
 *
 * @private
 * @param {unknown} body Raw request body.
 * @returns {{ok: true, resolution: string, comment: string|null}|{ok: false, message: string}}
 *   Parsed fields, or a validation error.
 */
function parseModerateBody(body) {
  const payload = body && typeof body === "object" ? body : {};
  if (!RESOLUTION_VALUES.has(payload.resolution)) {
    return { ok: false, message: 'resolution must be "kept_new" or "kept_existing".' };
  }
  if (payload.comment !== undefined) {
    if (typeof payload.comment !== "string" || payload.comment.length > MAX_COMMENT_LENGTH) {
      return {
        ok: false,
        message: `comment must be a string of at most ${MAX_COMMENT_LENGTH} characters.`,
      };
    }
  }
  return {
    ok: true,
    resolution: payload.resolution,
    comment: typeof payload.comment === "string" ? payload.comment : null,
  };
}

/**
 * Builds the router exposing the admin/moderator duplicate-upload review
 * queue.
 *
 * @returns {import('express').Router} Router handling GET/PATCH /admin/duplicate-uploads.
 */
export function createDuplicateUploadFlagsRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Lists duplicate-upload flags, optionally filtered by status.
   * GET /api/v1/admin/duplicate-uploads
   * Auth: session cookie or Bearer API key; moderator or admin role required.
   *
   * @openapi
   * /api/v1/admin/duplicate-uploads:
   *   get:
   *     tags: [Admin]
   *     summary: List duplicate-upload review flags
   *     operationId: listDuplicateUploadFlags
   *     parameters:
   *       - name: status
   *         in: query
   *         schema: { type: string, enum: [pending, resolved] }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Flag list
   *       400:
   *         description: Invalid query
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not a moderator or admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with `{ items, page, limit, total }`, or error.
   */
  router.get(
    "/admin/duplicate-uploads",
    requireAuth,
    requireModerator,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }

      const where = {};
      if (req.query.status !== undefined) {
        if (req.query.status !== "pending" && req.query.status !== "resolved") {
          res.status(400).json({
            error: "invalid_query",
            message: "status must be pending or resolved.",
          });
          return;
        }
        where.status = req.query.status;
      }

      try {
        const { rows, count } = await DuplicateUploadFlag.findAndCountAll({
          where,
          include: FLAG_UPLOAD_INCLUDES,
          order: [["createdAt", "DESC"]],
          limit: pagination.limit,
          offset: (pagination.page - 1) * pagination.limit,
        });
        res.status(200).json({
          items: rows.map(serializeFlag),
          page: pagination.page,
          limit: pagination.limit,
          total: count,
        });
      } catch (err) {
        console.error("listDuplicateUploadFlags failed:", err);
        res.status(500).json({ error: "internal_error", message: "Failed to list flags." });
      }
    },
  );

  /**
   * Gets a single duplicate-upload flag.
   * GET /api/v1/admin/duplicate-uploads/:id
   * Auth: session cookie or Bearer API key; moderator or admin role required.
   *
   * @openapi
   * /api/v1/admin/duplicate-uploads/{id}:
   *   get:
   *     tags: [Admin]
   *     summary: Get a duplicate-upload review flag
   *     operationId: getDuplicateUploadFlag
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer, minimum: 1 }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Flag record
   *       400:
   *         description: Invalid id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not a moderator or admin
   *       404:
   *         description: Flag not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with flag record, or error.
   */
  router.get(
    "/admin/duplicate-uploads/:id",
    requireAuth,
    requireModerator,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      try {
        const row = await DuplicateUploadFlag.findByPk(id, { include: FLAG_UPLOAD_INCLUDES });
        if (!row) {
          res.status(404).json({ error: "not_found", message: "Flag not found." });
          return;
        }
        res.status(200).json(serializeFlag(row));
      } catch (err) {
        console.error("getDuplicateUploadFlag failed:", err);
        res.status(500).json({ error: "internal_error", message: "Failed to fetch flag." });
      }
    },
  );

  /**
   * Resolves a duplicate-upload flag. Both uploads are already live (this
   * feature never blocks or parks an upload — flags are created purely as a
   * background review queue), so `kept_new` is simply a record-keeping
   * no-op: it marks the flag resolved and leaves both videos as they are.
   * `kept_existing` hard-deletes the new upload (its ORIGINAL_UPLOADS row
   * and cascades, plus its search-index entry) in favor of the existing
   * video, mirroring `DELETE /videos/:id`.
   * PATCH /api/v1/admin/duplicate-uploads/:id/moderate
   * Auth: session cookie or Bearer API key; moderator or admin role required.
   *
   * @openapi
   * /api/v1/admin/duplicate-uploads/{id}/moderate:
   *   patch:
   *     tags: [Admin]
   *     summary: Resolve a duplicate-upload review flag
   *     operationId: moderateDuplicateUploadFlag
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer, minimum: 1 }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [resolution]
   *             properties:
   *               resolution: { type: string, enum: [kept_new, kept_existing] }
   *               comment: { type: string, maxLength: 500 }
   *     responses:
   *       200:
   *         description: Resolved flag
   *       400:
   *         description: Invalid body or id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not a moderator or admin
   *       404:
   *         description: Flag not found
   *       409:
   *         description: Flag already resolved
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with resolved flag, or error.
   */
  router.patch(
    "/admin/duplicate-uploads/:id/moderate",
    requireAuth,
    requireModerator,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const parsed = parseModerateBody(req.body || {});
      if (!parsed.ok) {
        res.status(400).json({ error: "invalid_body", message: parsed.message });
        return;
      }

      try {
        const flag = await DuplicateUploadFlag.findByPk(id);
        if (!flag) {
          res.status(404).json({ error: "not_found", message: "Flag not found." });
          return;
        }
        if (flag.status !== "pending") {
          res.status(409).json({ error: "already_resolved", message: "This flag has already been resolved." });
          return;
        }

        if (parsed.resolution === "kept_existing") {
          const newUpload = flag.newOriginalUploadId
            ? await OriginalUpload.findByPk(flag.newOriginalUploadId)
            : null;
          if (newUpload) {
            await unlink(join(mediaDir, newUpload.storagePath)).catch(() => {});
            const newUploadId = newUpload.id;
            await newUpload.destroy();
            removeVideoDocument(newUploadId);
          }
        }

        await flag.update({
          status: "resolved",
          resolution: parsed.resolution,
          moderatorUserId: req.user.id,
          moderatorComment: parsed.comment,
          resolvedAt: new Date(),
        });

        const reloaded = await DuplicateUploadFlag.findByPk(id, { include: FLAG_UPLOAD_INCLUDES });
        res.status(200).json(serializeFlag(reloaded));
      } catch (err) {
        console.error("moderateDuplicateUploadFlag failed:", err);
        res.status(500).json({ error: "internal_error", message: "Failed to moderate flag." });
      }
    },
  );

  return router;
}
