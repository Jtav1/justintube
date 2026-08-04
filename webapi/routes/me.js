import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Router } from "express";
import multer from "multer";
import { Op } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { isValidEmailFormat } from "../lib/email/validate-email.js";
import { mimeTypeForImage } from "../lib/media-meta.js";
import {
  OriginalUpload,
  Subscription,
  User,
  UserPlaylist,
  UserViewHistory,
  VideoAccess,
  VideoLike,
  VideoMetadata,
  VideoThumbnail,
} from "../lib/models/index.js";
import { parsePagination } from "../lib/pagination.js";
import { resolveSitedataPath } from "../lib/sitedata-meta.js";
import { canViewVideo } from "../lib/video-access.js";
import { loadHiddenUploadIds } from "../lib/video-hidden.js";
import { buildPlaylistsPage } from "./playlists.js";
import { loadUploadCountsByUserId } from "./users.js";
import {
  loadReactionCountsByUploadId,
  loadTagsByUploadId,
  parsePositiveInt,
  serializeVideo,
} from "./videos.js";

/**
 * Absolute path to the directory where avatar images are stored
 * (`SITEDATA_STORAGE_DIRECTORY/avatars`).
 *
 * @type {string}
 */
const avatarsDir = resolveSitedataPath("avatars");

// Ensure the avatars directory exists before any upload is attempted.
mkdirSync(avatarsDir, { recursive: true });

/**
 * Set of allowed lowercase avatar file extensions (without a leading dot),
 * parsed from the AVATAR_FILETYPES_ALLOWED env var.
 *
 * @type {Set<string>}
 */
const allowedAvatarExtensions = new Set(
  (process.env.AVATAR_FILETYPES_ALLOWED || "jpg,jpeg,png,webp")
    .split(",")
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean),
);

/**
 * Maximum accepted avatar upload size in bytes. Defaults to 5 MiB; override
 * with the MAX_AVATAR_SIZE_BYTES env var.
 *
 * @type {number}
 */
const maxAvatarSizeBytes = Number(process.env.MAX_AVATAR_SIZE_BYTES) || 5 * 1024 * 1024;

/**
 * Normalizes a file's extension to a lowercase value without the leading dot.
 *
 * @private
 * @param {string} filename Original client-provided filename.
 * @returns {string} Lowercase extension without a dot (empty string if none).
 */
function normalizedAvatarExtension(filename) {
  return extname(filename).toLowerCase().replace(/^\./, "");
}

/**
 * Multer storage engine that writes avatar uploads to `avatars/` under the
 * sitedata root using a freshly generated UUID as the filename (preserving
 * the original extension).
 */
const avatarStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, avatarsDir),
  filename: (_req, file, cb) => {
    const ext = normalizedAvatarExtension(file.originalname);
    cb(null, ext ? `${randomUUID()}.${ext}` : randomUUID());
  },
});

/**
 * Multer file filter that rejects any file whose extension is not present in
 * AVATAR_FILETYPES_ALLOWED.
 *
 * @private
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {Express.Multer.File} file File metadata provided by multer.
 * @param {multer.FileFilterCallback} cb Callback signaling acceptance/rejection.
 * @returns {void} Invokes `cb` with the filter decision.
 */
function avatarFileFilter(_req, file, cb) {
  const ext = normalizedAvatarExtension(file.originalname);
  if (!allowedAvatarExtensions.has(ext)) {
    const error = new Error(`File type ".${ext}" is not allowed.`);
    error.code = "UNSUPPORTED_FILE_TYPE";
    cb(error);
    return;
  }
  cb(null, true);
}

const avatarUpload = multer({
  storage: avatarStorage,
  fileFilter: avatarFileFilter,
  limits: { fileSize: maxAvatarSizeBytes },
});

/**
 * Express error-handling middleware that maps avatar-upload multer errors to
 * JSON responses, mirroring `uploadErrorHandler` in `routes/uploads.js`.
 *
 * @param {Error} err Error thrown during avatar upload handling.
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Passes non-upload errors along.
 * @returns {void} Sends an error JSON response or delegates via `next`.
 */
