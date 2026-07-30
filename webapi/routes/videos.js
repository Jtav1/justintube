import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Router } from "express";
import multer from "multer";
import { Op, literal } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { optionalAuth, requireAuth } from "../lib/auth/require-auth.js";
import { requireModerator } from "../lib/auth/require-moderator.js";
import { mimeTypeForImage, resolveMediaPath } from "../lib/media-meta.js";
import { VISIBILITY_VALUES } from "../lib/models/constants.js";
import {
  Comment,
  ContentTag,
  FeaturedVideo,
  FileVersion,
  OriginalUpload,
  Subscription,
  User,
  UserViewHistory,
  VideoAccess,
  VideoLike,
  VideoMetadata,
  VideoThumbnail,
  sequelize,
} from "../lib/models/index.js";
import {
  canViewVideo,
  isAdmin,
  isModeratorOrAdmin,
  isOwnerOrAdmin,
} from "../lib/video-access.js";
import { streamFileWithRangeSupport } from "../lib/range-stream.js";
import { removeVideoDocument, syncVideoIndex } from "../lib/search.js";
import { serializeUserRef } from "../lib/serialize-user-ref.js";

/**
 * Relative media subfolder where thumbnail images are expected to live
 * (mirrors the `original/` and `transcoded/` convention). Thumbnail
 * *generation* doesn't exist yet — this is only the serving-side assumption.
 *
 * @type {string}
 */
const THUMBNAILS_SUBDIR = "thumbnails";

/**
 * Absolute path to the directory where thumbnail images live
 * (`MEDIA_STORAGE_DIRECTORY/thumbnails`). Shared with the processing
 * service's auto-generated thumbnails — a manually uploaded thumbnail
 * simply replaces whatever `VIDEO_THUMBNAIL` row/file already exists.
 *
 * @type {string}
 */
const thumbnailsDir = resolveMediaPath(THUMBNAILS_SUBDIR);

// Ensure the thumbnails directory exists before any upload is attempted.
mkdirSync(thumbnailsDir, { recursive: true });

/**
 * Set of allowed lowercase thumbnail file extensions (without a leading
 * dot), parsed from the THUMBNAIL_FILETYPES_ALLOWED env var. Kept in sync
 * with `mimeTypeForImage`'s supported extensions.
 *
 * @type {Set<string>}
 */
const allowedThumbnailExtensions = new Set(
  (process.env.THUMBNAIL_FILETYPES_ALLOWED || "jpg,jpeg,png,webp")
    .split(",")
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean),
);

/**
 * Maximum accepted thumbnail upload size in bytes. Defaults to 5 MiB;
 * override with the MAX_THUMBNAIL_SIZE_BYTES env var.
 *
 * @type {number}
 */
const maxThumbnailSizeBytes =
  Number(process.env.MAX_THUMBNAIL_SIZE_BYTES) || 5 * 1024 * 1024;

/**
 * Normalizes a file's extension to a lowercase value without the leading dot.
 *
 * @private
 * @param {string} filename Original client-provided filename.
 * @returns {string} Lowercase extension without a dot (empty string if none).
 */
function normalizedThumbnailExtension(filename) {
  return extname(filename).toLowerCase().replace(/^\./, "");
}

/**
 * Multer storage engine that writes thumbnail uploads to `thumbnails/`
 * under the media root using a freshly generated UUID as the filename
 * (preserving the original extension).
 */
const thumbnailStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, thumbnailsDir),
  filename: (_req, file, cb) => {
    const ext = normalizedThumbnailExtension(file.originalname);
    cb(null, ext ? `${randomUUID()}.${ext}` : randomUUID());
  },
});

/**
 * Multer file filter that rejects any file whose extension is not present
 * in THUMBNAIL_FILETYPES_ALLOWED.
 *
 * @private
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {Express.Multer.File} file File metadata provided by multer.
 * @param {multer.FileFilterCallback} cb Callback signaling acceptance/rejection.
 * @returns {void} Invokes `cb` with the filter decision.
 */
function thumbnailFileFilter(_req, file, cb) {
  const ext = normalizedThumbnailExtension(file.originalname);
  if (!allowedThumbnailExtensions.has(ext)) {
    const error = new Error(`File type ".${ext}" is not allowed.`);
    error.code = "UNSUPPORTED_FILE_TYPE";
    cb(error);
    return;
  }
  cb(null, true);
}

const thumbnailUpload = multer({
  storage: thumbnailStorage,
  fileFilter: thumbnailFileFilter,
  limits: { fileSize: maxThumbnailSizeBytes },
});

/**
 * Express error-handling middleware that maps thumbnail-upload multer
 * errors to JSON responses, mirroring `avatarUploadErrorHandler` in
 * `routes/users.js`.
 *
 * @param {Error} err Error thrown during thumbnail upload handling.
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Passes non-upload errors along.
 * @returns {void} Sends an error JSON response or delegates via `next`.
 */
