import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Router } from "express";
import multer from "multer";
import { Op, col, fn } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { optionalAuth, requireAuth } from "../lib/auth/require-auth.js";
import { buildPublicLink } from "../lib/email/mailer.js";
import { mimeTypeForImage } from "../lib/media-meta.js";
import { createNotification } from "../lib/notifications.js";
import {
  OriginalUpload,
  PlaylistAccess,
  Role,
  Subscription,
  User,
  UserPlaylist,
  VideoAccess,
  VideoMetadata,
  VideoThumbnail,
} from "../lib/models/index.js";
import { parsePagination } from "../lib/pagination.js";
import { streamFileWithRangeSupport } from "../lib/range-stream.js";
import { syncPlaylistIndex, syncUserIndex } from "../lib/search.js";
import { resolveSitedataPath } from "../lib/sitedata-meta.js";
import { isAdmin, isModeratorOrAdmin } from "../lib/video-access.js";
import { loadHiddenUploadIds } from "../lib/video-hidden.js";
import { buildPlaylistsPage } from "./playlists.js";
import {
  loadReactionCountsByUploadId,
  loadTagsByUploadId,
  loadViewerPermissionsByUploadId,
  serializeVideo,
} from "./videos.js";

/**
 * Absolute path to the directory where banner images are stored
 * (`SITEDATA_STORAGE_DIRECTORY/banners`).
 *
 * @type {string}
 */
const bannersDir = resolveSitedataPath("banners");

// Ensure the banners directory exists before any upload is attempted.
mkdirSync(bannersDir, { recursive: true });

/**
 * Set of allowed lowercase banner file extensions (without a leading dot),
 * parsed from the BANNER_FILETYPES_ALLOWED env var.
 *
 * @type {Set<string>}
 */
const allowedBannerExtensions = new Set(
  (process.env.BANNER_FILETYPES_ALLOWED || "jpg,jpeg,png,webp")
    .split(",")
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean),
);

/**
 * Maximum accepted banner upload size in bytes. Defaults to 5 MiB; override
 * with the MAX_BANNER_SIZE_BYTES env var.
 *
 * @type {number}
 */
const maxBannerSizeBytes = Number(process.env.MAX_BANNER_SIZE_BYTES) || 5 * 1024 * 1024;

/**
 * Normalizes a file's extension to a lowercase value without the leading dot.
 *
 * @private
 * @param {string} filename Original client-provided filename.
 * @returns {string} Lowercase extension without a dot (empty string if none).
 */
function normalizedBannerExtension(filename) {
  return extname(filename).toLowerCase().replace(/^\./, "");
}

/**
 * Multer storage engine that writes banner uploads to `banners/` under the
 * sitedata root using a freshly generated UUID as the filename (preserving
 * the original extension).
 */
const bannerStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, bannersDir),
  filename: (_req, file, cb) => {
    const ext = normalizedBannerExtension(file.originalname);
    cb(null, ext ? `${randomUUID()}.${ext}` : randomUUID());
  },
});

/**
 * Multer file filter that rejects any file whose extension is not present in
 * BANNER_FILETYPES_ALLOWED.
 *
 * @private
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {Express.Multer.File} file File metadata provided by multer.
 * @param {multer.FileFilterCallback} cb Callback signaling acceptance/rejection.
 * @returns {void} Invokes `cb` with the filter decision.
 */
function bannerFileFilter(_req, file, cb) {
  const ext = normalizedBannerExtension(file.originalname);
  if (!allowedBannerExtensions.has(ext)) {
    const error = new Error(`File type ".${ext}" is not allowed.`);
    error.code = "UNSUPPORTED_FILE_TYPE";
    cb(error);
    return;
  }
  cb(null, true);
}

const bannerUpload = multer({
  storage: bannerStorage,
  fileFilter: bannerFileFilter,
  limits: { fileSize: maxBannerSizeBytes },
});

/**
 * Express error-handling middleware that maps banner-upload multer errors to
 * JSON responses, mirroring `avatarUploadErrorHandler` in `routes/me.js`.
 *
 * @param {Error} err Error thrown during banner upload handling.
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Passes non-upload errors along.
 * @returns {void} Sends an error JSON response or delegates via `next`.
 */
function bannerUploadErrorHandler(err, _req, res, next) {
  if (err?.code === "UNSUPPORTED_FILE_TYPE") {
    res.status(400).json({
      error: "unsupported_file_type",
      message: err.message,
      allowed: [...allowedBannerExtensions],
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

/**
 * Absolute path to the directory where avatar images are stored
 * (`SITEDATA_STORAGE_DIRECTORY/avatars`). Shared with `routes/me.js`'s
 * self-service avatar upload — both write into the same directory.
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
 * JSON responses, mirroring `avatarUploadErrorHandler` in `routes/me.js`.
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

/**
 * Fields an authenticated caller may change on another user's profile
 * through `PATCH /api/v1/users/:id/profile`. Deliberately narrower than
 * `parseMeUpdate` in `routes/me.js` (no `email`) — this route is for
 * self/moderator/admin display-facing edits, not account/security settings.
 *
 * @param {unknown} body Parsed request body.
 * @returns {{ok: true, updates: Record<string, unknown>}|{ok: false, message: string}}
 *   Validated updates or a validation error.
 */
function parseUserProfileUpdate(body) {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, message: "Request body must be an object." };
  }

  const updates = {};

  if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
    const displayNameRaw = body.displayName;
    updates.displayName =
      displayNameRaw === null || displayNameRaw === undefined
        ? null
        : String(displayNameRaw).trim() || null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "bio")) {
    const bioRaw = body.bio;
    updates.bio = bioRaw === null || bioRaw === undefined ? null : String(bioRaw).trim() || null;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, message: "No editable fields provided." };
  }

  return { ok: true, updates };
}