function avatarUploadErrorHandler(err, _req, res, next) {
  if (err?.code === "UNSUPPORTED_FILE_TYPE") {
    res.status(400).json({
      error: "unsupported_file_type",
      message: err.message,
      allowed: [...allowedAvatarExtensions],
    });
    return;
  }
  if (err instanceof multer.MulterError) {
    const isTooLarge = err.code === "LIMIT_FILE_SIZE";
    res.status(isTooLarge ? 413 : 400).json({
      error: isTooLarge ? "file_too_large" : "upload_error",
      message: err.message,
    });
    return;
  }
  next(err);
}

const FORBIDDEN_FIELDS = [
  "id",
  "passwordHash",
  "passwordExpired",
  "emailVerified",
  "emailVerifiedAt",
  "uploader",
  "roleId",
  "role",
];

/**
 * Maps a User Sequelize instance (with Role included/passed) to the account
 * metadata shape returned by `getMeSettings`/`updateMe`. Never includes
 * `passwordHash`.
 *
 * @param {import('sequelize').Model} user User model instance.
 * @param {import('sequelize').Model|null} [role] Role instance (falls back to `user.Role`).
 * @returns {{
 *   id: number,
 *   username: string,
 *   email: string,
 *   displayName: string|null,
 *   bio: string|null,
 *   avatarFilename: string|null,
 *   bannerFilename: string|null,
 *   emailVerified: boolean,
 *   emailVerifiedAt: Date|null,
 *   uploader: boolean,
 *   role: string|null,
 *   passwordExpired: boolean,
 *   createdAt: Date,
 *   updatedAt: Date
 * }} Account metadata payload.
 */
function serializeMeSettings(user, role = null) {
  const resolvedRole = role || user.Role || null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName ?? null,
    bio: user.bio ?? null,
    avatarFilename: user.avatarFilename ?? null,
    bannerFilename: user.bannerFilename ?? null,
    emailVerified: Boolean(user.emailVerified),
    emailVerifiedAt: user.emailVerifiedAt ?? null,
    uploader: Boolean(user.uploader),
    role: resolvedRole ? resolvedRole.name : null,
    passwordExpired: Boolean(user.passwordExpired),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Validates and normalizes a `PATCH /me` request body. Only `username`,
 * `displayName`, `bio`, and `email` may be changed; any other known User
 * field present in the body is rejected rather than silently ignored.
 *
 * @param {unknown} body Parsed request body.
 * @returns {{ ok: true, updates: Record<string, unknown> }
 *   | { ok: false, message: string }} Validated updates or a validation error.
 */
function parseMeUpdate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Request body must be an object." };
  }

  const forbidden = FORBIDDEN_FIELDS.filter((field) =>
    Object.prototype.hasOwnProperty.call(body, field),
  );
  if (forbidden.length > 0) {
    return {
      ok: false,
      message: `The following fields are not editable: ${forbidden.join(", ")}.`,
    };
  }

  const updates = {};

  if (Object.prototype.hasOwnProperty.call(body, "username")) {
    const username = String(body.username || "").trim();
    if (!username) {
      return { ok: false, message: "username must not be empty." };
    }
    if (username.length > 255) {
      return { ok: false, message: "username must be at most 255 characters." };
    }
    updates.username = username;
  }

  if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
    const displayNameRaw = body.displayName;
    updates.displayName =
      displayNameRaw === null || displayNameRaw === undefined
        ? null
        : String(displayNameRaw).trim() || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "bio")) {
    const bioRaw = body.bio;
    updates.bio =
      bioRaw === null || bioRaw === undefined
        ? null
        : String(bioRaw).trim() || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "email")) {
    const email = String(body.email || "").trim().toLowerCase();
    if (!email) {
      return { ok: false, message: "email must not be empty." };
    }
    if (!isValidEmailFormat(email)) {
      return { ok: false, message: "email must be a valid email address." };
    }
    updates.email = email;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, message: "No editable fields provided." };
  }

  return { ok: true, updates };
}