function thumbnailUploadErrorHandler(err, _req, res, next) {
  if (err?.code === "UNSUPPORTED_FILE_TYPE") {
    res.status(400).json({
      error: "unsupported_file_type",
      message: err.message,
      allowed: [...allowedThumbnailExtensions],
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
 * Maximum length for video title.
 *
 * @type {number}
 */
const MAX_TITLE_LENGTH = 255;

/**
 * Maximum number of tags accepted on an update.
 *
 * @type {number}
 */
const MAX_TAGS = 50;

/**
 * Maximum length for a single tag string.
 *
 * @type {number}
 */
const MAX_TAG_LENGTH = 255;

/**
 * Maximum length for a comment's body text.
 *
 * @type {number}
 */
const MAX_COMMENT_LENGTH = 2000;

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
 * Serializes an upload + metadata pair for video API responses.
 *
 * @param {import('sequelize').Model} upload ORIGINAL_UPLOADS instance
 *   (expects `VideoThumbnail` preloaded when available; falls back to null).
 * @param {import('sequelize').Model} metadata VIDEO_METADATA instance.
 * @param {object} [options] Extra fields to attach.
 * @param {string[]} [options.tags] This video's CONTENT_TAGS tag strings.
 *   Always attached (empty array when omitted) so every route returns the
 *   same shape.
 * @param {Array<{
 *   id: number,
 *   resolution: string|null,
 *   width: number|null,
 *   height: number|null,
 *   mimeType: string|null,
 *   fileSizeBytes: number|null,
 *   streamUrl: string
 * }>} [options.renditions]
 *   Available complete transcoded copies plus a trailing `"original"` entry
 *   for the untranscoded upload, each carrying a `streamUrl` a video player
 *   can select between (single-video routes only — `getVideo`, `updateVideo`,
 *   `delistVideo` — omitted elsewhere to keep list/search responses
 *   lightweight).
 * @param {"like"|"dislike"|null} [options.viewerReaction] The requesting user's current
 *   reaction, when known. Only attached when explicitly passed (i.e. when the caller looked
 *   it up for an authenticated viewer) — omitted from the payload entirely otherwise.
 * @param {boolean} [options.featured] Whether the video is in FEATURED_VIDEOS. Only attached
 *   when explicitly passed (admin callers on `getVideo`) — omitted otherwise.
 * @returns {{
 *   id: number,
 *   videoId: string,
 *   title: string,
 *   description: string|null,
 *   visibility: string,
 *   commentsEnabled: boolean,
 *   viewCount: number,
 *   uploader: {userId: number|null, username: string|null, displayName: string|null},
 *   tags: string[],
 *   mediaType: string,
 *   durationSeconds: number|null,
 *   thumbnailUrl: string|null,
 *   createdAt: Date,
 *   updatedAt: Date
 * }} Public video payload.
 */
export function serializeVideo(upload, metadata, options = {}) {
  const payload = {
    id: upload.id,
    videoId: upload.videoId,
    title: metadata.title,
    description: metadata.description ?? null,
    visibility: metadata.visibility,
    commentsEnabled: Boolean(metadata.commentsEnabled),
    viewCount: Number(metadata.viewCount ?? 0),
    uploader: serializeUserRef(
      upload.userId,
      upload.User?.username,
      upload.User?.displayName,
    ),
    tags: options.tags ?? [],
    mediaType: upload.mediaType,
    durationSeconds: upload.durationSeconds ?? null,
    thumbnailUrl: upload.VideoThumbnail
      ? `/api/v1/videos/${upload.id}/thumbnail`
      : null,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt,
  };
  if (options.renditions) {
    payload.renditions = options.renditions;
  }
  if (options.viewerReaction !== undefined) {
    payload.viewerReaction = options.viewerReaction;
  }
  if (options.featured !== undefined) {
    payload.featured = options.featured;
  }
  return payload;
}

/**
 * Batch-loads CONTENT_TAGS for a set of uploads, grouped by upload id. Used
 * so every `serializeVideo` call site can attach `tags` without an N+1 query
 * per video.
 *
 * @param {number[]} originalUploadIds Upload ids to load tags for.
 * @returns {Promise<Map<number, string[]>>} Upload id → its tag strings.
 */
export async function loadTagsByUploadId(originalUploadIds) {
  const map = new Map();
  if (originalUploadIds.length === 0) {
    return map;
  }
  const rows = await ContentTag.findAll({
    where: { originalUploadId: { [Op.in]: originalUploadIds } },
    order: [["tag", "ASC"]],
  });
  for (const row of rows) {
    const list = map.get(row.originalUploadId) || [];
    list.push(row.tag);
    map.set(row.originalUploadId, list);
  }
  return map;
}

/**
 * Serializes a complete FILE_VERSIONS row into a rendition reference a video
 * player can use to offer a quality selection, including the URL to request
 * that specific copy via `getVideoStream`.
 *
 * @param {number} originalUploadId Parent ORIGINAL_UPLOADS id.
 * @param {import('sequelize').Model} version Complete FileVersion instance.
 * @returns {{
 *   id: number,
 *   resolution: string|null,
 *   width: number|null,
 *   height: number|null,
 *   mimeType: string|null,
 *   fileSizeBytes: number|null,
 *   streamUrl: string
 * }} Rendition reference.
 */
function serializeFileVersion(originalUploadId, version) {
  const streamUrl = version.resolution
    ? `/api/v1/videos/${originalUploadId}/stream?quality=${encodeURIComponent(version.resolution)}`
    : `/api/v1/videos/${originalUploadId}/stream`;
  return {
    id: version.id,
    resolution: version.resolution,
    width: version.videoWidth,
    height: version.videoHeight,
    mimeType: version.mimeType ?? null,
    fileSizeBytes:
      version.fileSizeBytes != null ? Number(version.fileSizeBytes) : null,
    streamUrl,
  };
}

/**
 * Serializes an ORIGINAL_UPLOADS row itself into a rendition reference, so a
 * video player can offer the untranscoded source as a quality option
 * alongside transcoded renditions. Always labeled `"original"` regardless of
 * the upload's own probed resolution.
 *
 * @param {import('sequelize').Model} upload ORIGINAL_UPLOADS instance.
 * @returns {{
 *   id: number,
 *   resolution: "original",
 *   width: number|null,
 *   height: number|null,
 *   mimeType: string|null,
 *   fileSizeBytes: number|null,
 *   streamUrl: string
 * }} Rendition reference for the original file.
 */
function serializeOriginalRendition(upload) {
  return {
    id: upload.id,
    resolution: "original",
    width: upload.videoWidth,
    height: upload.videoHeight,
    mimeType: upload.mimeType ?? null,
    fileSizeBytes:
      upload.fileSizeBytes != null ? Number(upload.fileSizeBytes) : null,
    streamUrl: `/api/v1/videos/${upload.id}/stream?quality=original`,
  };
}

/**
 * Loads every complete FILE_VERSIONS row for an upload, ordered lowest to
 * highest resolution, and serializes each into a rendition reference,
 * appending the original upload itself as a final `"original"` entry.
 *
 * @param {import('sequelize').Model} upload ORIGINAL_UPLOADS instance.
 * @returns {Promise<object[]>} Serialized renditions, lowest resolution
 *   first, with the original upload last.
 */
async function loadRenditions(upload) {
  const completeVersions = await FileVersion.findAll({
    where: { originalUploadId: upload.id, status: "complete" },
    order: [["videoHeight", "ASC"]],
  });
  const renditions = completeVersions.map((version) =>
    serializeFileVersion(upload.id, version),
  );
  renditions.push(serializeOriginalRendition(upload));
  return renditions;
}

/**
 * Serializes a COMMENTS row for API responses.
 *
 * @param {import('sequelize').Model} comment Comment instance (expects `User` preloaded).
 * @returns {{
 *   id: number,
 *   originalUploadId: number,
 *   parentCommentId: number|null,
 *   author: {userId: number|null, username: string|null, displayName: string|null},
 *   body: string,
 *   distinguishedMod: boolean,
 *   distinguishedAdmin: boolean,
 *   createdAt: Date,
 *   updatedAt: Date
 * }} Public comment payload.
 */
function serializeComment(comment) {
  return {
    id: comment.id,
    originalUploadId: comment.originalUploadId,
    parentCommentId: comment.parentCommentId ?? null,
    author: serializeUserRef(
      comment.userId,
      comment.User?.username,
      comment.User?.displayName,
    ),
    body: comment.body,
    distinguishedMod: Boolean(comment.distinguishedMod),
    distinguishedAdmin: Boolean(comment.distinguishedAdmin),
    createdAt: comment.createdAt,
    updatedAt: comment.updatedAt,
  };
}

/**
 * Loads an upload with its metadata (and thumbnail, when present) by primary key.
 *
 * @param {number} id ORIGINAL_UPLOADS id.
 * @returns {Promise<{upload: import('sequelize').Model, metadata: import('sequelize').Model}|null>}
 *   Pair when both rows exist; otherwise null.
 */
async function loadUploadWithMetadata(id) {
  const upload = await OriginalUpload.findByPk(id, {
    include: [
      { model: VideoMetadata, as: "VideoMetadata", required: true },
      { model: VideoThumbnail, required: false },
      { model: User, required: false },
    ],
  });
  if (!upload || !upload.VideoMetadata) {
    return null;
  }
  return { upload, metadata: upload.VideoMetadata };
}

/**
 * Sets the caller's reaction (like/dislike) on a video, toggling off if the same reaction is
 * already recorded. At most one VIDEO_LIKES row exists per (userId, originalUploadId); this
 * always replaces or removes that row rather than ever storing more than one.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id being reacted to.
 * @param {number} userId Reacting user's id.
 * @param {1|-1} value 1 for like, -1 for dislike.
 * @returns {Promise<{liked: boolean, disliked: boolean}>} Resulting reaction state.
 */
async function toggleVideoReaction(originalUploadId, userId, value) {
  const existing = await VideoLike.findOne({
    where: { originalUploadId, userId },
  });

  if (existing && existing.likeValue === value) {
    await existing.destroy();
    return { liked: false, disliked: false };
  }

  if (existing) {
    await existing.destroy();
  }
  await VideoLike.create({ originalUploadId, userId, likeValue: value });

  return { liked: value === 1, disliked: value === -1 };
}

/**
 * Loads an upload with its metadata (and thumbnail, when present) by its
 * public `videoId`.
 *
 * @param {string} videoId ORIGINAL_UPLOADS videoId.
 * @returns {Promise<{upload: import('sequelize').Model, metadata: import('sequelize').Model}|null>}
 *   Pair when both rows exist; otherwise null.
 */
async function loadUploadWithMetadataByVideoId(videoId) {
  const upload = await OriginalUpload.findOne({
    where: { videoId },
    include: [
      { model: VideoMetadata, as: "VideoMetadata", required: true },
      { model: VideoThumbnail, required: false },
      { model: User, required: false },
    ],
  });
  if (!upload || !upload.VideoMetadata) {
    return null;
  }
  return { upload, metadata: upload.VideoMetadata };
}

/**
 * Loads an upload with its metadata by route identifier, accepting either
 * the numeric primary key or the public `videoId` — lets video page links
 * use the videoId while internal/API-only routes keep using the pk.
 *
 * @param {string} raw Route parameter value.
 * @returns {Promise<{upload: import('sequelize').Model, metadata: import('sequelize').Model}|null>}
 *   Pair when both rows exist; otherwise null.
 */
async function loadUploadWithMetadataByIdentifier(raw) {
  const id = parsePositiveInt(raw);
  if (id != null) {
    return loadUploadWithMetadata(id);
  }
  const videoId = String(raw ?? "").trim();
  if (!videoId) {
    return null;
  }
  return loadUploadWithMetadataByVideoId(videoId);
}

/**
 * Returns whether the given user has a VIDEO_ACCESS grant on the upload.
 *
 * @param {number} originalUploadId Upload id.
 * @param {number|null|undefined} userId Authenticated user id.
 * @returns {Promise<boolean>} True when a grant row exists.
 */
async function userHasAccessGrant(originalUploadId, userId) {
  if (!userId) {
    return false;
  }
  const grant = await VideoAccess.findOne({
    where: { originalUploadId, userId },
  });
  return Boolean(grant);
}

/**
 * Sends 404 when the caller cannot view a private video (or when missing).
 *
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendNotFound(res) {
  res.status(404).json({
    error: "not_found",
    message: "Video not found.",
  });
}

/**
 * Finds videos for a bulk browse/discovery list, optionally filtered and
 * ordered. Public videos are always included; `unlisted`/`hidden`/`private`
 * videos are included for their owner (`options.viewerUserId`); `private`
 * and `hidden` videos are additionally included for any viewer holding a
 * matching VIDEO_ACCESS grant. Everyone else never sees delisted, hidden, or
 * private content in these bulk lists.
 *
 * @param {object} [options] Query options.
 * @param {import('sequelize').WhereOptions} [options.uploadWhere] Extra ORIGINAL_UPLOADS where.
 * @param {import('sequelize').Includeable[]} [options.includes] Extra includes.
 * @param {import('sequelize').Order} [options.order] Order clause.
 * @param {number|null} [options.viewerUserId] Authenticated caller's id, if any.
 * @returns {Promise<object[]>} Serialized video items.
 */
async function listPublicVideos(options = {}) {
  const visibilityOr = [{ "$VideoMetadata.visibility$": "public" }];
  if (options.viewerUserId) {
    visibilityOr.push({
      userId: options.viewerUserId,
      "$VideoMetadata.visibility$": {
        [Op.in]: ["unlisted", "hidden", "private"],
      },
    });

    const grants = await VideoAccess.findAll({
      where: { userId: options.viewerUserId },
      attributes: ["originalUploadId"],
    });
    const grantedUploadIds = grants.map((grant) => grant.originalUploadId);
    if (grantedUploadIds.length > 0) {
      visibilityOr.push({
        id: { [Op.in]: grantedUploadIds },
        "$VideoMetadata.visibility$": { [Op.in]: ["private", "hidden"] },
      });
    }
  }

  const rows = await OriginalUpload.findAll({
    where: {
      ...(options.uploadWhere || {}),
      [Op.or]: visibilityOr,
    },
    include: [
      { model: VideoMetadata, as: "VideoMetadata", required: true },
      { model: VideoThumbnail, required: false },
      { model: User, required: false },
      ...(options.includes || []),
    ],
    order: options.order || [["id", "ASC"]],
  });

  const tagsByUploadId = await loadTagsByUploadId(
    rows.map((upload) => upload.id),
  );
  return rows.map((upload) =>
    serializeVideo(upload, upload.VideoMetadata, {
      tags: tagsByUploadId.get(upload.id) || [],
    }),
  );
}

/**
 * Parses an optional title field.
 *
 * @param {unknown} raw Body title value.
 * @param {boolean} required Whether the field is required when present.
 * @returns {{ok: true, value?: string}|{ok: false, message: string}} Parsed or error.
 */
function parseTitle(raw, required) {
  if (raw === undefined) {
    if (required) {
      return { ok: false, message: "title is required." };
    }
    return { ok: true };
  }
  const title = String(raw ?? "").trim();
  if (!title) {
    return { ok: false, message: "title must be a non-empty string." };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return {
      ok: false,
      message: `title must be at most ${MAX_TITLE_LENGTH} characters.`,
    };
  }
  return { ok: true, value: title };
}

/**
 * Parses an optional description field (null clears).
 *
 * @param {unknown} raw Body description value.
 * @returns {{ok: true, value?: string|null}|{ok: false, message: string}} Parsed or error.
 */
function parseDescription(raw) {
  if (raw === undefined) {
    return { ok: true };
  }
  if (raw === null) {
    return { ok: true, value: null };
  }
  return { ok: true, value: String(raw) };
}

/**
 * Parses an optional visibility field against VISIBILITY_VALUES.
 *
 * @param {unknown} raw Body visibility value.
 * @returns {{ok: true, value?: string}|{ok: false, message: string}} Parsed or error.
 */
function parseVisibility(raw) {
  if (raw === undefined) {
    return { ok: true };
  }
  const visibility = String(raw ?? "").trim();
  if (!VISIBILITY_VALUES.includes(visibility)) {
    return {
      ok: false,
      message: `visibility must be one of: ${VISIBILITY_VALUES.join(", ")}.`,
    };
  }
  return { ok: true, value: visibility };
}

/**
 * Parses an optional commentsEnabled boolean.
 *
 * @param {unknown} raw Body commentsEnabled value.
 * @returns {{ok: true, value?: boolean}|{ok: false, message: string}} Parsed or error.
 */
function parseCommentsEnabled(raw) {
  if (raw === undefined) {
    return { ok: true };
  }
  if (typeof raw !== "boolean") {
    return { ok: false, message: "commentsEnabled must be a boolean." };
  }
  return { ok: true, value: raw };
}

/**
 * Parses an optional tags array for replace-all semantics.
 *
 * @param {unknown} raw Body tags value.
 * @returns {{ok: true, value?: string[]}|{ok: false, message: string}} Parsed or error.
 */
function parseTags(raw) {
  if (raw === undefined) {
    return { ok: true };
  }
  if (!Array.isArray(raw)) {
    return { ok: false, message: "tags must be an array of strings." };
  }
  if (raw.length > MAX_TAGS) {
    return { ok: false, message: `tags must have at most ${MAX_TAGS} items.` };
  }
  const tags = [];
  const seen = new Set();
  for (const item of raw) {
    const tag = String(item ?? "").trim();
    if (!tag) {
      return { ok: false, message: "tags entries must be non-empty strings." };
    }
    if (tag.length > MAX_TAG_LENGTH) {
      return {
        ok: false,
        message: `each tag must be at most ${MAX_TAG_LENGTH} characters.`,
      };
    }
    const key = tag.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return { ok: true, value: tags };
}

/**
 * Parses a PATCH body for updateVideo into a metadata patch and optional tags.
 *
 * @param {unknown} body Request body.
 * @returns {{
 *   ok: true,
 *   patch: object,
 *   tags?: string[]
 * }|{ok: false, message: string}} Parsed patch or error.
 */
function parseUpdateVideoBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "JSON body is required." };
  }

  const title = parseTitle(body.title, false);
  if (!title.ok) {
    return title;
  }
  const description = parseDescription(body.description);
  if (!description.ok) {
    return description;
  }
  const visibility = parseVisibility(body.visibility);
  if (!visibility.ok) {
    return visibility;
  }
  const commentsEnabled = parseCommentsEnabled(body.commentsEnabled);
  if (!commentsEnabled.ok) {
    return commentsEnabled;
  }
  const tags = parseTags(body.tags);
  if (!tags.ok) {
    return tags;
  }

  const patch = {};
  if (title.value !== undefined) {
    patch.title = title.value;
  }
  if (description.value !== undefined) {
    patch.description = description.value;
  }
  if (visibility.value !== undefined) {
    patch.visibility = visibility.value;
  }
  if (commentsEnabled.value !== undefined) {
    patch.commentsEnabled = commentsEnabled.value;
  }

  if (Object.keys(patch).length === 0 && tags.value === undefined) {
    return {
      ok: false,
      message:
        "At least one of title, description, visibility, commentsEnabled, or tags is required.",
    };
  }

  const result = { ok: true, patch };
  if (tags.value !== undefined) {
    result.tags = tags.value;
  }
  return result;
}

/**
 * Parses setVideoAccess body `{ usernames: string[] }`.
 *
 * @param {unknown} body Request body.
 * @returns {{ok: true, usernames: string[]}|{ok: false, message: string}} Parsed or error.
 */
function parseAccessBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "JSON body is required." };
  }
  if (!Array.isArray(body.usernames)) {
    return { ok: false, message: "usernames must be an array of strings." };
  }
  const usernames = [];
  const seen = new Set();
  for (const item of body.usernames) {
    const username = String(item ?? "").trim();
    if (!username) {
      return {
        ok: false,
        message: "usernames entries must be non-empty strings.",
      };
    }
    const key = username.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    usernames.push(username);
  }
  return { ok: true, usernames };
}