/**
 * Returns true when the caller may manage the given target user's profile
 * resources (banner, avatar, displayName/bio): the target themselves, or a
 * moderator/admin (moderation use case, e.g. removing an inappropriate
 * banner/avatar, or correcting a display name, on another user's profile).
 *
 * @param {import('express').Request} req Incoming request (`req.user`/`req.authRole` set).
 * @param {number} targetUserId Id of the user whose profile is being managed.
 * @returns {boolean} Whether the caller may manage this profile resource.
 */
function canManageUserProfile(req, targetUserId) {
  return Number(req.user.id) === Number(targetUserId) || isModeratorOrAdmin(req.authRole);
}

/**
 * Query-param values accepted by the `sort` param on the user-videos
 * listing endpoints, mapped to the `[VideoMetadata column, direction]` pair
 * used to build the Sequelize `order` clause. Mirrors the vocabulary already
 * used by `routes/search.js`'s `SORT_OPTIONS` (minus `relevance`, which has
 * no meaning outside full-text search).
 *
 * @type {Record<string, [string, "ASC"|"DESC"]>}
 */
const USER_VIDEOS_SORT_OPTIONS = {
  newest: ["createdAt", "DESC"],
  oldest: ["createdAt", "ASC"],
  views: ["viewCount", "DESC"],
};

/**
 * Parses and validates the `sort` query param for the user-videos listing
 * endpoints.
 *
 * @param {import('express').Request['query']} query Raw Express query object.
 * @returns {{ok: true, sort: string}|{ok: false, message: string}} Parsed sort key or an error.
 */
function parseUserVideosSort(query) {
  const sortKey = typeof query.sort === "string" ? query.sort.trim() : "newest";
  if (!Object.prototype.hasOwnProperty.call(USER_VIDEOS_SORT_OPTIONS, sortKey)) {
    return {
      ok: false,
      message: `sort must be one of: ${Object.keys(USER_VIDEOS_SORT_OPTIONS).join(", ")}.`,
    };
  }
  return { ok: true, sort: sortKey };
}

/**
 * Sends a standard 404 for an unknown username or missing image.
 *
 * @param {import('express').Response} res Express response.
 * @param {string} [message="Avatar not found."] Response message.
 * @returns {void}
 */
function sendNotFound(res, message = "Avatar not found.") {
  res.status(404).json({ error: "not_found", message });
}

/**
 * Parses a route `:id` param as a positive integer primary key.
 *
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
 * Loads a user by username, including Role, for channel-facing lookups.
 * Returns null when the user is missing or locked (banned users' channels are
 * not browsable).
 *
 * @param {string} username Requested username.
 * @returns {Promise<import('sequelize').Model|null>} The user row, or null.
 */
async function findVisibleUserByUsername(username) {
  const user = await User.findOne({
    where: { username },
    include: [{ model: Role, required: false }],
  });
  if (!user || user.Role?.name === "locked") {
    return null;
  }
  return user;
}

/**
 * Maps a User instance to the public channel-profile shape. `emailVerified`
 * and `uploader` are only included for the owner or an admin viewer — not
 * public info.
 *
 * @param {import('sequelize').Model} user User model instance.
 * @param {{isPrivileged?: boolean, subscriberCount?: number}} [options] `isPrivileged`: owner-or-admin
 *   viewer. `subscriberCount`: total number of subscribers, precomputed by the caller.
 * @returns {{id: number, username: string, displayName: string|null, bio: string|null, avatarFilename: string|null, bannerFilename: string|null, role: string|null, subscriberCount: number, emailVerified?: boolean, uploader?: boolean}}
 *   Public-safe channel profile payload.
 */
function serializeChannelUser(user, { isPrivileged = false, subscriberCount = 0 } = {}) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    bio: user.bio ?? null,
    avatarFilename: user.avatarFilename ?? null,
    bannerFilename: user.bannerFilename ?? null,
    role: user.Role?.name ?? null,
    subscriberCount,
    ...(isPrivileged
      ? { emailVerified: Boolean(user.emailVerified), uploader: Boolean(user.uploader) }
      : {}),
  };
}