/**
 * Maps a hydrated User instance (as included on a Subscription row) to the
 * public-safe shape returned by `listMySubscriptions`/`listMySubscribers`.
 *
 * @param {import('sequelize').Model} user User model instance.
 * @param {{uploadCount?: number}} [options] `uploadCount`: public upload
 *   count, precomputed by the caller (matches `serializeUserListItem`, so
 *   the shared UserCard component renders consistently).
 * @returns {{id: number, username: string, displayName: string|null, avatarFilename: string|null, uploadCount: number}}
 *   Public-safe hydrated user payload.
 */
function serializeSubscriptionUser(user, { uploadCount = 0 } = {}) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    avatarFilename: user.avatarFilename ?? null,
    uploadCount,
  };
}

/**
 * Builds the "me" account settings router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured me/account settings router.
 */
export function createMeRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Returns the authenticated user's account metadata.
   * GET /api/v1/me/settings
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/settings:
   *   get:
   *     tags: [Me]
   *     summary: Get my account settings
   *     operationId: getMeSettings
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Account metadata (never includes passwordHash)
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the account metadata or an error response.
   */
  router.get("/me/settings", requireAuth, async (req, res) => {
    try {
      res.json(serializeMeSettings(req.user, req.authRole));
    } catch (err) {
      console.error("getMeSettings failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load account settings.",
      });
    }
  });

  /**
   * Updates the authenticated user's editable account fields (`username`,
   * `displayName`, `bio`, `email`). Changing `email` resets
   * `emailVerified`/`emailVerifiedAt`.
   * PATCH /api/v1/me
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/me:
   *   patch:
   *     tags: [Me]
   *     summary: Update my account settings
   *     operationId: updateMe
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               username: { type: string }
   *               displayName: { type: string, nullable: true }
   *               bio: { type: string, nullable: true }
   *               email: { type: string }
   *     responses:
   *       200:
   *         description: Updated account metadata
   *       400:
   *         description: Invalid body
   *       401:
   *         description: Not authenticated
   *       409:
   *         description: Username or email already registered to another account
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated account metadata or an error response.
   */
  router.patch("/me", requireAuth, async (req, res) => {
    try {
      const parsed = parseMeUpdate(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: "invalid_body", message: parsed.message });
        return;
      }

      const { updates } = parsed;

      if (
        Object.prototype.hasOwnProperty.call(updates, "username") &&
        updates.username !== req.user.username
      ) {
        const duplicate = await User.findOne({
          where: { username: updates.username, id: { [Op.ne]: req.user.id } },
        });
        if (duplicate) {
          res.status(409).json({
            error: "conflict",
            message: "Username is already registered to another account.",
          });
          return;
        }
      }

      if (
        Object.prototype.hasOwnProperty.call(updates, "email") &&
        updates.email !== req.user.email
      ) {
        const duplicate = await User.findOne({
          where: { email: updates.email, id: { [Op.ne]: req.user.id } },
        });
        if (duplicate) {
          res.status(409).json({
            error: "conflict",
            message: "Email is already registered to another account.",
          });
          return;
        }
        updates.emailVerified = false;
        updates.emailVerifiedAt = null;
      }

      await req.user.update(updates);
      res.json(serializeMeSettings(req.user, req.authRole));
    } catch (err) {
      console.error("updateMe failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update account.",
      });
    }
  });

  /**
   * Returns the authenticated user's own uploaded videos (all visibilities),
   * combining ORIGINAL_UPLOADS, VIDEO_METADATA, and VIDEO_THUMBNAIL, newest
   * first, paginated.
   * GET /api/v1/me/videos
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/videos:
   *   get:
   *     tags: [Me]
   *     summary: List my uploaded videos
   *     operationId: listMyVideos
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: page
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 99
   *           default: 20
   *     responses:
   *       200:
   *         description: Paginated list of my uploaded videos
   *       400:
   *         description: Invalid page/limit
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated video list or an error response.
   */
  router.get("/me/videos", requireAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { rows, count } = await OriginalUpload.findAndCountAll({
        where: { userId: req.user.id },
        include: [
          { model: VideoMetadata, as: "VideoMetadata", required: true },
          { model: VideoThumbnail, required: false },
          { model: User, required: false },
        ],
        order: [[{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"]],
        limit,
        offset: (page - 1) * limit,
      });

      const uploadIds = rows.map((upload) => upload.id);
      const tagsByUploadId = await loadTagsByUploadId(uploadIds);
      const reactionCountsByUploadId = await loadReactionCountsByUploadId(uploadIds);

      res.status(200).json({
        items: rows.map((upload) =>
          serializeVideo(upload, upload.VideoMetadata, {
            tags: tagsByUploadId.get(upload.id) || [],
            ...reactionCountsByUploadId.get(upload.id),
          }),
        ),
        page,
        limit,
        totalHits: count,
        totalPages: count === 0 ? 0 : Math.ceil(count / limit),
      });
    } catch (err) {
      console.error("listMyVideos failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list your videos.",
      });
    }
  });

  /**
   * Returns videos the authenticated user has liked (positive VIDEO_LIKES
   * rows), newest like first, paginated. Only includes videos the user can
   * currently see, per {@link canViewVideo}: owner/admin always; public and
   * unlisted always; private and hidden only with a VIDEO_ACCESS grant. Videos
   * the caller has personally hidden (USER_HIDDEN_VIDEOS) are excluded.
   * GET /api/v1/me/likes
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/likes:
   *   get:
   *     tags: [Me]
   *     summary: List videos I have liked
   *     operationId: listMyLikes
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: page
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 99
   *           default: 20
   *     responses:
   *       200:
   *         description: Paginated list of videos I have liked
   *       400:
   *         description: Invalid page/limit
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated liked-video list or an error response.
   */
  router.get("/me/likes", requireAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const grants = await VideoAccess.findAll({
        where: { userId: req.user.id },
        attributes: ["originalUploadId"],
      });
      const grantedUploadIds = new Set(grants.map((grant) => grant.originalUploadId));
      const hiddenUploadIds = await loadHiddenUploadIds(req.user.id);

      const likes = await VideoLike.findAll({
        where: { userId: req.user.id, likeValue: { [Op.gt]: 0 } },
        include: [
          {
            model: OriginalUpload,
            required: true,
            include: [
              { model: VideoMetadata, as: "VideoMetadata", required: true },
              { model: VideoThumbnail, required: false },
              { model: User, required: false },
            ],
          },
        ],
        order: [["createdAt", "DESC"]],
      });

      const visibleLikes = likes.filter((like) => {
        const upload = like.OriginalUpload;
        return (
          !hiddenUploadIds.has(upload.id) &&
          canViewVideo(
            req.user,
            req.authRole,
            upload,
            upload.VideoMetadata,
            grantedUploadIds.has(upload.id),
          )
        );
      });

      const totalHits = visibleLikes.length;
      const offset = (page - 1) * limit;
      const pageLikes = visibleLikes.slice(offset, offset + limit);
      const likedUploadIds = pageLikes.map((like) => like.OriginalUpload.id);
      const tagsByUploadId = await loadTagsByUploadId(likedUploadIds);
      const reactionCountsByUploadId = await loadReactionCountsByUploadId(likedUploadIds);

      res.status(200).json({
        items: pageLikes.map((like) =>
          serializeVideo(like.OriginalUpload, like.OriginalUpload.VideoMetadata, {
            tags: tagsByUploadId.get(like.OriginalUpload.id) || [],
            ...reactionCountsByUploadId.get(like.OriginalUpload.id),
          }),
        ),
        page,
        limit,
        totalHits,
        totalPages: totalHits === 0 ? 0 : Math.ceil(totalHits / limit),
      });
    } catch (err) {
      console.error("listMyLikes failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list your liked videos.",
      });
    }
  });

  /**
   * Returns videos the authenticated user has viewed (USER_VIEW_HISTORY
   * rows), most-recently-viewed first, paginated. Repeat views of the same
   * video each produce their own row/item (no dedup), each with a distinct
   * `historyId` - the same video can legitimately appear more than once.
   * Only includes videos the user can currently see, per {@link canViewVideo}
   * (same visibility rules as listMyLikes), and excludes videos the caller
   * has personally hidden (USER_HIDDEN_VIDEOS). Deleted videos never appear -
   * their history rows are removed automatically via ON DELETE CASCADE.
   * GET /api/v1/me/history
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/history:
   *   get:
   *     tags: [Me]
   *     summary: List my video watch history
   *     operationId: listMyHistory
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: page
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 99
   *           default: 20
   *     responses:
   *       200:
   *         description: Paginated list of videos I've watched, newest-viewed first
   *       400:
   *         description: Invalid page/limit
   *       401:
   *         description: Not authenticated
   *   delete:
   *     tags: [Me]
   *     summary: Clear my entire video watch history
   *     operationId: clearMyHistory
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       204:
   *         description: Watch history cleared
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated watch-history list or an error response.
   */
  router.get("/me/history", requireAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const grants = await VideoAccess.findAll({
        where: { userId: req.user.id },
        attributes: ["originalUploadId"],
      });
      const grantedUploadIds = new Set(grants.map((grant) => grant.originalUploadId));
      const hiddenUploadIds = await loadHiddenUploadIds(req.user.id);

      const history = await UserViewHistory.findAll({
        where: { userId: req.user.id },
        include: [
          {
            model: OriginalUpload,
            required: true,
            include: [
              { model: VideoMetadata, as: "VideoMetadata", required: true },
              { model: VideoThumbnail, required: false },
              { model: User, required: false },
            ],
          },
        ],
        order: [["createdAt", "DESC"]],
      });

      const visibleHistory = history.filter((row) => {
        const upload = row.OriginalUpload;
        return (
          !hiddenUploadIds.has(upload.id) &&
          canViewVideo(
            req.user,
            req.authRole,
            upload,
            upload.VideoMetadata,
            grantedUploadIds.has(upload.id),
          )
        );
      });

      const totalHits = visibleHistory.length;
      const offset = (page - 1) * limit;
      const pageHistory = visibleHistory.slice(offset, offset + limit);
      const historyUploadIds = pageHistory.map((row) => row.OriginalUpload.id);
      const tagsByUploadId = await loadTagsByUploadId(historyUploadIds);
      const reactionCountsByUploadId = await loadReactionCountsByUploadId(historyUploadIds);

      res.status(200).json({
        items: pageHistory.map((row) => ({
          ...serializeVideo(row.OriginalUpload, row.OriginalUpload.VideoMetadata, {
            tags: tagsByUploadId.get(row.OriginalUpload.id) || [],
            ...reactionCountsByUploadId.get(row.OriginalUpload.id),
          }),
          historyId: row.id,
          viewedAt: row.createdAt,
        })),
        page,
        limit,
        totalHits,
        totalPages: totalHits === 0 ? 0 : Math.ceil(totalHits / limit),
      });
    } catch (err) {
      console.error("listMyHistory failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list your watch history.",
      });
    }
  });

  /**
   * Clears the authenticated user's entire video watch history.
   * DELETE /api/v1/me/history
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 empty or an error response.
   */
  router.delete("/me/history", requireAuth, async (req, res) => {
    try {
      await UserViewHistory.destroy({ where: { userId: req.user.id } });
      res.status(204).send();
    } catch (err) {
      console.error("clearMyHistory failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to clear your watch history.",
      });
    }
  });

  /**
   * Removes a single entry from the authenticated user's watch history, by
   * the history entry's own id (not the video's id - the same video can have
   * multiple history entries from repeat views).
   * DELETE /api/v1/me/history/:id
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/me/history/{id}:
   *   delete:
   *     tags: [Me]
   *     summary: Remove one entry from my watch history
   *     operationId: deleteHistoryEntry
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: integer
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       204:
   *         description: History entry removed
   *       400:
   *         description: Invalid id
   *       401:
   *         description: Not authenticated
   *       404:
   *         description: History entry not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 empty or an error response.
   */
  router.delete("/me/history/:id", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const row = await UserViewHistory.findOne({ where: { id, userId: req.user.id } });
      if (!row) {
        res.status(404).json({ error: "not_found", message: "History entry not found." });
        return;
      }

      await row.destroy();
      res.status(204).send();
    } catch (err) {
      console.error("deleteHistoryEntry failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to remove history entry.",
      });
    }
  });

  /**
   * Returns the authenticated user's system-managed "My Likes" playlist
   * (kind "likes"), or 404 if they haven't liked a video yet — it is created
   * lazily on first like (see lib/likes-playlist.js).
   * GET /api/v1/me/likes-playlist
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/likes-playlist:
   *   get:
   *     tags: [Me]
   *     summary: Get my "My Likes" playlist
   *     operationId: getMyLikesPlaylist
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: My Likes playlist
   *       401:
   *         description: Not authenticated
   *       404:
   *         description: No My Likes playlist yet (no videos liked)
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the playlist or an error response.
   */
  router.get("/me/likes-playlist", requireAuth, async (req, res) => {
    try {
      const playlist = await UserPlaylist.findOne({
        where: { userId: req.user.id, kind: "likes" },
        include: [{ model: User, required: false }],
      });
      if (!playlist) {
        res.status(404).json({
          error: "not_found",
          message: "You haven't liked any videos yet.",
        });
        return;
      }

      const payload = await buildPlaylistsPage([playlist], 1, {
        page: 1,
        limit: 1,
        user: req.user,
        role: req.authRole,
      });
      res.status(200).json(payload.items[0]);
    } catch (err) {
      console.error("getMyLikesPlaylist failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load your My Likes playlist.",
      });
    }
  });

  /**
   * Returns the users the authenticated user is subscribed to, newest
   * subscription first, paginated.
   * GET /api/v1/me/subscriptions
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/subscriptions:
   *   get:
   *     tags: [Me]
   *     summary: List who I'm subscribed to
   *     operationId: listMySubscriptions
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: page
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 99
   *           default: 20
   *     responses:
   *       200:
   *         description: Paginated list of users I'm subscribed to
   *       400:
   *         description: Invalid page/limit
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated subscription list or an error response.
   */
  router.get("/me/subscriptions", requireAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { rows, count } = await Subscription.findAndCountAll({
        where: { subscriberId: req.user.id },
        include: [
          {
            model: User,
            as: "SubscribedTo",
            attributes: ["id", "username", "displayName", "avatarFilename"],
          },
        ],
        order: [["createdAt", "DESC"]],
        limit,
        offset: (page - 1) * limit,
      });

      const uploadCounts = await loadUploadCountsByUserId(rows.map((row) => row.SubscribedTo.id));

      res.status(200).json({
        items: rows.map((row) => ({
          ...serializeSubscriptionUser(row.SubscribedTo, {
            uploadCount: uploadCounts.get(row.SubscribedTo.id) ?? 0,
          }),
          subscribedAt: row.createdAt,
        })),
        page,
        limit,
        totalHits: count,
        totalPages: count === 0 ? 0 : Math.ceil(count / limit),
      });
    } catch (err) {
      console.error("listMySubscriptions failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list your subscriptions.",
      });
    }
  });

  /**
   * Returns the users subscribed to the authenticated user, newest
   * subscription first, paginated.
   * GET /api/v1/me/subscribers
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/subscribers:
   *   get:
   *     tags: [Me]
   *     summary: List who is subscribed to me
   *     operationId: listMySubscribers
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: page
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 99
   *           default: 20
   *     responses:
   *       200:
   *         description: Paginated list of users subscribed to me
   *       400:
   *         description: Invalid page/limit
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated subscriber list or an error response.
   */
  router.get("/me/subscribers", requireAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { rows, count } = await Subscription.findAndCountAll({
        where: { subscribedToId: req.user.id },
        include: [
          {
            model: User,
            as: "Subscriber",
            attributes: ["id", "username", "displayName", "avatarFilename"],
          },
        ],
        order: [["createdAt", "DESC"]],
        limit,
        offset: (page - 1) * limit,
      });

      const uploadCounts = await loadUploadCountsByUserId(rows.map((row) => row.Subscriber.id));

      res.status(200).json({
        items: rows.map((row) => ({
          ...serializeSubscriptionUser(row.Subscriber, {
            uploadCount: uploadCounts.get(row.Subscriber.id) ?? 0,
          }),
          subscribedAt: row.createdAt,
        })),
        page,
        limit,
        totalHits: count,
        totalPages: count === 0 ? 0 : Math.ceil(count / limit),
      });
    } catch (err) {
      console.error("listMySubscribers failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list your subscribers.",
      });
    }
  });

  /**
   * Returns the authenticated user's own playlists, newest first, paginated.
   * Excludes the system-managed "My Likes" playlist (`kind: "likes"`) — this
   * endpoint backs the manual "add video to playlist" picker, and that
   * playlist's membership is only ever changed by liking/disliking videos.
   * GET /api/v1/me/playlists
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/playlists:
   *   get:
   *     tags: [Me]
   *     summary: List my playlists
   *     operationId: listMyPlaylists
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: page
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 99
   *           default: 20
   *     responses:
   *       200:
   *         description: Paginated list of my playlists
   *       400:
   *         description: Invalid page/limit
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated playlist list or an error response.
   */
  router.get("/me/playlists", requireAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { rows, count } = await UserPlaylist.findAndCountAll({
        where: { userId: req.user.id, kind: { [Op.ne]: "likes" } },
        order: [["createdAt", "DESC"]],
        limit,
        offset: (page - 1) * limit,
      });

      res.status(200).json({
        items: rows.map((playlist) => ({
          id: playlist.id,
          title: playlist.title,
          description: playlist.description ?? null,
          visibility: playlist.visibility,
          lastAddedAt: playlist.lastAddedAt ?? null,
          createdAt: playlist.createdAt,
        })),
        page,
        limit,
        totalHits: count,
        totalPages: count === 0 ? 0 : Math.ceil(count / limit),
      });
    } catch (err) {
      console.error("listMyPlaylists failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list your playlists.",
      });
    }
  });

  /**
   * Uploads (or replaces) the authenticated user's avatar image. Deletes the
   * previous avatar file from disk, if any, after the new one is persisted.
   * POST /api/v1/me/avatar — multipart `file`.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/me/avatar:
   *   post:
   *     tags: [Me]
   *     summary: Upload or replace my avatar image
   *     operationId: updateMyAvatar
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             required: [file]
   *             properties:
   *               file:
   *                 type: string
   *                 format: binary
   *     responses:
   *       200:
   *         description: Avatar updated
   *       400:
   *         description: Missing file, or unsupported file type
   *       401:
   *         description: Not authenticated
   *       413:
   *         description: File too large
   *   delete:
   *     tags: [Me]
   *     summary: Remove my avatar image
   *     operationId: deleteMyAvatar
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Avatar removed (idempotent; also returned when no avatar was set)
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated avatar filename or an error response.
   */
  router.post(
    "/me/avatar",
    requireAuth,
    avatarUpload.single("file"),
    async (req, res) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: "invalid_body", message: "file is required." });
          return;
        }

        const previousAvatarFilename = req.user.avatarFilename;

        try {
          await req.user.update({ avatarFilename: req.file.filename });
        } catch (err) {
          await unlink(join(avatarsDir, req.file.filename)).catch(() => {});
          throw err;
        }

        if (previousAvatarFilename && previousAvatarFilename !== req.file.filename) {
          await unlink(join(avatarsDir, previousAvatarFilename)).catch(() => {});
        }

        res.status(200).json({ avatarFilename: req.user.avatarFilename });
      } catch (err) {
        console.error("updateMyAvatar failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to update your avatar.",
        });
      }
    },
  );
  router.use(avatarUploadErrorHandler);

  /**
   * Removes the authenticated user's avatar image, deleting the file from
   * disk (best-effort) and clearing the column. Idempotent.
   * DELETE /api/v1/me/avatar
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }` or an error response.
   */
  router.delete("/me/avatar", requireAuth, async (req, res) => {
    try {
      if (req.user.avatarFilename) {
        await unlink(join(avatarsDir, req.user.avatarFilename)).catch(() => {});
        await req.user.update({ avatarFilename: null });
      }
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("deleteMyAvatar failed:", err);
      res.status(500).json({
        success: false,
        error: "internal_error",
        message: "Failed to remove your avatar.",
      });
    }
  });

  return router;
}