/**
 * Parses createComment body `{ body, parentCommentId?, distinguishedMod?, distinguishedAdmin? }`.
 *
 * @param {unknown} body Request body.
 * @returns {{
 *   ok: true,
 *   body: string,
 *   parentCommentId?: number,
 *   distinguishedMod?: boolean,
 *   distinguishedAdmin?: boolean
 * }|{ok: false, message: string}} Parsed fields or a validation error.
 */
function parseCreateCommentBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "JSON body is required." };
  }

  const text = typeof body.body === "string" ? body.body.trim() : "";
  if (!text) {
    return { ok: false, message: "body is required." };
  }
  if (text.length > MAX_COMMENT_LENGTH) {
    return {
      ok: false,
      message: `body must be at most ${MAX_COMMENT_LENGTH} characters.`,
    };
  }

  const result = { ok: true, body: text };

  if (body.parentCommentId !== undefined) {
    const parentCommentId = Number(body.parentCommentId);
    if (!Number.isInteger(parentCommentId) || parentCommentId < 1) {
      return {
        ok: false,
        message: "parentCommentId must be a positive integer.",
      };
    }
    result.parentCommentId = parentCommentId;
  }

  if (body.distinguishedMod !== undefined) {
    if (typeof body.distinguishedMod !== "boolean") {
      return { ok: false, message: "distinguishedMod must be a boolean." };
    }
    result.distinguishedMod = body.distinguishedMod;
  }

  if (body.distinguishedAdmin !== undefined) {
    if (typeof body.distinguishedAdmin !== "boolean") {
      return { ok: false, message: "distinguishedAdmin must be a boolean." };
    }
    result.distinguishedAdmin = body.distinguishedAdmin;
  }

  return result;
}