/**
 * Loads a paginated page of a user's videos, sorted per `sort`. `public`
 * videos are always included in the listing. When `isPrivileged` (the caller
 * is this channel's owner, or an admin), every visibility is included.
 * Otherwise, `private` videos are included only when the viewer holds a
 * matching `VIDEO_ACCESS` grant; `unlisted`/`hidden` videos never appear in
 * this listing for non-privileged viewers — `unlisted` is watchable via a
 * direct link (see `canViewVideo` in `lib/video-access.js`) but deliberately
 * excluded from channel listings, which is a distinct concern from watch
 * access. Independent of `isPrivileged`, videos `viewerUserId` has personally
 * hidden (USER_HIDDEN_VIDEOS, see `lib/video-hidden.js`) are always excluded.
 *
 * @param {number} userId Target user's id.
 * @param {{page: number, limit: number}} pagination Parsed pagination.
 * @param {{isPrivileged?: boolean, viewerUserId?: number|null, viewerUser?: import('sequelize').Model|null, viewerRole?: import('sequelize').Model|null, sort?: string}} [options]
 *   `isPrivileged`: owner-or-admin, unlocks every visibility. `viewerUserId`: authenticated
 *   viewer's id, used to look up access grants. `viewerUser`/`viewerRole`: authenticated caller,
 *   used to attach each item's `viewerPermission`. `sort`: one of `USER_VIDEOS_SORT_OPTIONS`.
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 *   Paginated video list envelope.
 */
async function loadUserPublicVideosPage(
  userId,
  pagination,
  { isPrivileged = false, viewerUserId = null, viewerUser = null, viewerRole = null, sort = "newest" } = {},
) {
  const { page, limit } = pagination;

  let visibilityOr;
  if (isPrivileged) {
    visibilityOr = [{ "$VideoMetadata.visibility$": { [Op.in]: ["public", "private", "unlisted", "hidden"] } }];
  } else {
    visibilityOr = [{ "$VideoMetadata.visibility$": "public" }];
    if (viewerUserId != null) {
      const grants = await VideoAccess.findAll({
        where: { userId: viewerUserId },
        attributes: ["originalUploadId"],
      });
      const grantedUploadIds = grants.map((grant) => grant.originalUploadId);
      if (grantedUploadIds.length > 0) {
        visibilityOr.push({
          [Op.and]: [
            { "$VideoMetadata.visibility$": "private" },
            { id: { [Op.in]: grantedUploadIds } },
          ],
        });
      }
    }
  }

  const [sortColumn, sortDirection] = USER_VIDEOS_SORT_OPTIONS[sort];

  const where = { userId, [Op.or]: visibilityOr };
  if (viewerUserId != null) {
    const hiddenUploadIds = await loadHiddenUploadIds(viewerUserId);
    if (hiddenUploadIds.size > 0) {
      where.id = { [Op.notIn]: [...hiddenUploadIds] };
    }
  }

  const { rows, count } = await OriginalUpload.findAndCountAll({
    where,
    include: [
      { model: VideoMetadata, as: "VideoMetadata", required: true },
      { model: VideoThumbnail, required: false },
      { model: User, required: false },
    ],
    order: [[{ model: VideoMetadata, as: "VideoMetadata" }, sortColumn, sortDirection]],
    limit,
    offset: (page - 1) * limit,
    subQuery: false,
  });

  const uploadIds = rows.map((upload) => upload.id);
  const tagsByUploadId = await loadTagsByUploadId(uploadIds);
  const reactionCountsByUploadId = await loadReactionCountsByUploadId(uploadIds);
  // isPrivileged means the viewer is either this channel's owner or an admin,
  // so every video on the channel is "owner"-level for them - no need for a
  // per-video grant lookup in that case.
  const viewerPermissionByUploadId = isPrivileged
    ? new Map(rows.map((upload) => [upload.id, "owner"]))
    : await loadViewerPermissionsByUploadId(rows, viewerUser, viewerRole);

  return {
    items: rows.map((upload) =>
      serializeVideo(upload, upload.VideoMetadata, {
        tags: tagsByUploadId.get(upload.id) || [],
        viewerPermission: viewerPermissionByUploadId.get(upload.id),
        ...reactionCountsByUploadId.get(upload.id),
      }),
    ),
    page,
    limit,
    totalHits: count,
    totalPages: count === 0 ? 0 : Math.ceil(count / limit),
  };
}

/**
 * Counts each user's `public` uploads, scoped to a specific set of user ids.
 * Run as a separate query (rather than an outer-joined aggregate on the main
 * user query) to sidestep the classic Sequelize outer-join-with-`where`
 * pitfall, where filtering the joined table's `where` clause silently turns
 * the join into an inner join and drops zero-count rows.
 *
 * @param {number[]} userIds User ids to count uploads for.
 * @returns {Promise<Map<number, number>>} Map of userId to public upload count.
 */
export async function loadUploadCountsByUserId(userIds) {
  if (userIds.length === 0) {
    return new Map();
  }

  const rows = await OriginalUpload.findAll({
    where: { userId: { [Op.in]: userIds } },
    include: [
      {
        model: VideoMetadata,
        as: "VideoMetadata",
        required: true,
        attributes: [],
        where: { visibility: "public" },
      },
    ],
    attributes: ["userId", [fn("COUNT", col("OriginalUpload.id")), "uploadCount"]],
    group: [col("OriginalUpload.user_id")],
    raw: true,
  });

  return new Map(rows.map((row) => [row.userId, Number(row.uploadCount)]));
}

/**
 * Maps a User instance to the trimmed users-list row shape. `emailVerified`,
 * `uploader`, and `role` are only included for an admin caller — not public
 * info.
 *
 * @param {import('sequelize').Model} user User model instance (with Role included).
 * @param {{isAdminCaller?: boolean, uploadCount?: number}} [options] Serialization options.
 * @returns {{id: number, username: string, displayName: string|null, bio: string|null, avatarFilename: string|null, uploadCount: number, emailVerified?: boolean, uploader?: boolean, role?: string|null}}
 *   Users-list row payload.
 */