/**
 * Parses updateComment body `{ body?, distinguishedMod?, distinguishedAdmin? }`. At least one
 * recognized key is required.
 *
 * @param {unknown} body Request body.
 * @returns {{
 *   ok: true,
 *   patch: {body?: string, distinguishedMod?: boolean, distinguishedAdmin?: boolean}
 * }|{ok: false, message: string}} Parsed patch or a validation error.
 */
function parseUpdateCommentBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "JSON body is required." };
  }

  const patch = {};

  if (body.body !== undefined) {
    const text = typeof body.body === "string" ? body.body.trim() : "";
    if (!text) {
      return { ok: false, message: "body must be a non-empty string." };
    }
    if (text.length > MAX_COMMENT_LENGTH) {
      return {
        ok: false,
        message: `body must be at most ${MAX_COMMENT_LENGTH} characters.`,
      };
    }
    patch.body = text;
  }

  if (body.distinguishedMod !== undefined) {
    if (typeof body.distinguishedMod !== "boolean") {
      return { ok: false, message: "distinguishedMod must be a boolean." };
    }
    patch.distinguishedMod = body.distinguishedMod;
  }

  if (body.distinguishedAdmin !== undefined) {
    if (typeof body.distinguishedAdmin !== "boolean") {
      return { ok: false, message: "distinguishedAdmin must be a boolean." };
    }
    patch.distinguishedAdmin = body.distinguishedAdmin;
  }

  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      message:
        "At least one of body, distinguishedMod, or distinguishedAdmin is required.",
    };
  }

  return { ok: true, patch };
}

/**
 * Builds the videos / tags / feed discovery router.
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createVideosRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * GET /videos — listVideos
   * Auth: optional. Returns public videos only.
   *
   * @openapi
   * /api/v1/videos:
   *   get:
   *     tags: [Videos]
   *     summary: List public videos
   *     operationId: listVideos
   *     responses:
   *       "200":
   *         description: Public video list
   */
  router.get("/videos", optionalAuth, async (req, res) => {
    try {
      const items = await listPublicVideos({
        order: [
          [{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"],
        ],
        viewerUserId: req.user?.id ?? null,
      });
      res.status(200).json({ items });
    } catch (err) {
      console.error("listVideos failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list videos.",
      });
    }
  });

  /**
   * GET /videos/featured — listFeaturedVideos
   * Auth: optional. Featured ∩ public.
   *
   * @openapi
   * /api/v1/videos/featured:
   *   get:
   *     tags: [Videos]
   *     summary: List featured public videos
   *     operationId: listFeaturedVideos
   *     responses:
   *       "200":
   *         description: Featured video list
   */
  router.get("/videos/featured", optionalAuth, async (req, res) => {
    try {
      const items = await listPublicVideos({
        includes: [{ model: FeaturedVideo, required: true }],
        order: [[FeaturedVideo, "createdAt", "DESC"]],
        viewerUserId: req.user?.id ?? null,
      });
      res.status(200).json({ items });
    } catch (err) {
      console.error("listFeaturedVideos failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list featured videos.",
      });
    }
  });

  /**
   * GET /videos/newest — listNewestVideos
   * Auth: optional. Public videos newest first.
   *
   * @openapi
   * /api/v1/videos/newest:
   *   get:
   *     tags: [Videos]
   *     summary: List newest public videos
   *     operationId: listNewestVideos
   *     responses:
   *       "200":
   *         description: Newest public video list
   */
  router.get("/videos/newest", optionalAuth, async (req, res) => {
    try {
      const items = await listPublicVideos({
        order: [
          [{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"],
        ],
        viewerUserId: req.user?.id ?? null,
      });
      res.status(200).json({ items });
    } catch (err) {
      console.error("listNewestVideos failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list newest videos.",
      });
    }
  });

  /**
   * GET /videos/:id — getVideo
   * Auth: optional. Private requires owner, grant, or admin. Accepts either
   * the numeric id or the video's public videoId (see `videoId` on the
   * response payload) — the video page link uses the videoId. When the
   * caller is authenticated, the payload includes `viewerReaction`
   * ("like"/"dislike"/null) reflecting their current vote. When the caller is
   * an admin, the payload also includes `featured` (boolean).
   *
   * @openapi
   * /api/v1/videos/{id}:
   *   get:
   *     tags: [Videos]
   *     summary: Get a video by id or videoId
   *     operationId: getVideo
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Numeric video id or its public videoId.
   *     responses:
   *       "200":
   *         description: Video metadata
   *       "404":
   *         description: Not found or inaccessible
   */
  router.get("/videos/:id", optionalAuth, async (req, res) => {
    try {
      const loaded = await loadUploadWithMetadataByIdentifier(req.params.id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user?.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendNotFound(res);
        return;
      }

      const renditions = await loadRenditions(upload);
      const tagsByUploadId = await loadTagsByUploadId([upload.id]);

      const serializeOptions = {
        tags: tagsByUploadId.get(upload.id) || [],
        renditions,
      };
      if (req.user) {
        const viewerLike = await VideoLike.findOne({
          where: { originalUploadId: upload.id, userId: req.user.id },
        });
        serializeOptions.viewerReaction = viewerLike
          ? viewerLike.likeValue === 1
            ? "like"
            : "dislike"
          : null;
      }
      if (req.authRole?.name === "admin") {
        const featuredRow = await FeaturedVideo.findOne({
          where: { originalUploadId: upload.id },
        });
        serializeOptions.featured = Boolean(featuredRow);
      }

      res.status(200).json(serializeVideo(upload, metadata, serializeOptions));
    } catch (err) {
      console.error("getVideo failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load video. Does this video exist?",
      });
    }
  });

  /**
   * GET /videos/:id/stream — getVideoStream
   * Auth: optional. Private requires owner, grant, or admin. Streams a
   * transcoded rendition with HTTP Range support (progressive MP4 playback;
   * no HLS/DASH manifests).
   *
   * @openapi
   * /api/v1/videos/{id}/stream:
   *   get:
   *     tags: [Videos]
   *     summary: Stream a video rendition (supports HTTP Range requests)
   *     operationId: getVideoStream
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: query
   *         name: quality
   *         required: false
   *         schema:
   *           type: string
   *         description: >
   *           Resolution label (e.g. "720p") matching a complete rendition, or
   *           "original" to stream the untranscoded uploaded file directly.
   *           Defaults to the highest-resolution complete rendition when omitted.
   *     responses:
   *       "200":
   *         description: Full file (no Range header sent)
   *       "206":
   *         description: Partial content (Range header honored)
   *       "404":
   *         description: Not found, inaccessible, or no matching complete rendition
   *       "416":
   *         description: Requested Range is out of bounds
   */
  router.get("/videos/:id/stream", optionalAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const loaded = await loadUploadWithMetadata(id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user?.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendNotFound(res);
        return;
      }

      const requestedQuality =
        typeof req.query.quality === "string" ? req.query.quality.trim() : "";

      if (requestedQuality === "original") {
        const absolutePath = resolveMediaPath(upload.storagePath);
        await streamFileWithRangeSupport(
          req,
          res,
          absolutePath,
          upload.mimeType,
        );
        return;
      }

      const renditions = await FileVersion.findAll({
        where: { originalUploadId: upload.id, status: "complete" },
      });
      if (renditions.length === 0) {
        sendNotFound(res);
        return;
      }

      let version;
      if (requestedQuality) {
        version = renditions.find((v) => v.resolution === requestedQuality);
        if (!version) {
          sendNotFound(res);
          return;
        }
      } else {
        version = renditions.reduce((best, current) =>
          (current.videoHeight ?? 0) > (best.videoHeight ?? 0) ? current : best,
        );
      }

      const absolutePath = resolveMediaPath(version.storagePath);
      await streamFileWithRangeSupport(
        req,
        res,
        absolutePath,
        version.mimeType,
      );
    } catch (err) {
      console.error("getVideoStream failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: "Failed to stream video.",
        });
      }
    }
  });

  /**
   * GET /videos/:id/thumbnail — getVideoThumbnail
   * Auth: optional. Private requires owner, grant, or admin.
   *
   * @openapi
   * /api/v1/videos/{id}/thumbnail:
   *   get:
   *     tags: [Videos]
   *     summary: Get a video's thumbnail image
   *     operationId: getVideoThumbnail
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Thumbnail image
   *       "404":
   *         description: Not found, inaccessible, or no thumbnail generated yet
   */
  router.get("/videos/:id/thumbnail", optionalAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const loaded = await loadUploadWithMetadata(id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user?.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendNotFound(res);
        return;
      }

      const thumbnail = upload.VideoThumbnail;
      if (!thumbnail) {
        sendNotFound(res);
        return;
      }

      const absolutePath = resolveMediaPath(
        join(THUMBNAILS_SUBDIR, thumbnail.thumbnailFilename),
      );
      const contentType = mimeTypeForImage(thumbnail.thumbnailFilename);
      await streamFileWithRangeSupport(req, res, absolutePath, contentType);
    } catch (err) {
      console.error("getVideoThumbnail failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: "Failed to load thumbnail.",
        });
      }
    }
  });

  /**
   * Uploads (or replaces) a video's thumbnail image. Usable by the video
   * owner or an admin — an alternative to waiting for the processing
   * service to auto-generate one (e.g. while it's unhealthy). Deletes the
   * previous thumbnail file from disk, if any, after the new one is
   * persisted.
   * POST /videos/:id/thumbnail — multipart `file`.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/videos/{id}/thumbnail:
   *   post:
   *     tags: [Videos]
   *     summary: Upload or replace a video's thumbnail image
   *     operationId: updateVideoThumbnail
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
   *         description: Thumbnail updated
   *       "400":
   *         description: Invalid id, missing file, or unsupported file type
   *       "401":
   *         description: Not authenticated
   *       "403":
   *         description: Not the video owner and not an admin
   *       "404":
   *         description: Unknown video id
   *       "413":
   *         description: File too large
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the thumbnail URL or an error response.
   */
  router.post(
    "/videos/:id/thumbnail",
    requireAuth,
    thumbnailUpload.single("file"),
    async (req, res) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (id == null) {
          if (req.file) {
            await unlink(join(thumbnailsDir, req.file.filename)).catch(
              () => {},
            );
          }
          res.status(400).json({
            error: "invalid_id",
            message: "id must be a positive integer.",
          });
          return;
        }

        const loaded = await loadUploadWithMetadata(id);
        if (!loaded) {
          if (req.file) {
            await unlink(join(thumbnailsDir, req.file.filename)).catch(
              () => {},
            );
          }
          sendNotFound(res);
          return;
        }

        const { upload } = loaded;
        if (!isOwnerOrAdmin(req.user, req.authRole, upload)) {
          if (req.file) {
            await unlink(join(thumbnailsDir, req.file.filename)).catch(
              () => {},
            );
          }
          res.status(403).json({
            error: "forbidden",
            message:
              "Only the owner or an admin can update this video's thumbnail.",
          });
          return;
        }
        if (!req.file) {
          res
            .status(400)
            .json({ error: "invalid_body", message: "file is required." });
          return;
        }

        const [thumbnail, created] = await VideoThumbnail.findOrCreate({
          where: { originalUploadId: upload.id },
          defaults: { thumbnailFilename: req.file.filename },
        });

        let previousFilename = null;
        if (!created && thumbnail.thumbnailFilename !== req.file.filename) {
          previousFilename = thumbnail.thumbnailFilename;
          await thumbnail.update({ thumbnailFilename: req.file.filename });
        }
        if (previousFilename) {
          await unlink(join(thumbnailsDir, previousFilename)).catch(() => {});
        }

        syncVideoIndex(upload.id);

        res
          .status(200)
          .json({ thumbnailUrl: `/api/v1/videos/${upload.id}/thumbnail` });
      } catch (err) {
        if (req.file) {
          await unlink(join(thumbnailsDir, req.file.filename)).catch(() => {});
        }
        console.error("updateVideoThumbnail failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to update thumbnail.",
        });
      }
    },
  );
  router.use(thumbnailUploadErrorHandler);

  /**
   * PATCH /videos/:id — updateVideo
   * Auth: required. Owner or admin. Body: title, description, visibility,
   * commentsEnabled, tags.
   *
   * @openapi
   * /api/v1/videos/{id}:
   *   patch:
   *     tags: [Videos]
   *     summary: Update video metadata
   *     operationId: updateVideo
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
   *         description: Updated video
   *       "401":
   *         description: Unauthorized
   *       "403":
   *         description: Forbidden
   */
  router.patch("/videos/:id", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const parsed = parseUpdateVideoBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({
          error: "invalid_body",
          message: parsed.message,
        });
        return;
      }

      const loaded = await loadUploadWithMetadata(id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      if (!isOwnerOrAdmin(req.user, req.authRole, upload)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the owner or an admin can update this video.",
        });
        return;
      }

      await sequelize.transaction(async (transaction) => {
        if (Object.keys(parsed.patch).length > 0) {
          await metadata.update(parsed.patch, { transaction });
          if (parsed.patch.visibility === "hidden") {
            // Grants are only meaningful for private videos; wipe them on
            // entry to hidden rather than leaving stale access behind. Any
            // other visibility change (including back to private) preserves
            // existing grants.
            await VideoAccess.destroy({
              where: { originalUploadId: upload.id },
              transaction,
            });
          }
        }
        if (parsed.tags !== undefined) {
          await ContentTag.destroy({
            where: { originalUploadId: upload.id },
            transaction,
          });
          if (parsed.tags.length > 0) {
            await ContentTag.bulkCreate(
              parsed.tags.map((tag) => ({
                originalUploadId: upload.id,
                tag,
              })),
              { transaction },
            );
          }
        }
      });

      await metadata.reload();
      syncVideoIndex(upload.id);

      const renditions = await loadRenditions(upload);
      const tagsByUploadId = await loadTagsByUploadId([upload.id]);

      res.status(200).json(
        serializeVideo(upload, metadata, {
          tags: tagsByUploadId.get(upload.id) || [],
          renditions,
        }),
      );
    } catch (err) {
      console.error("updateVideo failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update video.",
      });
    }
  });

  /**
   * DELETE /videos/:id — deleteVideo
   * Auth: required. Owner or admin. Cascades via FK.
   *
   * @openapi
   * /api/v1/videos/{id}:
   *   delete:
   *     tags: [Videos]
   *     summary: Delete a video
   *     operationId: deleteVideo
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
   *         description: Deleted
   */
  router.delete("/videos/:id", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          success: false,
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const upload = await OriginalUpload.findByPk(id);
      if (!upload) {
        sendNotFound(res);
        return;
      }

      if (!isOwnerOrAdmin(req.user, req.authRole, upload)) {
        res.status(403).json({
          success: false,
          error: "forbidden",
          message: "Only the owner or an admin can delete this video.",
        });
        return;
      }

      await upload.destroy();
      removeVideoDocument(id);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("deleteVideo failed:", err);
      res.status(500).json({
        success: false,
        error: "internal_error",
        message: "Failed to delete video.",
      });
    }
  });

  /**
   * POST /videos/:id/delist — delistVideo
   * Auth: required. Moderator or admin. Sets visibility to unlisted — the
   * video stays viewable by anyone with the link/id, but drops out of public
   * browse/discovery lists (see `listPublicVideos`).
   *
   * @openapi
   * /api/v1/videos/{id}/delist:
   *   post:
   *     tags: [Videos]
   *     summary: Delist a video (set unlisted)
   *     operationId: delistVideo
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
   *         description: Delisted video
   */
  router.post(
    "/videos/:id/delist",
    requireAuth,
    requireModerator,
    async (req, res) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (id == null) {
          res.status(400).json({
            error: "invalid_id",
            message: "id must be a positive integer.",
          });
          return;
        }

        const loaded = await loadUploadWithMetadata(id);
        if (!loaded) {
          sendNotFound(res);
          return;
        }

        const { upload, metadata } = loaded;
        await metadata.update({ visibility: "unlisted" });
        syncVideoIndex(upload.id);

        const renditions = await loadRenditions(upload);
        const tagsByUploadId = await loadTagsByUploadId([upload.id]);

        res.status(200).json(
          serializeVideo(upload, metadata, {
            tags: tagsByUploadId.get(upload.id) || [],
            renditions,
          }),
        );
      } catch (err) {
        console.error("delistVideo failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to delist video.",
        });
      }
    },
  );

  /**
   * PUT /videos/:id/featured — setVideoFeatured
   * Auth: required. Admin only. Adds or removes the video from FEATURED_VIDEOS.
   *
   * @openapi
   * /api/v1/videos/{id}/featured:
   *   put:
   *     tags: [Videos]
   *     summary: Set or clear a video's featured status
   *     operationId: setVideoFeatured
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
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [featured]
   *             properties:
   *               featured:
   *                 type: boolean
   *     responses:
   *       "200":
   *         description: Updated featured status
   *       "403":
   *         description: Not an admin
   */
  router.put(
    "/videos/:id/featured",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (id == null) {
          res.status(400).json({
            error: "invalid_id",
            message: "id must be a positive integer.",
          });
          return;
        }
        if (typeof req.body?.featured !== "boolean") {
          res.status(400).json({
            error: "invalid_body",
            message: "featured must be a boolean.",
          });
          return;
        }

        const loaded = await loadUploadWithMetadata(id);
        if (!loaded) {
          sendNotFound(res);
          return;
        }

        if (req.body.featured) {
          await FeaturedVideo.findOrCreate({
            where: { originalUploadId: loaded.upload.id },
          });
        } else {
          await FeaturedVideo.destroy({
            where: { originalUploadId: loaded.upload.id },
          });
        }

        res.status(200).json({ featured: req.body.featured });
      } catch (err) {
        console.error("setVideoFeatured failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to update featured status.",
        });
      }
    },
  );

  /**
   * GET /videos/:id/access — listVideoAccess
   * Auth: required. Owner or admin.
   *
   * @openapi
   * /api/v1/videos/{id}/access:
   *   get:
   *     tags: [Videos]
   *     summary: List private-access grants for a video
   *     operationId: listVideoAccess
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
   *         description: Access grant list
   */
  router.get("/videos/:id/access", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const upload = await OriginalUpload.findByPk(id);
      if (!upload) {
        sendNotFound(res);
        return;
      }
      if (!isOwnerOrAdmin(req.user, req.authRole, upload)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the owner or an admin can list video access.",
        });
        return;
      }

      const grants = await VideoAccess.findAll({
        where: { originalUploadId: upload.id },
        include: [{ model: User, required: true }],
        order: [["id", "ASC"]],
      });

      res.status(200).json({
        items: grants.map((grant) =>
          serializeUserRef(
            grant.userId,
            grant.User.username,
            grant.User.displayName,
          ),
        ),
      });
    } catch (err) {
      console.error("listVideoAccess failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list video access.",
      });
    }
  });

  /**
   * PUT /videos/:id/access — setVideoAccess
   * Auth: required. Owner or admin. Body: `{ usernames: string[] }` replace-all.
   * Only allowed while the video is currently `private` — grants are only
   * meaningful for private videos, and are wiped automatically if the video
   * is ever set to `hidden` (see `updateVideo`).
   *
   * @openapi
   * /api/v1/videos/{id}/access:
   *   put:
   *     tags: [Videos]
   *     summary: Replace private-access grants for a video
   *     operationId: setVideoAccess
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
   *         description: Updated access grant list
   *       "400":
   *         description: Invalid body, or the video is not currently private
   */
  router.put("/videos/:id/access", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const parsed = parseAccessBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({
          error: "invalid_body",
          message: parsed.message,
        });
        return;
      }

      const loaded = await loadUploadWithMetadata(id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }
      const { upload, metadata } = loaded;
      if (!isOwnerOrAdmin(req.user, req.authRole, upload)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the owner or an admin can set video access.",
        });
        return;
      }
      if (metadata.visibility !== "private") {
        res.status(400).json({
          error: "invalid_state",
          message:
            "Video access can only be managed while the video is private.",
        });
        return;
      }

      /** @type {import('sequelize').Model[]} */
      let users = [];
      if (parsed.usernames.length > 0) {
        users = await User.findAll({
          where: {
            username: { [Op.in]: parsed.usernames },
          },
        });
        const found = new Set(users.map((u) => u.username.toLowerCase()));
        const missing = parsed.usernames.filter(
          (name) => !found.has(name.toLowerCase()),
        );
        if (missing.length > 0) {
          res.status(400).json({
            error: "invalid_body",
            message: `Unknown username(s): ${missing.join(", ")}.`,
          });
          return;
        }
      }

      await sequelize.transaction(async (transaction) => {
        await VideoAccess.destroy({
          where: { originalUploadId: upload.id },
          transaction,
        });
        if (users.length > 0) {
          await VideoAccess.bulkCreate(
            users.map((user) => ({
              originalUploadId: upload.id,
              userId: user.id,
            })),
            { transaction },
          );
        }
      });

      const grants = await VideoAccess.findAll({
        where: { originalUploadId: upload.id },
        include: [{ model: User, required: true }],
        order: [["id", "ASC"]],
      });

      res.status(200).json({
        items: grants.map((grant) =>
          serializeUserRef(
            grant.userId,
            grant.User.username,
            grant.User.displayName,
          ),
        ),
      });
    } catch (err) {
      console.error("setVideoAccess failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to set video access.",
      });
    }
  });

  /**
   * POST /videos/:id/view — recordVideoView
   * Auth: optional. Requires canView. Increments viewCount for every viewer; when
   * authenticated, also inserts a USER_VIEW_HISTORY row for the caller.
   *
   * @openapi
   * /api/v1/videos/{id}/view:
   *   post:
   *     tags: [Videos]
   *     summary: Record a video view
   *     operationId: recordVideoView
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Updated view count
   */
  router.post("/videos/:id/view", optionalAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const loaded = await loadUploadWithMetadata(id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user?.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendNotFound(res);
        return;
      }

      await metadata.increment("viewCount");
      await metadata.reload();

      if (req.user) {
        await UserViewHistory.create({
          originalUploadId: upload.id,
          userId: req.user.id,
        });
      }

      res.status(200).json({ viewCount: Number(metadata.viewCount) });
    } catch (err) {
      console.error("recordVideoView failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to record view.",
      });
    }
  });

  /**
   * POST /videos/:id/like — likeVideo
   * Auth: required. Requires canView. Sets the caller's reaction to "like",
   * replacing any existing dislike; calling again while already liked clears
   * the reaction (toggle).
   *
   * @openapi
   * /api/v1/videos/{id}/like:
   *   post:
   *     tags: [Videos]
   *     summary: Like a video (toggles off if already liked)
   *     operationId: likeVideo
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
   *         description: Resulting reaction state
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 liked:
   *                   type: boolean
   *                 disliked:
   *                   type: boolean
   */
  router.post("/videos/:id/like", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const loaded = await loadUploadWithMetadata(id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendNotFound(res);
        return;
      }

      const result = await toggleVideoReaction(upload.id, req.user.id, 1);

      res.status(200).json(result);
    } catch (err) {
      console.error("likeVideo failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to like video.",
      });
    }
  });

  /**
   * POST /videos/:id/dislike — dislikeVideo
   * Auth: required. Requires canView. Sets the caller's reaction to
   * "dislike", replacing any existing like; calling again while already
   * disliked clears the reaction (toggle).
   *
   * @openapi
   * /api/v1/videos/{id}/dislike:
   *   post:
   *     tags: [Videos]
   *     summary: Dislike a video (toggles off if already disliked)
   *     operationId: dislikeVideo
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
   *         description: Resulting reaction state
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 liked:
   *                   type: boolean
   *                 disliked:
   *                   type: boolean
   */
  router.post("/videos/:id/dislike", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const loaded = await loadUploadWithMetadata(id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendNotFound(res);
        return;
      }

      const result = await toggleVideoReaction(upload.id, req.user.id, -1);

      res.status(200).json(result);
    } catch (err) {
      console.error("dislikeVideo failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to dislike video.",
      });
    }
  });

  /**
   * POST /videos/:id/comments — createComment
   * Auth: required. Requires canView. Blocked when the video's comments are
   * disabled unless the caller is a moderator/admin self-distinguishing the
   * comment (`distinguishedMod`/`distinguishedAdmin: true`), matching their
   * role's own flag.
   *
   * @openapi
   * /api/v1/videos/{id}/comments:
   *   post:
   *     tags: [Videos]
   *     summary: Post a comment (or reply) on a video
   *     operationId: createComment
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
   *       "201":
   *         description: Created comment
   *       "400":
   *         description: Invalid body, or parentCommentId not on this video
   *       "403":
   *         description: Forbidden (comments disabled, or not authorized for a distinguished flag)
   *       "404":
   *         description: Video not found or inaccessible
   */
  router.post("/videos/:id/comments", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const loaded = await loadUploadWithMetadata(id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendNotFound(res);
        return;
      }

      const parsed = parseCreateCommentBody(req.body);
      if (!parsed.ok) {
        res
          .status(400)
          .json({ error: "invalid_body", message: parsed.message });
        return;
      }

      if (
        parsed.distinguishedMod !== undefined &&
        !isModeratorOrAdmin(req.authRole)
      ) {
        res.status(403).json({
          error: "forbidden",
          message: "Only a moderator or admin may set distinguishedMod.",
        });
        return;
      }
      if (parsed.distinguishedAdmin !== undefined && !isAdmin(req.authRole)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only an admin may set distinguishedAdmin.",
        });
        return;
      }

      if (!metadata.commentsEnabled) {
        const selfDistinguished =
          parsed.distinguishedMod === true ||
          parsed.distinguishedAdmin === true;
        if (!selfDistinguished) {
          res.status(403).json({
            error: "comments_disabled",
            message: "Comments are disabled on this video.",
          });
          return;
        }
      }

      if (parsed.parentCommentId !== undefined) {
        const parentComment = await Comment.findByPk(parsed.parentCommentId);
        if (!parentComment || parentComment.originalUploadId !== upload.id) {
          res.status(400).json({
            error: "invalid_parent_comment",
            message:
              "parentCommentId does not refer to a comment on this video.",
          });
          return;
        }
      }

      const comment = await Comment.create({
        originalUploadId: upload.id,
        userId: req.user.id,
        parentCommentId: parsed.parentCommentId ?? null,
        body: parsed.body,
        distinguishedMod: parsed.distinguishedMod ?? false,
        distinguishedAdmin: parsed.distinguishedAdmin ?? false,
      });
      await comment.reload({ include: [{ model: User, required: false }] });

      res.status(201).json(serializeComment(comment));
    } catch (err) {
      console.error("createComment failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to create comment.",
      });
    }
  });

  /**
   * GET /videos/:id/comments — listComments
   * Auth: optional. Requires canView. All comments on the video, oldest first
   * (regardless of the commentsEnabled flag - reading is always allowed).
   *
   * @openapi
   * /api/v1/videos/{id}/comments:
   *   get:
   *     tags: [Videos]
   *     summary: List comments on a video
   *     operationId: listComments
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Comment list
   *       "404":
   *         description: Video not found or inaccessible
   */
  router.get("/videos/:id/comments", optionalAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const loaded = await loadUploadWithMetadata(id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user?.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendNotFound(res);
        return;
      }

      const comments = await Comment.findAll({
        where: { originalUploadId: upload.id },
        order: [["createdAt", "ASC"]],
        include: [{ model: User, required: false }],
      });

      res.status(200).json({ items: comments.map(serializeComment) });
    } catch (err) {
      console.error("listComments failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list comments.",
      });
    }
  });

  /**
   * PATCH /videos/:id/comments/:commentId — updateComment
   * Auth: required. `body` may only be changed by the comment's author.
   * `distinguishedMod` requires moderator/admin; `distinguishedAdmin` requires admin.
   *
   * @openapi
   * /api/v1/videos/{id}/comments/{commentId}:
   *   patch:
   *     tags: [Videos]
   *     summary: Edit a comment's body, or toggle its distinguished flags
   *     operationId: updateComment
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
   *       - in: path
   *         name: commentId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Updated comment
   *       "400":
   *         description: Invalid or empty body
   *       "403":
   *         description: Not authorized for the requested change
   *       "404":
   *         description: Video or comment not found
   */
  router.patch(
    "/videos/:id/comments/:commentId",
    requireAuth,
    async (req, res) => {
      try {
        const id = parsePositiveInt(req.params.id);
        const commentId = parsePositiveInt(req.params.commentId);
        if (id == null || commentId == null) {
          res.status(400).json({
            error: "invalid_id",
            message: "id and commentId must be positive integers.",
          });
          return;
        }

        const loaded = await loadUploadWithMetadata(id);
        if (!loaded) {
          sendNotFound(res);
          return;
        }

        const { upload, metadata } = loaded;
        const hasGrant = await userHasAccessGrant(upload.id, req.user.id);
        if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
          sendNotFound(res);
          return;
        }

        const comment = await Comment.findByPk(commentId);
        if (!comment || comment.originalUploadId !== upload.id) {
          sendNotFound(res);
          return;
        }

        const parsed = parseUpdateCommentBody(req.body);
        if (!parsed.ok) {
          res
            .status(400)
            .json({ error: "invalid_body", message: parsed.message });
          return;
        }

        const { patch } = parsed;
        if (
          patch.body !== undefined &&
          Number(req.user.id) !== Number(comment.userId)
        ) {
          res.status(403).json({
            error: "forbidden",
            message: "Only the comment's author may edit its body.",
          });
          return;
        }
        if (
          patch.distinguishedMod !== undefined &&
          !isModeratorOrAdmin(req.authRole)
        ) {
          res.status(403).json({
            error: "forbidden",
            message: "Only a moderator or admin may set distinguishedMod.",
          });
          return;
        }
        if (patch.distinguishedAdmin !== undefined && !isAdmin(req.authRole)) {
          res.status(403).json({
            error: "forbidden",
            message: "Only an admin may set distinguishedAdmin.",
          });
          return;
        }

        await comment.update(patch);
        await comment.reload({ include: [{ model: User, required: false }] });

        res.status(200).json(serializeComment(comment));
      } catch (err) {
        console.error("updateComment failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to update comment.",
        });
      }
    },
  );

  /**
   * DELETE /videos/:id/comments/:commentId — deleteComment
   * Auth: required. The author may delete their own comment; a moderator may
   * delete any comment that isn't distinguishedAdmin; an admin may delete any
   * comment unconditionally. Deleting a comment cascades to its replies.
   *
   * @openapi
   * /api/v1/videos/{id}/comments/{commentId}:
   *   delete:
   *     tags: [Videos]
   *     summary: Delete a comment
   *     operationId: deleteComment
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
   *       - in: path
   *         name: commentId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "204":
   *         description: Comment deleted
   *       "403":
   *         description: Not authorized to delete this comment
   *       "404":
   *         description: Video or comment not found
   */
  router.delete(
    "/videos/:id/comments/:commentId",
    requireAuth,
    async (req, res) => {
      try {
        const id = parsePositiveInt(req.params.id);
        const commentId = parsePositiveInt(req.params.commentId);
        if (id == null || commentId == null) {
          res.status(400).json({
            error: "invalid_id",
            message: "id and commentId must be positive integers.",
          });
          return;
        }

        const loaded = await loadUploadWithMetadata(id);
        if (!loaded) {
          sendNotFound(res);
          return;
        }

        const { upload, metadata } = loaded;
        const hasGrant = await userHasAccessGrant(upload.id, req.user.id);
        if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
          sendNotFound(res);
          return;
        }

        const comment = await Comment.findByPk(commentId);
        if (!comment || comment.originalUploadId !== upload.id) {
          sendNotFound(res);
          return;
        }

        const isOwner = Number(req.user.id) === Number(comment.userId);
        const canDelete =
          isOwner ||
          isAdmin(req.authRole) ||
          (isModeratorOrAdmin(req.authRole) && !comment.distinguishedAdmin);
        if (!canDelete) {
          res.status(403).json({
            error: "forbidden",
            message: "Not authorized to delete this comment.",
          });
          return;
        }

        await comment.destroy();
        res.status(204).send();
      } catch (err) {
        console.error("deleteComment failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to delete comment.",
        });
      }
    },
  );

  /**
   * GET /tags — listTags
   * Auth: optional. Distinct tags on public videos with counts.
   *
   * @openapi
   * /api/v1/tags:
   *   get:
   *     tags: [Videos]
   *     summary: List tags used on public videos
   *     operationId: listTags
   *     responses:
   *       "200":
   *         description: Tag list
   */
  router.get("/tags", optionalAuth, async (_req, res) => {
    try {
      const rows = await ContentTag.findAll({
        attributes: [
          "tag",
          [
            literal("COUNT(DISTINCT `ContentTag`.`original_upload_id`)"),
            "videoCount",
          ],
        ],
        include: [
          {
            model: OriginalUpload,
            required: true,
            attributes: [],
            include: [
              {
                model: VideoMetadata,
                as: "VideoMetadata",
                required: true,
                attributes: [],
                where: { visibility: "public" },
              },
            ],
          },
        ],
        group: ["ContentTag.tag"],
        order: [["tag", "ASC"]],
        raw: true,
      });

      res.status(200).json({
        items: rows.map((row) => ({
          tag: row.tag,
          videoCount: Number(row.videoCount),
        })),
      });
    } catch (err) {
      console.error("listTags failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list tags.",
      });
    }
  });

  /**
   * GET /tags/:tag/videos — listTagVideos
   * Auth: optional. Public videos with the given tag.
   *
   * @openapi
   * /api/v1/tags/{tag}/videos:
   *   get:
   *     tags: [Videos]
   *     summary: List public videos for a tag
   *     operationId: listTagVideos
   *     parameters:
   *       - in: path
   *         name: tag
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       "200":
   *         description: Tagged public videos
   */
  router.get("/tags/:tag/videos", optionalAuth, async (req, res) => {
    try {
      const tag = String(req.params.tag ?? "").trim();
      if (!tag) {
        res.status(400).json({
          error: "invalid_id",
          message: "tag must be a non-empty string.",
        });
        return;
      }

      const items = await listPublicVideos({
        includes: [
          {
            model: ContentTag,
            required: true,
            where: { tag },
          },
        ],
        order: [
          [{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"],
        ],
        viewerUserId: req.user?.id ?? null,
      });
      res.status(200).json({ items });
    } catch (err) {
      console.error("listTagVideos failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list tag videos.",
      });
    }
  });

  /**
   * GET /feed/subscriptions — feedSubscriptions
   * Auth: required. Public videos from subscribed channels, newest first.
   *
   * @openapi
   * /api/v1/feed/subscriptions:
   *   get:
   *     tags: [Videos]
   *     summary: Subscription feed of public videos
   *     operationId: feedSubscriptions
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       "200":
   *         description: Subscription feed
   *       "401":
   *         description: Unauthorized
   */
  router.get("/feed/subscriptions", requireAuth, async (req, res) => {
    try {
      const subscriptions = await Subscription.findAll({
        where: { subscriberId: req.user.id },
        attributes: ["subscribedToId"],
      });
      const channelIds = subscriptions.map((row) => row.subscribedToId);
      if (channelIds.length === 0) {
        res.status(200).json({ items: [] });
        return;
      }

      const items = await listPublicVideos({
        uploadWhere: { userId: { [Op.in]: channelIds } },
        order: [
          [{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"],
        ],
        viewerUserId: req.user.id,
      });
      res.status(200).json({ items });
    } catch (err) {
      console.error("feedSubscriptions failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load subscription feed.",
      });
    }
  });

  return router;
}