export function serializeUserListItem(user, { isAdminCaller = false, uploadCount = 0 } = {}) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    bio: user.bio ?? null,
    avatarFilename: user.avatarFilename ?? null,
    uploadCount,
    ...(isAdminCaller
      ? {
          emailVerified: Boolean(user.emailVerified),
          uploader: Boolean(user.uploader),
          role: user.Role?.name ?? null,
        }
      : {}),
  };
}

/**
 * Builds the public users router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured users router.
 */
export function createUsersRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Returns every non-locked user, alphabetically by username, with a public
   * upload count. `emailVerified`/`uploader`/`role` are included only for an
   * admin caller.
   * GET /api/v1/users
   * Auth: optional — unlocks `emailVerified`/`uploader`/`role` fields for admins.
   *
   * @openapi
   * /api/v1/users:
   *   get:
   *     tags: [Users]
   *     summary: List all users, alphabetically by username
   *     operationId: listUsers
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
   *       "200":
   *         description: Paginated user list
   *       "400":
   *         description: Invalid page/limit
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated user list or an error response.
   */
  router.get("/users", optionalAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { rows, count } = await User.findAndCountAll({
        include: [{ model: Role, required: false }],
        order: [["username", "ASC"]],
        limit,
        offset: (page - 1) * limit,
      });
      const visibleRows = rows.filter((user) => user.Role?.name !== "locked");

      const uploadCounts = await loadUploadCountsByUserId(visibleRows.map((user) => user.id));
      const isAdminCaller = isAdmin(req.authRole);

      res.status(200).json({
        items: visibleRows.map((user) =>
          serializeUserListItem(user, {
            isAdminCaller,
            uploadCount: uploadCounts.get(user.id) ?? 0,
          }),
        ),
        page,
        limit,
        totalHits: count,
        totalPages: count === 0 ? 0 : Math.ceil(count / limit),
      });
    } catch (err) {
      console.error("listUsers failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list users.",
      });
    }
  });

  /**
   * Returns a user's public channel profile plus a paginated, sortable page
   * of their videos. `public`/`unlisted` videos are always included; the
   * channel owner (or an admin) viewing the channel also sees their
   * `private`/`hidden` videos; other authenticated viewers additionally see
   * `private` videos they hold a VIDEO_ACCESS grant for.
   * GET /api/v1/users/:username
   * Auth: optional — unlocks the owner's/admin's full visibility and
   * access-granted private videos for other authenticated viewers.
   *
   * @openapi
   * /api/v1/users/{username}:
   *   get:
   *     tags: [Users]
   *     summary: Get a user's public channel profile and videos
   *     operationId: getUserChannel
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
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
   *       - name: sort
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *           enum: [newest, oldest, views]
   *           default: newest
   *     responses:
   *       "200":
   *         description: Channel profile and a paginated page of visible videos
   *       "400":
   *         description: Invalid page/limit/sort
   *       "404":
   *         description: Unknown username
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the channel profile or an error response.
   */
  router.get("/users/:username", optionalAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const sortResult = parseUserVideosSort(req.query);
      if (!sortResult.ok) {
        res.status(400).json({ error: "invalid_query", message: sortResult.message });
        return;
      }

      const user = await findVisibleUserByUsername(req.params.username);
      if (!user) {
        res.status(404).json({ error: "not_found", message: "Unknown username." });
        return;
      }

      const isSelf = req.user?.id != null && Number(req.user.id) === Number(user.id);
      const isPrivileged = isSelf || isAdmin(req.authRole);
      const [videos, subscriberCount] = await Promise.all([
        loadUserPublicVideosPage(user.id, pagination, {
          isPrivileged,
          viewerUserId: req.user?.id ?? null,
          viewerUser: req.user ?? null,
          viewerRole: req.authRole ?? null,
          sort: sortResult.sort,
        }),
        Subscription.count({ where: { subscribedToId: user.id } }),
      ]);
      res.status(200).json({ user: serializeChannelUser(user, { isPrivileged, subscriberCount }), videos });
    } catch (err) {
      console.error("getUserChannel failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load channel.",
      });
    }
  });

  /**
   * Returns a paginated, sortable list of a user's videos. `public`/
   * `unlisted` videos are always included; the channel owner (or an admin)
   * also sees their `private`/`hidden` videos; other authenticated viewers
   * additionally see `private` videos they hold a VIDEO_ACCESS grant for.
   * GET /api/v1/users/:username/videos
   * Auth: optional — unlocks the owner's/admin's full visibility and
   * access-granted private videos for other authenticated viewers.
   *
   * @openapi
   * /api/v1/users/{username}/videos:
   *   get:
   *     tags: [Users]
   *     summary: List a user's public videos
   *     operationId: listUserVideos
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
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
   *       - name: sort
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *           enum: [newest, oldest, views]
   *           default: newest
   *     responses:
   *       "200":
   *         description: Paginated list of the user's visible videos
   *       "400":
   *         description: Invalid page/limit/sort
   *       "404":
   *         description: Unknown username
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated video list or an error response.
   */
  router.get("/users/:username/videos", optionalAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const sortResult = parseUserVideosSort(req.query);
      if (!sortResult.ok) {
        res.status(400).json({ error: "invalid_query", message: sortResult.message });
        return;
      }

      const user = await findVisibleUserByUsername(req.params.username);
      if (!user) {
        res.status(404).json({ error: "not_found", message: "Unknown username." });
        return;
      }

      const isSelf = req.user?.id != null && Number(req.user.id) === Number(user.id);
      const isPrivileged = isSelf || isAdmin(req.authRole);
      const videos = await loadUserPublicVideosPage(user.id, pagination, {
        isPrivileged,
        viewerUserId: req.user?.id ?? null,
        viewerUser: req.user ?? null,
        viewerRole: req.authRole ?? null,
        sort: sortResult.sort,
      });
      res.status(200).json(videos);
    } catch (err) {
      console.error("listUserVideos failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list user's videos.",
      });
    }
  });

  /**
   * Returns a paginated list of a user's playlists. `public` playlists are
   * always included; the channel owner (or an admin) also sees their
   * `private`/`unlisted`/`hidden` playlists; other authenticated viewers
   * additionally see `private` playlists they hold a PLAYLIST_ACCESS grant
   * for. `unlisted`/`hidden` playlists are never included in this listing for
   * non-privileged viewers — same listing-vs-watch-access carve-out as
   * `GET /playlists` and `listUserVideos`.
   * GET /api/v1/users/:username/playlists
   * Auth: optional — unlocks the owner's/admin's full visibility and
   * access-granted private playlists for other authenticated viewers.
   *
   * @openapi
   * /api/v1/users/{username}/playlists:
   *   get:
   *     tags: [Users]
   *     summary: List a user's playlists
   *     operationId: listUserPlaylists
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
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
   *       "200":
   *         description: Paginated list of the user's visible playlists
   *       "400":
   *         description: Invalid page/limit
   *       "404":
   *         description: Unknown username
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated playlist list or an error response.
   */
  router.get("/users/:username/playlists", optionalAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }

      const user = await findVisibleUserByUsername(req.params.username);
      if (!user) {
        res.status(404).json({ error: "not_found", message: "Unknown username." });
        return;
      }

      const isSelf = req.user?.id != null && Number(req.user.id) === Number(user.id);
      const isPrivileged = isSelf || isAdmin(req.authRole);

      const orConditions = isPrivileged
        ? [{ visibility: { [Op.in]: ["public", "private", "unlisted", "hidden"] } }]
        : [{ visibility: "public" }];
      if (!isPrivileged && req.user) {
        const grants = await PlaylistAccess.findAll({
          where: { userId: req.user.id },
          attributes: ["playlistId"],
        });
        const grantedIds = grants.map((grant) => grant.playlistId);
        if (grantedIds.length > 0) {
          orConditions.push({ id: { [Op.in]: grantedIds }, visibility: "private" });
        }
      }

      const { page, limit } = pagination;
      const { rows, count } = await UserPlaylist.findAndCountAll({
        where: { userId: user.id, [Op.or]: orConditions },
        include: [{ model: User, required: false }],
        order: [["createdAt", "DESC"]],
        limit,
        offset: (page - 1) * limit,
      });

      const payload = await buildPlaylistsPage(rows, count, {
        page,
        limit,
        user: req.user,
        role: req.authRole,
      });
      res.status(200).json(payload);
    } catch (err) {
      console.error("listUserPlaylists failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list user's playlists.",
      });
    }
  });

  /**
   * Subscribes the authenticated user to another user's channel. Idempotent.
   * POST /api/v1/users/:id/subscribe
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/users/{id}/subscribe:
   *   post:
   *     tags: [Users]
   *     summary: Subscribe to a user's channel
   *     operationId: subscribeToUser
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Subscribed (or already subscribed)
   *       "400":
   *         description: Invalid id, or attempting to subscribe to yourself
   *       "401":
   *         description: Not authenticated
   *       "404":
   *         description: Unknown user id
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the subscription state or an error response.
   */
  router.post("/users/:id/subscribe", requireAuth, requireApiKeyScope("profile_edit"), async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }
      if (targetId === Number(req.user.id)) {
        res.status(400).json({
          error: "invalid_body",
          message: "You cannot subscribe to yourself.",
        });
        return;
      }

      const targetUser = await User.findByPk(targetId);
      if (!targetUser) {
        res.status(404).json({ error: "not_found", message: "Unknown user id." });
        return;
      }

      const [, created] = await Subscription.findOrCreate({
        where: { subscriberId: req.user.id, subscribedToId: targetId },
      });
      if (created) {
        await createNotification({
          recipientUserId: targetId,
          actorUserId: req.user.id,
          typeName: "subscriber",
          title: "New Subscriber",
          message: "You have a new subscriber!",
          target: "subscribers",
          link: buildPublicLink("/subscribers"),
        });
      }

      res.status(200).json({ subscribed: true });
    } catch (err) {
      console.error("subscribeToUser failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to subscribe.",
      });
    }
  });

  /**
   * Unsubscribes the authenticated user from another user's channel. Idempotent.
   * DELETE /api/v1/users/:id/subscribe
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/users/{id}/subscribe:
   *   delete:
   *     tags: [Users]
   *     summary: Unsubscribe from a user's channel
   *     operationId: unsubscribeFromUser
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Unsubscribed (or was already not subscribed)
   *       "400":
   *         description: Invalid id
   *       "401":
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the subscription state or an error response.
   */
  router.delete("/users/:id/subscribe", requireAuth, requireApiKeyScope("profile_edit"), async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      await Subscription.destroy({
        where: { subscriberId: req.user.id, subscribedToId: targetId },
      });

      res.status(200).json({ subscribed: false });
    } catch (err) {
      console.error("unsubscribeFromUser failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to unsubscribe.",
      });
    }
  });

  /**
   * Returns whether the authenticated user is subscribed to another user.
   * GET /api/v1/users/:id/subscription
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/users/{id}/subscription:
   *   get:
   *     tags: [Users]
   *     summary: Get my subscription state for a user
   *     operationId: getSubscriptionState
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Subscription state
   *       "400":
   *         description: Invalid id
   *       "401":
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the subscription state or an error response.
   */
  router.get("/users/:id/subscription", requireAuth, async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const subscription = await Subscription.findOne({
        where: { subscriberId: req.user.id, subscribedToId: targetId },
      });

      res.status(200).json({ subscribed: Boolean(subscription) });
    } catch (err) {
      console.error("getSubscriptionState failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load subscription state.",
      });
    }
  });

  /**
   * Locks a user's account (sets their role to `locked`), preventing them
   * from authenticating. Admin only.
   * POST /api/v1/users/:id/ban
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/users/{id}/ban:
   *   post:
   *     tags: [Users]
   *     summary: Ban (lock) a user's account
   *     operationId: banUser
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: User banned (role set to locked)
   *       "400":
   *         description: Invalid id, or attempting to ban yourself
   *       "401":
   *         description: Not authenticated
   *       "403":
   *         description: Admin access required
   *       "404":
   *         description: Unknown user id
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated user's role or an error response.
   */
  router.post("/users/:id/ban", requireAuth, requireAdmin, requireApiKeyScope("full_access"), async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }
      if (targetId === Number(req.user.id)) {
        res.status(400).json({
          error: "invalid_body",
          message: "You cannot ban your own account.",
        });
        return;
      }

      const targetUser = await User.findByPk(targetId);
      if (!targetUser) {
        res.status(404).json({ error: "not_found", message: "Unknown user id." });
        return;
      }

      const lockedRole = await Role.findOne({ where: { name: "locked" } });
      await targetUser.update({ roleId: lockedRole.id });

      res.status(200).json({ id: targetUser.id, username: targetUser.username, role: "locked" });
    } catch (err) {
      console.error("banUser failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to ban user.",
      });
    }
  });

  /**
   * Unbans a user's account (sets their role to `viewer`). Admin only.
   * DELETE /api/v1/users/:id/ban
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/users/{id}/ban:
   *   delete:
   *     tags: [Users]
   *     summary: Unban a user's account
   *     operationId: unbanUser
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: User unbanned (role set to viewer)
   *       "400":
   *         description: Invalid id
   *       "401":
   *         description: Not authenticated
   *       "403":
   *         description: Admin access required
   *       "404":
   *         description: Unknown user id
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated user's role or an error response.
   */
  router.delete("/users/:id/ban", requireAuth, requireAdmin, requireApiKeyScope("full_access"), async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const targetUser = await User.findByPk(targetId);
      if (!targetUser) {
        res.status(404).json({ error: "not_found", message: "Unknown user id." });
        return;
      }

      const viewerRole = await Role.findOne({ where: { name: "viewer" } });
      await targetUser.update({ roleId: viewerRole.id });

      res.status(200).json({ id: targetUser.id, username: targetUser.username, role: "viewer" });
    } catch (err) {
      console.error("unbanUser failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to unban user.",
      });
    }
  });

  /**
   * Serves a user's avatar image by username. Public; no auth required.
   * GET /api/v1/users/:username/avatar
   *
   * @openapi
   * /api/v1/users/{username}/avatar:
   *   get:
   *     tags: [Users]
   *     summary: Get a user's avatar image
   *     operationId: getUserAvatar
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       "200":
   *         description: Avatar image
   *       "404":
   *         description: Unknown username, or no avatar set
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Streams the avatar image or sends a 404.
   */
  router.get("/users/:username/avatar", async (req, res) => {
    try {
      const user = await User.findOne({ where: { username: req.params.username } });
      if (!user || !user.avatarFilename) {
        sendNotFound(res);
        return;
      }

      const absolutePath = resolveSitedataPath(join("avatars", user.avatarFilename));
      const contentType = mimeTypeForImage(user.avatarFilename);
      await streamFileWithRangeSupport(req, res, absolutePath, contentType);
    } catch (err) {
      console.error("getUserAvatar failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: "Failed to load avatar.",
        });
      }
    }
  });

  /**
   * Uploads (or replaces) a user's banner image. Usable by the profile owner
   * or a moderator/admin (moderation use case, e.g. removing an
   * inappropriate banner). Deletes the previous banner file from disk, if
   * any, after the new one is persisted.
   * POST /api/v1/users/:id/banner — multipart `file`.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/users/{id}/banner:
   *   post:
   *     tags: [Users]
   *     summary: Upload or replace a user's banner image
   *     operationId: updateUserBanner
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
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
   *       "200":
   *         description: Banner updated
   *       "400":
   *         description: Invalid id, missing file, or unsupported file type
   *       "401":
   *         description: Not authenticated
   *       "403":
   *         description: Not the profile owner and not a moderator/admin
   *       "404":
   *         description: Unknown user id
   *       "413":
   *         description: File too large
   *   delete:
   *     tags: [Users]
   *     summary: Remove a user's banner image
   *     operationId: deleteUserBanner
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       "200":
   *         description: Banner removed (idempotent; also returned when no banner was set)
   *       "400":
   *         description: Invalid id
   *       "401":
   *         description: Not authenticated
   *       "403":
   *         description: Not the profile owner and not a moderator/admin
   *       "404":
   *         description: Unknown user id
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated banner filename or an error response.
   */
  router.post("/users/:id/banner", requireAuth, requireApiKeyScope("profile_edit"), bannerUpload.single("file"), async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        if (req.file) {
          await unlink(join(bannersDir, req.file.filename)).catch(() => {});
        }
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }
      if (!canManageUserProfile(req, targetId)) {
        if (req.file) {
          await unlink(join(bannersDir, req.file.filename)).catch(() => {});
        }
        res.status(403).json({
          error: "forbidden",
          message: "You cannot manage this user's banner.",
        });
        return;
      }

      const targetUser = await User.findByPk(targetId);
      if (!targetUser) {
        if (req.file) {
          await unlink(join(bannersDir, req.file.filename)).catch(() => {});
        }
        res.status(404).json({ error: "not_found", message: "Unknown user id." });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "invalid_body", message: "file is required." });
        return;
      }

      const previousBannerFilename = targetUser.bannerFilename;

      try {
        await targetUser.update({ bannerFilename: req.file.filename });
      } catch (err) {
        await unlink(join(bannersDir, req.file.filename)).catch(() => {});
        throw err;
      }

      if (previousBannerFilename && previousBannerFilename !== req.file.filename) {
        await unlink(join(bannersDir, previousBannerFilename)).catch(() => {});
      }

      res.status(200).json({ bannerFilename: targetUser.bannerFilename });
    } catch (err) {
      console.error("updateUserBanner failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update banner.",
      });
    }
  });
  router.use(bannerUploadErrorHandler);

  /**
   * Removes a user's banner image, deleting the file from disk (best-effort)
   * and clearing the column. Usable by the profile owner or a
   * moderator/admin. Idempotent.
   * DELETE /api/v1/users/:id/banner
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }` or an error response.
   */
  router.delete("/users/:id/banner", requireAuth, requireApiKeyScope("profile_edit"), async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }
      if (!canManageUserProfile(req, targetId)) {
        res.status(403).json({
          error: "forbidden",
          message: "You cannot manage this user's banner.",
        });
        return;
      }

      const targetUser = await User.findByPk(targetId);
      if (!targetUser) {
        res.status(404).json({ error: "not_found", message: "Unknown user id." });
        return;
      }

      if (targetUser.bannerFilename) {
        await unlink(join(bannersDir, targetUser.bannerFilename)).catch(() => {});
        await targetUser.update({ bannerFilename: null });
      }
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("deleteUserBanner failed:", err);
      res.status(500).json({
        success: false,
        error: "internal_error",
        message: "Failed to remove banner.",
      });
    }
  });

  /**
   * Serves a user's banner image by username. Public; no auth required.
   * GET /api/v1/users/:username/banner
   *
   * @openapi
   * /api/v1/users/{username}/banner:
   *   get:
   *     tags: [Users]
   *     summary: Get a user's banner image
   *     operationId: getUserBanner
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       "200":
   *         description: Banner image
   *       "404":
   *         description: Unknown username, or no banner set
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Streams the banner image or sends a 404.
   */
  router.get("/users/:username/banner", async (req, res) => {
    try {
      const user = await User.findOne({ where: { username: req.params.username } });
      if (!user || !user.bannerFilename) {
        sendNotFound(res, "Banner not found.");
        return;
      }

      const absolutePath = resolveSitedataPath(join("banners", user.bannerFilename));
      const contentType = mimeTypeForImage(user.bannerFilename);
      await streamFileWithRangeSupport(req, res, absolutePath, contentType);
    } catch (err) {
      console.error("getUserBanner failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: "Failed to load banner.",
        });
      }
    }
  });

  /**
   * Uploads (or replaces) a user's avatar image. Usable by the profile owner
   * or a moderator/admin. Deletes the previous avatar file from disk, if
   * any, after the new one is persisted.
   * POST /api/v1/users/:id/avatar — multipart `file`.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/users/{id}/avatar:
   *   post:
   *     tags: [Users]
   *     summary: Upload or replace a user's avatar image
   *     operationId: updateUserAvatar
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
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
   *       "200":
   *         description: Avatar updated
   *       "400":
   *         description: Invalid id, missing file, or unsupported file type
   *       "401":
   *         description: Not authenticated
   *       "403":
   *         description: Not the profile owner and not a moderator/admin
   *       "404":
   *         description: Unknown user id
   *       "413":
   *         description: File too large
   *   delete:
   *     tags: [Users]
   *     summary: Remove a user's avatar image
   *     operationId: deleteUserAvatar
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       "200":
   *         description: Avatar removed (idempotent; also returned when no avatar was set)
   *       "400":
   *         description: Invalid id
   *       "401":
   *         description: Not authenticated
   *       "403":
   *         description: Not the profile owner and not a moderator/admin
   *       "404":
   *         description: Unknown user id
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated avatar filename or an error response.
   */
  router.post("/users/:id/avatar", requireAuth, requireApiKeyScope("profile_edit"), avatarUpload.single("file"), async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        if (req.file) {
          await unlink(join(avatarsDir, req.file.filename)).catch(() => {});
        }
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }
      if (!canManageUserProfile(req, targetId)) {
        if (req.file) {
          await unlink(join(avatarsDir, req.file.filename)).catch(() => {});
        }
        res.status(403).json({
          error: "forbidden",
          message: "You cannot manage this user's avatar.",
        });
        return;
      }

      const targetUser = await User.findByPk(targetId);
      if (!targetUser) {
        if (req.file) {
          await unlink(join(avatarsDir, req.file.filename)).catch(() => {});
        }
        res.status(404).json({ error: "not_found", message: "Unknown user id." });
        return;
      }
      if (!req.file) {
        res.status(400).json({ error: "invalid_body", message: "file is required." });
        return;
      }

      const previousAvatarFilename = targetUser.avatarFilename;

      try {
        await targetUser.update({ avatarFilename: req.file.filename });
      } catch (err) {
        await unlink(join(avatarsDir, req.file.filename)).catch(() => {});
        throw err;
      }

      if (previousAvatarFilename && previousAvatarFilename !== req.file.filename) {
        await unlink(join(avatarsDir, previousAvatarFilename)).catch(() => {});
      }

      res.status(200).json({ avatarFilename: targetUser.avatarFilename });
    } catch (err) {
      console.error("updateUserAvatar failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update avatar.",
      });
    }
  });
  router.use(avatarUploadErrorHandler);

  /**
   * Removes a user's avatar image, deleting the file from disk (best-effort)
   * and clearing the column. Usable by the profile owner or a
   * moderator/admin. Idempotent.
   * DELETE /api/v1/users/:id/avatar
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }` or an error response.
   */
  router.delete("/users/:id/avatar", requireAuth, requireApiKeyScope("profile_edit"), async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }
      if (!canManageUserProfile(req, targetId)) {
        res.status(403).json({
          error: "forbidden",
          message: "You cannot manage this user's avatar.",
        });
        return;
      }

      const targetUser = await User.findByPk(targetId);
      if (!targetUser) {
        res.status(404).json({ error: "not_found", message: "Unknown user id." });
        return;
      }

      if (targetUser.avatarFilename) {
        await unlink(join(avatarsDir, targetUser.avatarFilename)).catch(() => {});
        await targetUser.update({ avatarFilename: null });
      }
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("deleteUserAvatar failed:", err);
      res.status(500).json({
        success: false,
        error: "internal_error",
        message: "Failed to remove avatar.",
      });
    }
  });

  /**
   * Updates a user's display-facing profile fields (`displayName`, `bio`).
   * Usable by the profile owner or a moderator/admin.
   * PATCH /api/v1/users/:id/profile
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/users/{id}/profile:
   *   patch:
   *     tags: [Users]
   *     summary: Update a user's display name and/or bio
   *     operationId: updateUserProfile
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
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
   *               displayName:
   *                 type: string
   *                 nullable: true
   *               bio:
   *                 type: string
   *                 nullable: true
   *     responses:
   *       "200":
   *         description: Updated profile fields
   *       "400":
   *         description: Invalid id or request body
   *       "401":
   *         description: Not authenticated
   *       "403":
   *         description: Not the profile owner and not a moderator/admin
   *       "404":
   *         description: Unknown user id
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated displayName/bio or an error response.
   */
  router.patch("/users/:id/profile", requireAuth, requireApiKeyScope("profile_edit"), async (req, res) => {
    try {
      const targetId = parsePositiveInt(req.params.id);
      if (targetId === null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }
      if (!canManageUserProfile(req, targetId)) {
        res.status(403).json({
          error: "forbidden",
          message: "You cannot manage this user's profile.",
        });
        return;
      }

      const targetUser = await User.findByPk(targetId);
      if (!targetUser) {
        res.status(404).json({ error: "not_found", message: "Unknown user id." });
        return;
      }

      const parsed = parseUserProfileUpdate(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: "invalid_body", message: parsed.message });
        return;
      }

      await targetUser.update(parsed.updates);

      if (Object.prototype.hasOwnProperty.call(parsed.updates, "displayName")) {
        syncUserIndex(targetUser.id);
        const playlists = await UserPlaylist.findAll({
          where: { userId: targetUser.id, visibility: "public" },
          attributes: ["id"],
        });
        for (const playlist of playlists) {
          syncPlaylistIndex(playlist.id);
        }
      }

      res.status(200).json({
        id: targetUser.id,
        username: targetUser.username,
        displayName: targetUser.displayName,
        bio: targetUser.bio,
      });
    } catch (err) {
      console.error("updateUserProfile failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update profile.",
      });
    }
  });

  return router;
}
