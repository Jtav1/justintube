import { randomUUID } from "node:crypto";
import { copyFileSync, mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Router } from "express";
import multer from "multer";
import { Op, col, fn, literal } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { optionalAuth, requireAuth } from "../lib/auth/require-auth.js";
import { requireModerator } from "../lib/auth/require-moderator.js";
import { requireUploader } from "../lib/auth/require-uploader.js";
import {
  DEFAULT_AUDIO_THUMBNAIL_FILENAME,
  mimeTypeForImage,
  resolveMediaPath,
  userStorageSegment,
} from "../lib/media-meta.js";
import { VISIBILITY_VALUES } from "../lib/models/constants.js";
import {
  AccessPermission,
  Comment,
  ContentTag,
  FeaturedVideo,
  FileVersion,
  OriginalUpload,
  Subscription,
  User,
  UserHiddenVideo,
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
  resolveViewerPermission,
} from "../lib/video-access.js";
import { isVideoHidden, loadHiddenUploadIds } from "../lib/video-hidden.js";
import { DEFAULT_LIMIT, MAX_LIMIT, parsePagination } from "../lib/pagination.js";
import {
  addVideoToLikesPlaylist,
  removeVideoFromLikesPlaylist,
} from "../lib/likes-playlist.js";
import { buildPublicLink } from "../lib/email/mailer.js";
import { createNotification } from "../lib/notifications.js";
import { streamFileWithRangeSupport } from "../lib/range-stream.js";
import { removeVideoDocument, syncVideoIndex } from "../lib/search.js";
import { serializeUserRef } from "../lib/serialize-user-ref.js";
import { requestTranscodeBatch } from "../lib/processing-client.js";
import {
  THUMBNAIL_OUTPUT_EXT,
  enqueueAudioEmbedVideo,
  parseThumbnailTimestampTenths,
} from "./uploads.js";
import { logger } from "../lib/logger.js";

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
 * Absolute path to the bundled default-audio-thumbnail source asset (shipped
 * in the webapi image at `webapi/assets/`, alongside this routes/ directory).
 *
 * @type {string}
 */
const DEFAULT_AUDIO_THUMBNAIL_SOURCE = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "assets",
  DEFAULT_AUDIO_THUMBNAIL_FILENAME,
);

// Copies the bundled default speaker-icon thumbnail into the shared media
// volume on every boot, so it stays in sync with whatever's shipped in the
// image and so `processing` (which only has access to the shared volume, not
// webapi's own container filesystem) can read it too when muxing an embed
// video for an audio upload with no real thumbnail yet.
copyFileSync(
  DEFAULT_AUDIO_THUMBNAIL_SOURCE,
  join(thumbnailsDir, DEFAULT_AUDIO_THUMBNAIL_FILENAME),
);

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
 * Multer storage engine that writes thumbnail uploads to
 * `thumbnails/<userId>/` under the media root using a freshly generated
 * UUID as the filename (preserving the original extension). Unlike direct
 * video upload, the requester (`req.user`) isn't necessarily the video's
 * owner here — an admin/moderator can update a thumbnail for someone else's
 * video — so the owning video's `userId` is looked up directly, before the
 * route handler's own ownership check runs. This mirrors the "async DB work
 * inside a multer callback" pattern already used for the direct-upload
 * `filename` callback (`generateUniqueVideoId()`); the resulting write is no
 * riskier than today's behavior, which already writes-then-unlinks-on-403.
 */
const thumbnailStorage = multer.diskStorage({
  destination: async (req, _file, cb) => {
    try {
      const id = parsePositiveInt(req.params.id);
      let segment = "_unowned";
      if (id != null) {
        const owner = await OriginalUpload.findByPk(id, { attributes: ["userId"] });
        if (owner) {
          segment = userStorageSegment(owner.userId);
        }
      }
      const dir = join(thumbnailsDir, segment);
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
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
export function parsePositiveInt(raw) {
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
 * @param {number} [options.likeCount] Total VIDEO_LIKES rows with likeValue 1. Defaults to 0
 *   when not passed — callers should batch-load via {@link loadReactionCountsByUploadId}.
 * @param {number} [options.dislikeCount] Total VIDEO_LIKES rows with likeValue -1. Defaults to
 *   0 when not passed — callers should batch-load via {@link loadReactionCountsByUploadId}.
 * @param {"owner"|"edit"|"view"} [options.viewerPermission] The requesting user's effective
 *   permission level, when known (see {@link resolveViewerPermission}). Only attached when
 *   explicitly passed — omitted from the payload entirely otherwise.
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
 *   embedVideoUrl: string|null,
 *   likeCount: number,
 *   dislikeCount: number,
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
    // Only ever set for an upload with no genuine video stream (see
    // enqueueAudioEmbedVideo, routes/uploads.js) - its mere presence is the
    // client-facing signal that this upload had no video stream to begin
    // with, since the embed job is never enqueued otherwise. VideoPlayer
    // (webview) uses this in place of the original stream when present.
    embedVideoUrl: upload.embedVideoStoragePath
      ? `/api/v1/videos/${upload.id}/embed-video`
      : null,
    likeCount: options.likeCount ?? 0,
    dislikeCount: options.dislikeCount ?? 0,
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
  if (options.viewerPermission !== undefined) {
    payload.viewerPermission = options.viewerPermission;
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
 * Batch-loads VIDEO_LIKES aggregate counts for a set of uploads, grouped by
 * originalUploadId and likeValue. Used so every `serializeVideo` call site
 * can attach `likeCount`/`dislikeCount` without an N+1 query per video.
 *
 * @param {number[]} originalUploadIds Upload ids to load reaction counts for.
 * @returns {Promise<Map<number, {likeCount: number, dislikeCount: number}>>}
 *   Upload id → its like/dislike totals.
 */
export async function loadReactionCountsByUploadId(originalUploadIds) {
  const map = new Map();
  if (originalUploadIds.length === 0) {
    return map;
  }
  const rows = await VideoLike.findAll({
    where: { originalUploadId: { [Op.in]: originalUploadIds } },
    attributes: ["originalUploadId", "likeValue", [fn("COUNT", col("id")), "count"]],
    group: ["originalUploadId", "likeValue"],
    raw: true,
  });
  for (const row of rows) {
    const entry = map.get(row.originalUploadId) || { likeCount: 0, dislikeCount: 0 };
    if (Number(row.likeValue) === 1) {
      entry.likeCount = Number(row.count);
    } else if (Number(row.likeValue) === -1) {
      entry.dislikeCount = Number(row.count);
    }
    map.set(row.originalUploadId, entry);
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
 * Resolves webapi's own externally-reachable origin (no trailing slash),
 * for building absolute `og:image`/`og:video` URLs in the link-unfurl HTML
 * route — bots fetch those URLs directly over the public internet, so
 * relative paths and the Docker-internal `webapi:3000` hostname are both
 * unusable there.
 *
 * @returns {string} Origin, e.g. "https://api.example.com".
 */
function publicApiOrigin() {
  const configured = String(process.env.PUBLIC_API_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (configured) {
    return configured;
  }
  return `http://localhost:${process.env.PORT || 3000}`;
}

/**
 * Resolves the webview's externally-reachable origin (no trailing slash),
 * for building the canonical `og:url` back to the video's real shareable page.
 *
 * @returns {string} Origin, e.g. "https://justintube.example.com".
 */
function publicAppOrigin() {
  const configured = String(process.env.PUBLIC_APP_URL || "")
    .trim()
    .replace(/\/$/, "");
  if (configured) {
    return configured;
  }
  return "http://localhost:5173";
}

/**
 * Escapes a value for safe embedding in HTML text nodes and
 * `content="..."` attribute values. Title/description/uploader name are
 * user-controlled and this is the only place webapi renders raw user text
 * as HTML rather than JSON.
 *
 * @param {*} value Value to escape (stringified first).
 * @returns {string} HTML-escaped string.
 */
function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

/**
 * Picks the smallest-resolution rendition (by height) from a
 * `loadRenditions` result, comparing across both transcoded FILE_VERSIONS
 * entries and the trailing "original" entry. The original is always last in
 * that array regardless of its actual height, so this cannot assume
 * position `[0]` is smallest.
 *
 * @param {object[]} renditions Result of `loadRenditions`.
 * @returns {object|null} Smallest-by-height rendition, the first entry when
 *   none have a known height, or null when the array is empty.
 */
function pickSmallestRendition(renditions) {
  const withHeight = renditions.filter(
    (r) => typeof r.height === "number" && r.height > 0,
  );
  if (withHeight.length > 0) {
    return withHeight.reduce((smallest, r) =>
      r.height < smallest.height ? r : smallest,
    );
  }
  return renditions[0] ?? null;
}


/**
 * Sends the generic, existence-masking fallback page for the unfurl route —
 * used for both "video does not exist" and "caller cannot view it", so
 * neither case is distinguishable from the response body (mirrors
 * `sendNotFound`'s masking property for the JSON API).
 *
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendUnfurlFallback(res) {
  res
    .status(404)
    .type("html")
    .send(
      '<!doctype html><html><head><meta charset="utf-8">' +
        "<title>Justintube</title>" +
        '<meta property="og:site_name" content="Justintube">' +
        '<meta property="og:title" content="Justintube">' +
        '<meta property="og:description" content="Video not found or unavailable.">' +
        "</head><body></body></html>",
    );
}

/**
 * Sends the generic fallback page for the player route — same
 * existence-masking property as `sendUnfurlFallback`, covering "does not
 * exist", "cannot view", and "no usable rendition" with one
 * indistinguishable response.
 *
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendPlayerFallback(res) {
  res
    .status(404)
    .type("html")
    .send(
      '<!doctype html><html><head><meta charset="utf-8">' +
        "<title>Justintube</title></head><body></body></html>",
    );
}

/**
 * Renders the minimal, iframe-embeddable HTML page a Twitter/X Player Card
 * loads via `twitter:player` — a bare `<video>` (or, for audio uploads,
 * `<audio>`) element sized to fill whatever iframe the embedder renders it
 * in, not a redirect to the raw stream URL (Player Card expects an HTML
 * document with a player UI, not a bare media byte stream).
 *
 * @param {import('sequelize').Model} upload ORIGINAL_UPLOADS row.
 * @param {object} smallest Rendition reference from `pickSmallestRendition`.
 * @returns {string} Full HTML document.
 */
function renderPlayerHtml(upload, smallest) {
  const src = `${publicApiOrigin()}${smallest.streamUrl}`;
  const isVideo = upload.mediaType === "video";
  const mediaTag = isVideo
    ? `<video src="${escapeHtml(src)}" controls playsinline preload="metadata"></video>`
    : `<audio src="${escapeHtml(src)}" controls preload="metadata"></audio>`;
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<title>${escapeHtml(upload.videoId)}</title>` +
    "<style>html,body{margin:0;height:100%;background:#000}" +
    "video{width:100%;height:100%;object-fit:contain}" +
    "audio{width:100%;margin-top:calc(50% - 20px)}</style>" +
    "</head><body>" +
    mediaTag +
    "</body></html>"
  );
}

/**
 * Fallback embed dimensions for audio uploads, used for `og:video:width`/
 * `og:video:height` and `twitter:player:width`/`:height` — audio renditions
 * have no natural width/height (unlike video), but Discord (and Twitter's
 * Player Card) requires numeric dimensions to be present before it will
 * activate the inline player at all, video or audio.
 *
 * @type {number}
 */
const AUDIO_EMBED_WIDTH = 480;

/**
 * @type {number}
 * @see AUDIO_EMBED_WIDTH
 */
const AUDIO_EMBED_HEIGHT = 80;

/**
 * Renders the link-unfurl HTML page: Open Graph + Twitter Card meta tags
 * describing the video for chat-app/social link-preview bots, which do not
 * execute JS and never see the SPA's client-rendered content.
 *
 * Discord (and most other unfurlers) can't render an inline media player
 * alongside a description line — only one or the other shows up — so this
 * picks exactly one per page: a page with an embeddable rendition gets the
 * player (`og:video`/`twitter:player`, smallest complete rendition, as
 * originally designed) and no description; anything else (no usable
 * rendition yet) is a non-player page and gets a plain "Justintube - <title>"
 * description instead.
 *
 * Audio uploads deliberately point `og:video` (not just `og:audio`) at a
 * real playable video whenever one is available — Discord has no
 * `og:audio`-based player at all and simply shows a plain link card for it,
 * but it *will* render a full inline video player from `og:video`. Once
 * `enqueueAudioEmbedVideo` (routes/uploads.js) has produced a muxed
 * thumbnail+audio MP4 for this upload (`upload.embedVideoStoragePath`),
 * `og:video`/`twitter:player:stream` point at that (`GET
 * /videos/:id/embed-video`, `video/mp4`, real width/height) instead of the
 * raw audio stream. Until then — no thumbnail yet, or the mux job hasn't
 * finished — this falls back to the old behavior of pointing `og:video` at
 * the raw audio stream with a fixed compact-player size
 * (`AUDIO_EMBED_WIDTH`/`HEIGHT`); some unfurlers do render *something*
 * playable from that even without a video stream, so it's still better than
 * nothing. `og:audio` tags always point at the real audio stream (never the
 * muxed video), for the few unfurlers that do honor them.
 *
 * `twitter:card` is `"player"` (full inline playback) only when
 * `publicApiOrigin()` is HTTPS — Twitter/X will not validate an `http://`
 * player page — otherwise falls back to `"summary_large_image"` (rich card,
 * no inline play).
 *
 * @param {import('sequelize').Model} upload ORIGINAL_UPLOADS row (with User, VideoThumbnail included).
 * @param {import('sequelize').Model} metadata VIDEO_METADATA row.
 * @param {object[]} renditions Result of `loadRenditions(upload)`.
 * @returns {string} Full HTML document.
 */
function renderUnfurlHtml(upload, metadata, renditions) {
  const apiOrigin = publicApiOrigin();
  const appOrigin = publicAppOrigin();
  const uploaderLabel =
    upload.User?.displayName || upload.User?.username || null;
  const uploadedAt = metadata.createdAt
    ? new Date(metadata.createdAt).toISOString().slice(0, 10)
    : null;
  const title = metadata.title || "Justintube";
  const pageUrl = `${appOrigin}/video?v=${encodeURIComponent(upload.videoId)}`;
  const isVideo = upload.mediaType === "video";
  // Distinct from `isVideo` (mediaType, an extension-based guess made at
  // upload time that can be wrong) - this is the ffprobe-confirmed fact used
  // to decide whether the muxed embed video / placeholder thumbnail is what
  // should actually be shown here (see enqueueAudioEmbedVideo,
  // routes/uploads.js). `hasVideoStream` null (not yet probed, or the probe
  // failed) is treated as "has video" - fails open, same as elsewhere.
  const hasNoVideoStream = upload.hasVideoStream === false;
  const smallest = pickSmallestRendition(renditions);
  const embedsMedia = Boolean(smallest?.streamUrl);
  const description = embedsMedia ? null : `Justintube - ${title}`;

  let ogType = "website";
  if (isVideo) {
    ogType = "video.other";
  } else if (embedsMedia) {
    ogType = "music.song";
  }

  const tags = [
    '<meta property="og:site_name" content="Justintube">',
    `<meta property="og:type" content="${ogType}">`,
    `<meta property="og:title" content="${escapeHtml(title)}">`,
    `<meta property="og:url" content="${escapeHtml(pageUrl)}">`,
    `<link rel="canonical" href="${escapeHtml(pageUrl)}">`,
  ];
  if (description) {
    tags.push(
      `<meta property="og:description" content="${escapeHtml(description)}">`,
    );
    tags.push(
      `<meta name="description" content="${escapeHtml(description)}">`,
    );
  }

  if (uploaderLabel) {
    tags.push(`<meta name="author" content="${escapeHtml(uploaderLabel)}">`);
  }

  if (upload.VideoThumbnail || hasNoVideoStream) {
    // Uploads with no real video stream always have *something* to show
    // here, even with no real thumbnail - GET /videos/:id/thumbnail falls
    // back to the bundled speaker-icon placeholder for them (see
    // routes/videos.js module load).
    const imageUrl = `${apiOrigin}/api/v1/videos/${upload.id}/thumbnail`;
    tags.push(`<meta property="og:image" content="${escapeHtml(imageUrl)}">`);
    tags.push(
      `<meta property="og:image:secure_url" content="${escapeHtml(imageUrl)}">`,
    );
    tags.push(`<meta name="twitter:image" content="${escapeHtml(imageUrl)}">`);
  }

  let twitterCard = "summary";
  if (embedsMedia) {
    const hasEmbedVideo = hasNoVideoStream && Boolean(upload.embedVideoStoragePath);
    const mediaUrl = hasEmbedVideo
      ? `${apiOrigin}/api/v1/videos/${upload.id}/embed-video`
      : `${apiOrigin}${smallest.streamUrl}`;
    const mediaType = hasEmbedVideo
      ? "video/mp4"
      : smallest.mimeType || (isVideo ? "video/mp4" : "audio/mpeg");
    const mediaWidth = hasEmbedVideo ? upload.embedVideoWidth : smallest.width;
    const mediaHeight = hasEmbedVideo ? upload.embedVideoHeight : smallest.height;

    tags.push(`<meta property="og:video" content="${escapeHtml(mediaUrl)}">`);
    tags.push(
      `<meta property="og:video:secure_url" content="${escapeHtml(mediaUrl)}">`,
    );
    tags.push(
      `<meta property="og:video:type" content="${escapeHtml(mediaType)}">`,
    );
    if (mediaWidth != null && mediaHeight != null) {
      tags.push(
        `<meta property="og:video:width" content="${mediaWidth}">`,
      );
      tags.push(
        `<meta property="og:video:height" content="${mediaHeight}">`,
      );
    } else if (hasNoVideoStream) {
      // No embed video yet (no thumbnail, or the mux job hasn't finished) —
      // audio renditions have no natural width/height of their own, but
      // Discord requires og:video:width/height to be present to activate the
      // embed at all, so fall back to a fixed compact-player size.
      tags.push(
        `<meta property="og:video:width" content="${AUDIO_EMBED_WIDTH}">`,
      );
      tags.push(
        `<meta property="og:video:height" content="${AUDIO_EMBED_HEIGHT}">`,
      );
    }
    if (hasNoVideoStream) {
      // Semantically-correct tags for the few unfurlers that do honor them —
      // always the real audio stream, never the muxed embed video, alongside
      // the og:video Discord-compatibility tags above.
      const audioUrl = `${apiOrigin}${smallest.streamUrl}`;
      const audioType = smallest.mimeType || "audio/mpeg";
      tags.push(`<meta property="og:audio" content="${escapeHtml(audioUrl)}">`);
      tags.push(
        `<meta property="og:audio:type" content="${escapeHtml(audioType)}">`,
      );
    }

    twitterCard = "summary_large_image";
    if (apiOrigin.startsWith("https://")) {
      twitterCard = "player";
      const playerUrl = `${apiOrigin}/api/v1/videos/${upload.id}/player`;
      const width =
        mediaWidth || upload.videoWidth || (hasNoVideoStream ? AUDIO_EMBED_WIDTH : 480);
      const height =
        mediaHeight || upload.videoHeight || (hasNoVideoStream ? AUDIO_EMBED_HEIGHT : 270);
      tags.push(
        `<meta name="twitter:player" content="${escapeHtml(playerUrl)}">`,
      );
      tags.push(`<meta name="twitter:player:width" content="${width}">`);
      tags.push(`<meta name="twitter:player:height" content="${height}">`);
      tags.push(
        `<meta name="twitter:player:stream" content="${escapeHtml(mediaUrl)}">`,
      );
      tags.push(
        `<meta name="twitter:player:stream:content_type" content="${escapeHtml(mediaType)}">`,
      );
    }
  }

  tags.push(`<meta name="twitter:card" content="${twitterCard}">`);
  tags.push(`<meta name="twitter:title" content="${escapeHtml(title)}">`);
  if (description) {
    tags.push(
      `<meta name="twitter:description" content="${escapeHtml(description)}">`,
    );
  }
  if (uploaderLabel) {
    tags.push('<meta name="twitter:label1" content="Uploader">');
    tags.push(
      `<meta name="twitter:data1" content="${escapeHtml(uploaderLabel)}">`,
    );
  }
  if (uploadedAt) {
    tags.push('<meta name="twitter:label2" content="Uploaded">');
    tags.push(
      `<meta name="twitter:data2" content="${escapeHtml(uploadedAt)}">`,
    );
  }

  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)} - Justintube</title>` +
    tags.join("") +
    "</head><body>" +
    `<h1>${escapeHtml(title)}</h1>` +
    (uploaderLabel ? `<p>By ${escapeHtml(uploaderLabel)}</p>` : "") +
    (description ? `<p>${escapeHtml(description)}</p>` : "") +
    "</body></html>"
  );
}

/**
 * Serializes a COMMENTS row for API responses. Soft-deleted comments (see
 * `deletedAt` on the model) have their `author` and `body` redacted to
 * `null` and their distinguished flags forced to `false` — the frontend
 * renders these as a "[Deleted]" placeholder when the comment still has
 * replies, or omits it entirely when it doesn't (both replies and the
 * childless-vs-not decision are computed client-side from the flat list,
 * since deleting a comment never removes its row or its replies.
 *
 * @param {import('sequelize').Model} comment Comment instance (expects `User` preloaded).
 * @returns {{
 *   id: number,
 *   originalUploadId: number,
 *   parentCommentId: number|null,
 *   author: {userId: number|null, username: string|null, displayName: string|null}|null,
 *   body: string|null,
 *   distinguishedMod: boolean,
 *   distinguishedAdmin: boolean,
 *   deletedAt: Date|null,
 *   createdAt: Date,
 *   updatedAt: Date
 * }} Public comment payload.
 */
function serializeComment(comment) {
  const isDeleted = comment.deletedAt != null;
  return {
    id: comment.id,
    originalUploadId: comment.originalUploadId,
    parentCommentId: comment.parentCommentId ?? null,
    author: isDeleted
      ? null
      : serializeUserRef(
          comment.userId,
          comment.User?.username,
          comment.User?.displayName,
        ),
    body: isDeleted ? null : comment.body,
    distinguishedMod: isDeleted ? false : Boolean(comment.distinguishedMod),
    distinguishedAdmin: isDeleted ? false : Boolean(comment.distinguishedAdmin),
    deletedAt: comment.deletedAt ?? null,
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
 * always replaces or removes that row rather than ever storing more than one. A like additionally
 * keeps the user's "My Likes" playlist in sync: liking adds the video, and unliking (via toggle-off
 * or switching to a dislike) removes it (see lib/likes-playlist.js).
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
  const previousValue = existing?.likeValue ?? null;

  if (existing) {
    await existing.destroy();
  }

  if (previousValue === value) {
    if (previousValue === 1) {
      await removeVideoFromLikesPlaylist(userId, originalUploadId);
    }
    return { liked: false, disliked: false };
  }

  await VideoLike.create({ originalUploadId, userId, likeValue: value });

  if (previousValue === 1) {
    await removeVideoFromLikesPlaylist(userId, originalUploadId);
  }
  if (value === 1) {
    await addVideoToLikesPlaylist(userId, originalUploadId);
  }

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
 * Loads the caller's VIDEO_ACCESS grant row for an upload, if any, including
 * its AccessPermission so callers can inspect the grant's permission level.
 *
 * @param {number} originalUploadId Upload id.
 * @param {number|null|undefined} userId Authenticated user id.
 * @returns {Promise<import('sequelize').Model|null>} The grant row, or null.
 */
async function loadAccessGrant(originalUploadId, userId) {
  if (!userId) {
    return null;
  }
  return VideoAccess.findOne({
    where: { originalUploadId, userId },
    include: [{ model: AccessPermission }],
  });
}

/**
 * Returns whether the given user has a VIDEO_ACCESS grant on the upload (view
 * or edit level - either is sufficient to view a private/hidden video).
 *
 * @param {number} originalUploadId Upload id.
 * @param {number|null|undefined} userId Authenticated user id.
 * @returns {Promise<boolean>} True when a grant row exists.
 */
async function userHasAccessGrant(originalUploadId, userId) {
  return Boolean(await loadAccessGrant(originalUploadId, userId));
}

/**
 * Returns whether the given user's VIDEO_ACCESS grant is specifically
 * "edit"-level (sufficient to update metadata/content, see canEditVideo).
 *
 * @param {number} originalUploadId Upload id.
 * @param {number|null|undefined} userId Authenticated user id.
 * @returns {Promise<boolean>} True when an "edit" grant row exists.
 */
async function userHasEditGrant(originalUploadId, userId) {
  const grant = await loadAccessGrant(originalUploadId, userId);
  return grant?.AccessPermission?.name === "edit";
}

/**
 * Batch-resolves the caller's effective permission level ("owner"/"edit"/"view")
 * for a set of videos, using a single VideoAccess+AccessPermission query
 * (scoped to the non-owned ids) rather than one grant lookup per row. Used by
 * list/search endpoints so every video card can show an accurate Edit
 * affordance without an N+1 query per item.
 *
 * @param {Array<{id: number, userId: number|null}>} items Videos to resolve, by id and owning userId.
 * @param {import('sequelize').Model|null|undefined} user Authenticated user.
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @returns {Promise<Map<number, "owner"|"edit"|"view">>} Map of video id to permission level.
 */
export async function loadViewerPermissionsByUploadId(items, user, role) {
  const result = new Map();
  if (!user) {
    for (const item of items) {
      result.set(item.id, "view");
    }
    return result;
  }

  let editGrantedIds = new Set();
  if (!isAdmin(role)) {
    const nonOwnedIds = items
      .filter((item) => Number(item.userId) !== Number(user.id))
      .map((item) => item.id);
    if (nonOwnedIds.length > 0) {
      const grants = await VideoAccess.findAll({
        where: { userId: user.id, originalUploadId: { [Op.in]: nonOwnedIds } },
        include: [{ model: AccessPermission, required: true }],
      });
      editGrantedIds = new Set(
        grants
          .filter((grant) => grant.AccessPermission.name === "edit")
          .map((grant) => grant.originalUploadId),
      );
    }
  }

  for (const item of items) {
    result.set(
      item.id,
      resolveViewerPermission(user, role, item.userId, editGrantedIds.has(item.id)),
    );
  }
  return result;
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
 * Builds the shared `where`/`include` for a bulk browse/discovery query.
 * Public videos are always included; `unlisted`/`hidden`/`private` videos
 * are included for their owner (`options.viewerUserId`); `private` and
 * `hidden` videos are additionally included for any viewer holding a
 * matching VIDEO_ACCESS grant. Everyone else never sees delisted, hidden, or
 * private content in these bulk lists. When `options.viewerUserId` is set,
 * videos that viewer has personally hidden (USER_HIDDEN_VIDEOS, see
 * lib/video-hidden.js — unrelated to VIDEO_METADATA.visibility) are excluded.
 *
 * Shared by {@link listPublicVideos} (paginated) and {@link listRandomVideos}
 * (random sample) so the visibility/grant/hidden-video filtering logic only
 * lives in one place.
 *
 * @param {object} [options] Query options.
 * @param {import('sequelize').WhereOptions} [options.uploadWhere] Extra ORIGINAL_UPLOADS where.
 * @param {import('sequelize').Includeable[]} [options.includes] Extra includes.
 * @param {number|null} [options.viewerUserId] Authenticated caller's id, if any.
 * @returns {Promise<{where: import('sequelize').WhereOptions, include: import('sequelize').Includeable[]}>}
 *   `findAll`/`count`-ready `where`/`include`.
 *
 * @remarks
 * Every `options.includes` entry with `required: true` must be guaranteed to match at most
 * one row per upload (e.g. a `hasOne` association, or a `hasMany` filtered down to a unique
 * key) — callers computing a distinct count against this query rely on that (see
 * `listPublicVideos`'s `totalHits` remark).
 */
async function buildDiscoveryFindOptions(options = {}) {
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

  const uploadWhere = { ...(options.uploadWhere || {}) };
  if (options.viewerUserId) {
    const hiddenUploadIds = await loadHiddenUploadIds(options.viewerUserId);
    if (hiddenUploadIds.size > 0) {
      const existingNotIn = uploadWhere.id?.[Op.notIn] || [];
      uploadWhere.id = {
        [Op.notIn]: [...new Set([...existingNotIn, ...hiddenUploadIds])],
      };
    }
  }

  return {
    where: {
      ...uploadWhere,
      [Op.or]: visibilityOr,
    },
    include: [
      { model: VideoMetadata, as: "VideoMetadata", required: true },
      { model: VideoThumbnail, required: false },
      { model: User, required: false },
      ...(options.includes || []),
    ],
  };
}

/**
 * Batch-loads tags, reaction counts, and viewer permissions for a set of
 * discovery-query rows and serializes each into a video payload. Shared by
 * {@link listPublicVideos} and {@link listRandomVideos}.
 *
 * @param {import('sequelize').Model[]} rows ORIGINAL_UPLOADS rows (with VideoMetadata/VideoThumbnail/User preloaded).
 * @param {import('sequelize').Model|null} [viewerUser] Authenticated caller, used to attach `viewerPermission`.
 * @param {import('sequelize').Model|null} [viewerRole] Authenticated caller's role.
 * @returns {Promise<object[]>} Serialized video items in the same order as `rows`.
 */
async function serializeDiscoveryRows(rows, viewerUser, viewerRole) {
  const uploadIds = rows.map((upload) => upload.id);
  const tagsByUploadId = await loadTagsByUploadId(uploadIds);
  const reactionCountsByUploadId = await loadReactionCountsByUploadId(uploadIds);
  const viewerPermissionByUploadId = await loadViewerPermissionsByUploadId(
    rows,
    viewerUser,
    viewerRole,
  );
  return rows.map((upload) =>
    serializeVideo(upload, upload.VideoMetadata, {
      tags: tagsByUploadId.get(upload.id) || [],
      viewerPermission: viewerPermissionByUploadId.get(upload.id),
      ...reactionCountsByUploadId.get(upload.id),
    }),
  );
}

/**
 * Finds videos for a bulk browse/discovery list, optionally filtered and
 * ordered. See {@link buildDiscoveryFindOptions} for the visibility/grant/
 * hidden-video filtering rules.
 *
 * @param {object} [options] Query options.
 * @param {import('sequelize').WhereOptions} [options.uploadWhere] Extra ORIGINAL_UPLOADS where.
 * @param {import('sequelize').Includeable[]} [options.includes] Extra includes.
 * @param {import('sequelize').Order} [options.order] Order clause.
 * @param {number|null} [options.viewerUserId] Authenticated caller's id, if any.
 * @param {import('sequelize').Model|null} [options.viewerUser] Authenticated caller, used to
 *   attach each item's `viewerPermission` (see {@link loadViewerPermissionsByUploadId}).
 * @param {import('sequelize').Model|null} [options.viewerRole] Authenticated caller's role.
 * @param {number} [options.page] 1-based page number. Defaults to 1.
 * @param {number} [options.limit] Page size. Defaults to `DEFAULT_LIMIT`.
 * @returns {Promise<{items: object[], totalHits: number}>} Serialized video items for the
 *   requested page, plus the total number of matching videos across all pages.
 *
 * @remarks
 * `totalHits` is computed via a standalone `OriginalUpload.count()` using the same
 * `where`/`include` as the data query (rather than `findAndCountAll`), with
 * `distinct: true, col: "id"` so a `required: true` include that joins multiple rows per
 * upload doesn't inflate the count. See {@link buildDiscoveryFindOptions} for the
 * precondition this relies on.
 */
async function listPublicVideos(options = {}) {
  const findOptions = await buildDiscoveryFindOptions(options);

  const page = options.page ?? 1;
  const limit = options.limit ?? DEFAULT_LIMIT;

  const totalHits = await OriginalUpload.count({
    ...findOptions,
    distinct: true,
    col: "id",
  });

  const rows = await OriginalUpload.findAll({
    ...findOptions,
    order: options.order || [["id", "ASC"]],
    limit,
    offset: (page - 1) * limit,
    // Sequelize's default `limit` + `include` behavior wraps the query in a
    // subquery that only selects the base model's own columns, which breaks
    // ordering by an association's column (e.g. VideoMetadata.createdAt).
    // Disabling it is safe here because every include above is guaranteed
    // at most one matching row per upload (see the `totalHits` remark on
    // this function), so a plain LIMIT on the joined rows can't under- or
    // over-count distinct videos.
    subQuery: false,
  });

  return {
    items: await serializeDiscoveryRows(rows, options.viewerUser, options.viewerRole),
    totalHits,
  };
}

/**
 * Finds a random sample of videos the caller may see, using the same
 * visibility/grant/hidden-video filtering as {@link listPublicVideos} (see
 * {@link buildDiscoveryFindOptions}) but ordered randomly at the database
 * level (`ORDER BY RANDOM()`/`RAND()` depending on dialect, via
 * `sequelize.random()`) rather than paginated — a single `LIMIT quantity`
 * over a randomly-ordered result set, so it naturally returns distinct rows
 * with no risk of repeats within one call.
 *
 * @param {object} [options] Query options.
 * @param {import('sequelize').WhereOptions} [options.uploadWhere] Extra ORIGINAL_UPLOADS where.
 * @param {number} options.quantity Number of videos to return.
 * @param {number|null} [options.viewerUserId] Authenticated caller's id, if any.
 * @param {import('sequelize').Model|null} [options.viewerUser] Authenticated caller, used to
 *   attach each item's `viewerPermission` (see {@link loadViewerPermissionsByUploadId}).
 * @param {import('sequelize').Model|null} [options.viewerRole] Authenticated caller's role.
 * @returns {Promise<{items: object[]}>} Up to `quantity` randomly-selected, serialized video items.
 */
async function listRandomVideos(options = {}) {
  const findOptions = await buildDiscoveryFindOptions(options);

  const rows = await OriginalUpload.findAll({
    ...findOptions,
    order: sequelize.random(),
    limit: options.quantity,
    // See listPublicVideos's subQuery: false remark — same reasoning applies
    // here even though there's no association-column ORDER BY, because
    // ORDER BY RANDOM() also can't be pushed into a column-limited subquery.
    subQuery: false,
  });

  return {
    items: await serializeDiscoveryRows(rows, options.viewerUser, options.viewerRole),
  };
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
 * Parses an optional createdAt override (ISO 8601 date-time string). Exists
 * to backdate a video's listed upload date to its true original date when
 * importing from another platform (e.g. `migration-tools/migrate-user-videos.js`),
 * where the upload API call itself necessarily happens long after that date —
 * not intended for routine editing.
 *
 * @param {unknown} raw Body createdAt value.
 * @returns {{ok: true, value?: Date}|{ok: false, message: string}} Parsed or error.
 */
function parseCreatedAt(raw) {
  if (raw === undefined) {
    return { ok: true };
  }
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return {
      ok: false,
      message: "createdAt must be a valid ISO 8601 date-time string.",
    };
  }
  if (date.getTime() > Date.now()) {
    return { ok: false, message: "createdAt cannot be in the future." };
  }
  return { ok: true, value: date };
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
  const createdAt = parseCreatedAt(body.createdAt);
  if (!createdAt.ok) {
    return createdAt;
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
  if (createdAt.value !== undefined) {
    patch.createdAt = createdAt.value;
  }

  if (Object.keys(patch).length === 0 && tags.value === undefined) {
    return {
      ok: false,
      message:
        "At least one of title, description, visibility, commentsEnabled, createdAt, or tags is required.",
    };
  }

  const result = { ok: true, patch };
  if (tags.value !== undefined) {
    result.tags = tags.value;
  }
  return result;
}

/**
 * Parses a setVideoEditors/setVideoViewers body `{ usernames: [string, ...] }`.
 * Duplicate usernames (case-insensitive) within one request: first
 * occurrence wins.
 *
 * @param {unknown} body Request body.
 * @returns {{ok: true, usernames: string[]}|{ok: false, message: string}} Parsed or error.
 */
function parseUsernamesBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "JSON body is required." };
  }
  if (!Array.isArray(body.usernames)) {
    return {
      ok: false,
      message: "usernames must be an array of strings.",
    };
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
 * Resolves a list of usernames to User rows, erroring on unknown usernames.
 *
 * @param {string[]} usernames Usernames to resolve.
 * @returns {Promise<{ok: true, users: import('sequelize').Model[]}|{ok: false, message: string}>} Resolved users or error.
 */
async function resolveUsersByUsername(usernames) {
  if (usernames.length === 0) {
    return { ok: true, users: [] };
  }
  const users = await User.findAll({
    where: { username: { [Op.in]: usernames } },
  });
  const found = new Set(users.map((u) => u.username.toLowerCase()));
  const missing = usernames.filter((name) => !found.has(name.toLowerCase()));
  if (missing.length > 0) {
    return { ok: false, message: `Unknown username(s): ${missing.join(", ")}.` };
  }
  return { ok: true, users };
}

/**
 * Replaces all VIDEO_ACCESS rows for `originalUploadId` at a given
 * permission level with grants for exactly `users`, leaving rows at other
 * permission levels untouched. Returns the full (all-permission) grant list
 * for the video afterward, serialized for API responses.
 *
 * @param {number} originalUploadId Video's OriginalUpload id.
 * @param {number} permissionId ACCESS_PERMISSIONS id to replace grants for.
 * @param {import('sequelize').Model[]} users Users to grant at this permission level.
 * @returns {Promise<object[]>} Serialized `{ userId, username, displayName, permission }` items.
 */
async function replaceVideoAccessForPermission(originalUploadId, permissionId, users) {
  await sequelize.transaction(async (transaction) => {
    await VideoAccess.destroy({
      where: { originalUploadId, permissionId },
      transaction,
    });
    if (users.length > 0) {
      await VideoAccess.bulkCreate(
        users.map((user) => ({
          originalUploadId,
          userId: user.id,
          permissionId,
        })),
        { transaction },
      );
    }
  });

  const grants = await VideoAccess.findAll({
    where: { originalUploadId },
    include: [
      { model: User, required: true },
      { model: AccessPermission, required: true },
    ],
    order: [["id", "ASC"]],
  });

  return grants.map((grant) => ({
    ...serializeUserRef(grant.userId, grant.User.username, grant.User.displayName),
    permission: grant.AccessPermission.name,
  }));
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
 * Default number of videos returned by GET /videos/random when `quantity`
 * is omitted.
 *
 * @type {number}
 */
const DEFAULT_RANDOM_QUANTITY = 10;

/**
 * Parses and validates the `quantity` query param for listRandomVideos,
 * reusing `MAX_LIMIT` as the upper bound for consistency with the other
 * list endpoints' page-size cap.
 *
 * @param {import('express').Request['query']} query Raw Express query object.
 * @returns {{ok: true, quantity: number}|{ok: false, message: string}} Parsed quantity or error.
 */
function parseRandomQuantity(query) {
  const raw =
    query.quantity === undefined ? DEFAULT_RANDOM_QUANTITY : Number(query.quantity);
  if (!Number.isInteger(raw) || raw < 1) {
    return { ok: false, message: "quantity must be a positive integer." };
  }
  if (raw > MAX_LIMIT) {
    return { ok: false, message: `quantity must be at most ${MAX_LIMIT}.` };
  }
  return { ok: true, quantity: raw };
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
   *         description: Paginated public video list
   *       "400":
   *         description: Invalid page/limit
   */
  router.get("/videos", optionalAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { items, totalHits } = await listPublicVideos({
        order: [
          [{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"],
        ],
        viewerUserId: req.user?.id ?? null,
        viewerUser: req.user ?? null,
        viewerRole: req.authRole ?? null,
        page,
        limit,
      });
      res.status(200).json({
        items,
        page,
        limit,
        totalHits,
        totalPages: totalHits === 0 ? 0 : Math.ceil(totalHits / limit),
      });
    } catch (err) {
      logger.error({ err }, "listVideos failed");
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
   *         description: Paginated featured video list
   *       "400":
   *         description: Invalid page/limit
   */
  router.get("/videos/featured", optionalAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { items, totalHits } = await listPublicVideos({
        includes: [{ model: FeaturedVideo, required: true }],
        order: [[FeaturedVideo, "createdAt", "DESC"]],
        viewerUserId: req.user?.id ?? null,
        viewerUser: req.user ?? null,
        viewerRole: req.authRole ?? null,
        page,
        limit,
      });
      res.status(200).json({
        items,
        page,
        limit,
        totalHits,
        totalPages: totalHits === 0 ? 0 : Math.ceil(totalHits / limit),
      });
    } catch (err) {
      logger.error({ err }, "listFeaturedVideos failed");
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
   *         description: Paginated newest public video list
   *       "400":
   *         description: Invalid page/limit
   */
  router.get("/videos/newest", optionalAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { items, totalHits } = await listPublicVideos({
        order: [
          [{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"],
        ],
        viewerUserId: req.user?.id ?? null,
        viewerUser: req.user ?? null,
        viewerRole: req.authRole ?? null,
        page,
        limit,
      });
      res.status(200).json({
        items,
        page,
        limit,
        totalHits,
        totalPages: totalHits === 0 ? 0 : Math.ceil(totalHits / limit),
      });
    } catch (err) {
      logger.error({ err }, "listNewestVideos failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list newest videos.",
      });
    }
  });

  /**
   * GET /videos/random — listRandomVideos
   * Auth: optional. A random sample of videos the caller may see (public,
   * plus the caller's own unlisted/hidden/private videos and any videos
   * shared with them via a VIDEO_ACCESS grant) — same visibility rules as
   * listVideos, but unordered and not paginated.
   *
   * @openapi
   * /api/v1/videos/random:
   *   get:
   *     tags: [Videos]
   *     summary: List a random sample of videos the caller may see
   *     operationId: listRandomVideos
   *     parameters:
   *       - name: quantity
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 99
   *           default: 10
   *     responses:
   *       "200":
   *         description: Random video sample (up to `quantity` items)
   *       "400":
   *         description: Invalid quantity
   */
  router.get("/videos/random", optionalAuth, async (req, res) => {
    try {
      const parsedQuantity = parseRandomQuantity(req.query);
      if (!parsedQuantity.ok) {
        res
          .status(400)
          .json({ error: "invalid_query", message: parsedQuantity.message });
        return;
      }

      const { items } = await listRandomVideos({
        quantity: parsedQuantity.quantity,
        viewerUserId: req.user?.id ?? null,
        viewerUser: req.user ?? null,
        viewerRole: req.authRole ?? null,
      });
      res.status(200).json({ items });
    } catch (err) {
      logger.error({ err }, "listRandomVideos failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list random videos.",
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
   * an admin, the payload also includes `featured` (boolean). When the caller
   * has personally hidden this video (see lib/video-hidden.js), responds 404
   * with `error: "hidden_by_viewer"` — distinct from the generic masked
   * `not_found` used for missing/unauthorized videos — so the frontend can
   * show a "you hid this video" notice instead of a plain not-found message.
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
   *         description: >
   *           Not found or inaccessible. When the caller has personally hidden
   *           this video (see POST /videos/{id}/hide), the body's `error` is
   *           `hidden_by_viewer` instead of `not_found`.
   */
  router.get("/videos/:id", optionalAuth, async (req, res) => {
    try {
      const loaded = await loadUploadWithMetadataByIdentifier(req.params.id);
      if (!loaded) {
        sendNotFound(res);
        return;
      }

      const { upload, metadata } = loaded;
      const grant = await loadAccessGrant(upload.id, req.user?.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, Boolean(grant))) {
        sendNotFound(res);
        return;
      }

      if (req.user && (await isVideoHidden(req.user.id, upload.id))) {
        res.status(404).json({
          error: "hidden_by_viewer",
          message: "You've hidden this video.",
        });
        return;
      }

      const renditions = await loadRenditions(upload);
      const tagsByUploadId = await loadTagsByUploadId([upload.id]);
      const reactionCountsByUploadId = await loadReactionCountsByUploadId([upload.id]);

      const isOwnerAdmin = isOwnerOrAdmin(req.user, req.authRole, upload);
      const hasEditGrant = !isOwnerAdmin && grant?.AccessPermission?.name === "edit";

      const serializeOptions = {
        tags: tagsByUploadId.get(upload.id) || [],
        renditions,
        viewerPermission: resolveViewerPermission(req.user, req.authRole, upload.userId, hasEditGrant),
        ...reactionCountsByUploadId.get(upload.id),
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
      logger.error({ err }, "getVideo failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load video. Does this video exist?",
      });
    }
  });

  /**
   * GET /videos/:id/unfurl — getVideoUnfurl
   * Auth: optional. Returns an HTML document with Open Graph / Twitter Card
   * meta tags describing the video (title, author, upload date, thumbnail,
   * and an embedded copy of its smallest-resolution rendition) for chat-app
   * link-unfurl bots, which do not execute JS and never see the SPA's
   * client-rendered `/video?v=` page. Existence-masking: returns the same
   * generic 404 HTML whether the video truly doesn't exist or the caller
   * just cannot view it.
   *
   * @openapi
   * /api/v1/videos/{id}/unfurl:
   *   get:
   *     tags: [Videos]
   *     summary: Get an Open Graph / Twitter Card unfurl page for a video
   *     operationId: getVideoUnfurl
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Numeric video id or its public videoId.
   *     responses:
   *       "200":
   *         description: HTML document with unfurl meta tags
   *         content:
   *           text/html:
   *             schema:
   *               type: string
   *       "404":
   *         description: Generic HTML fallback (video not found or inaccessible)
   *         content:
   *           text/html:
   *             schema:
   *               type: string
   */
  router.get("/videos/:id/unfurl", optionalAuth, async (req, res) => {
    try {
      const loaded = await loadUploadWithMetadataByIdentifier(req.params.id);
      if (!loaded) {
        sendUnfurlFallback(res);
        return;
      }
      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user?.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendUnfurlFallback(res);
        return;
      }
      const renditions = await loadRenditions(upload);
      res
        .status(200)
        .set("Cache-Control", "public, max-age=300")
        .type("html")
        .send(renderUnfurlHtml(upload, metadata, renditions));
    } catch (err) {
      logger.error({ err }, "getVideoUnfurl failed");
      sendUnfurlFallback(res);
    }
  });

  /**
   * GET /videos/:id/player — getVideoPlayer
   * Auth: optional. Returns a minimal, iframe-embeddable HTML page for a
   * single video or audio upload's smallest-resolution rendition — the
   * target of `twitter:player` in the unfurl page, so Twitter/X's Player
   * Card can play it inline. Not reachable through `webview`; this is an
   * absolute `webapi` URL fetched directly by Twitter's card-rendering
   * service.
   *
   * @openapi
   * /api/v1/videos/{id}/player:
   *   get:
   *     tags: [Videos]
   *     summary: Get an iframe-embeddable video/audio player page (for Twitter/X Player Cards)
   *     operationId: getVideoPlayer
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Numeric video id or its public videoId.
   *     responses:
   *       "200":
   *         description: HTML document with an embedded video or audio player
   *         content:
   *           text/html:
   *             schema:
   *               type: string
   *       "404":
   *         description: Generic HTML fallback (not found, inaccessible, or no usable rendition)
   *         content:
   *           text/html:
   *             schema:
   *               type: string
   */
  router.get("/videos/:id/player", optionalAuth, async (req, res) => {
    try {
      const loaded = await loadUploadWithMetadataByIdentifier(req.params.id);
      if (!loaded) {
        sendPlayerFallback(res);
        return;
      }
      const { upload, metadata } = loaded;
      const hasGrant = await userHasAccessGrant(upload.id, req.user?.id);
      if (!canViewVideo(req.user, req.authRole, upload, metadata, hasGrant)) {
        sendPlayerFallback(res);
        return;
      }
      const renditions = await loadRenditions(upload);
      const smallest = pickSmallestRendition(renditions);
      if (!smallest?.streamUrl) {
        sendPlayerFallback(res);
        return;
      }
      // Twitter (and any other iframe embedder) must be allowed to frame
      // this response — helmet's default frameguard middleware (applied
      // globally in webapi/index.js) sends X-Frame-Options: SAMEORIGIN,
      // which blocks that. Override on this route only; nothing else in
      // webapi is meant to be iframed.
      res.removeHeader("X-Frame-Options");
      res.setHeader(
        "Content-Security-Policy",
        "frame-ancestors https://twitter.com https://x.com https://*.twimg.com https://cards-frame.twitter.com",
      );
      res.status(200).type("html").send(renderPlayerHtml(upload, smallest));
    } catch (err) {
      logger.error({ err }, "getVideoPlayer failed");
      sendPlayerFallback(res);
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
      logger.error({ err }, "getVideoStream failed");
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: "Failed to stream video.",
        });
      }
    }
  });

  /**
   * GET /videos/:id/embed-video — getVideoEmbedVideo
   * Auth: optional. Private requires owner, grant, or admin. Streams an
   * audio upload's thumbnail+audio MP4 (see `enqueueAudioEmbedVideo` in
   * routes/uploads.js) with HTTP Range support — the `og:video`/
   * `twitter:player:stream` target `renderUnfurlHtml` points link-unfurl
   * bots at for audio uploads, since Discord has no `og:audio` player.
   *
   * @openapi
   * /api/v1/videos/{id}/embed-video:
   *   get:
   *     tags: [Videos]
   *     summary: Stream an audio upload's link-unfurl embed video (supports HTTP Range requests)
   *     operationId: getVideoEmbedVideo
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Full file (no Range header sent)
   *       "206":
   *         description: Partial content (Range header honored)
   *       "404":
   *         description: Not found, inaccessible, or no embed video generated yet
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the streamed file or a 404/500 error.
   */
  router.get("/videos/:id/embed-video", optionalAuth, async (req, res) => {
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

      if (!upload.embedVideoStoragePath) {
        sendNotFound(res);
        return;
      }

      const absolutePath = resolveMediaPath(upload.embedVideoStoragePath);
      await streamFileWithRangeSupport(req, res, absolutePath, "video/mp4");
    } catch (err) {
      logger.error({ err }, "getVideoEmbedVideo failed");
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: "Failed to stream embed video.",
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
      if (!thumbnail && upload.hasVideoStream !== false) {
        sendNotFound(res);
        return;
      }

      // Content varies by viewer permission (checked above on every request,
      // including ones that will 304), so caching must stay `private` rather
      // than `public`/shared — a CDN or proxy must never serve a cached copy
      // to a different, unauthorized viewer.
      const etag = thumbnail
        ? `"${thumbnail.id}-${thumbnail.updatedAt.getTime()}"`
        : `"default-audio-thumbnail"`;
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, max-age=604800");
      if (req.headers["if-none-match"] === etag) {
        res.status(304).end();
        return;
      }

      // No real thumbnail on an audio upload — fall back to the bundled
      // speaker-icon placeholder rather than 404ing, matching what
      // `enqueueAudioEmbedVideo`/`finalizeUploadTranscodes` already use as
      // the embed video's visual when there's no real cover art either.
      const thumbnailFilename = thumbnail?.thumbnailFilename ?? DEFAULT_AUDIO_THUMBNAIL_FILENAME;
      const absolutePath = resolveMediaPath(join(THUMBNAILS_SUBDIR, thumbnailFilename));
      const contentType = mimeTypeForImage(thumbnailFilename);
      await streamFileWithRangeSupport(req, res, absolutePath, contentType);
    } catch (err) {
      logger.error({ err }, "getVideoThumbnail failed");
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
    requireApiKeyScope("content_edit"),
    thumbnailUpload.single("file"),
    async (req, res) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (id == null) {
          if (req.file) {
            await unlink(req.file.path).catch(() => {});
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
            await unlink(req.file.path).catch(() => {});
          }
          sendNotFound(res);
          return;
        }

        const { upload } = loaded;
        if (!isOwnerOrAdmin(req.user, req.authRole, upload)) {
          if (req.file) {
            await unlink(req.file.path).catch(() => {});
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

        // Relative to thumbnailsDir, e.g. "42/<uuid>.jpg" — forward slashes
        // for cross-platform DB consistency.
        const relativeThumbnailFilename = relative(thumbnailsDir, req.file.path).replace(/\\/g, "/");

        const [thumbnail, created] = await VideoThumbnail.findOrCreate({
          where: { originalUploadId: upload.id },
          defaults: { thumbnailFilename: relativeThumbnailFilename },
        });

        let previousFilename = null;
        if (!created && thumbnail.thumbnailFilename !== relativeThumbnailFilename) {
          previousFilename = thumbnail.thumbnailFilename;
          await thumbnail.update({ thumbnailFilename: relativeThumbnailFilename });
        }
        if (previousFilename) {
          await unlink(join(thumbnailsDir, previousFilename)).catch(() => {});
        }

        // A user-provided thumbnail always wins and, once set, no
        // auto-generation may ever overwrite it - guards the race where an
        // auto-generation attempt from before this upload was still in
        // flight (see the skipThumbnail check in
        // /internal/thumbnails/:uploadUuid/complete and /failed).
        if (!upload.skipThumbnail) {
          await upload.update({ skipThumbnail: true });
        }

        syncVideoIndex(upload.id);
        const storedFilename = upload.storagePath.replace(/^original\//, "");
        enqueueAudioEmbedVideo(upload, relativeThumbnailFilename, storedFilename);

        res
          .status(200)
          .json({ thumbnailUrl: `/api/v1/videos/${upload.id}/thumbnail` });
      } catch (err) {
        if (req.file) {
          await unlink(req.file.path).catch(() => {});
        }
        logger.error({ err }, "updateVideoThumbnail failed");
        res.status(500).json({
          error: "internal_error",
          message: "Failed to update thumbnail.",
        });
      }
    },
  );
  router.use(thumbnailUploadErrorHandler);

  /**
   * Regenerates a video's auto-generated thumbnail at a specific timestamp,
   * queuing a single processing "thumbnail" job that overwrites whatever
   * thumbnail (auto-generated or manually uploaded) currently exists — the
   * job's output filename is always `<videoId>.<THUMBNAIL_OUTPUT_EXT>`, and
   * `POST /internal/thumbnails/:uploadUuid/complete` (called back by
   * processing once the frame is extracted) updates the existing
   * VIDEO_THUMBNAIL row in place rather than creating a new one. Owner/admin
   * only, matching POST /videos/:id/thumbnail. Video-only — audio uploads
   * never get an auto-generated thumbnail.
   * POST /videos/:id/thumbnail/regenerate — { thumbnailTimestamp: number }.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/videos/{id}/thumbnail/regenerate:
   *   post:
   *     tags: [Videos]
   *     summary: Regenerate a video's thumbnail at a specific timestamp
   *     operationId: regenerateVideoThumbnail
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
   *             required: [thumbnailTimestamp]
   *             properties:
   *               thumbnailTimestamp:
   *                 type: number
   *     responses:
   *       "202":
   *         description: Thumbnail regeneration queued
   *       "400":
   *         description: Invalid id, invalid/missing thumbnailTimestamp, or not a video
   *       "401":
   *         description: Not authenticated
   *       "403":
   *         description: Not the video owner and not an admin
   *       "404":
   *         description: Unknown video id
   *       "502":
   *         description: Processing service unavailable
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 202 on success or an error response.
   */
  router.post(
    "/videos/:id/thumbnail/regenerate",
    requireAuth,
    requireApiKeyScope("content_edit"),
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

        const { upload } = loaded;
        if (!isOwnerOrAdmin(req.user, req.authRole, upload)) {
          res.status(403).json({
            error: "forbidden",
            message: "Only the owner or an admin can update this video's thumbnail.",
          });
          return;
        }

        if (upload.mediaType !== "video") {
          res.status(400).json({
            error: "invalid_body",
            message: "Only videos have an auto-generated thumbnail to regenerate.",
          });
          return;
        }

        const parsedTimestamp = parseThumbnailTimestampTenths(req.body?.thumbnailTimestamp);
        if (!parsedTimestamp.ok || parsedTimestamp.tenths == null) {
          res.status(400).json({
            error: "invalid_body",
            message: parsedTimestamp.ok
              ? "thumbnailTimestamp is required."
              : parsedTimestamp.message,
          });
          return;
        }

        // Derived from storagePath (not reconstructed from videoId+extension)
        // since the on-disk filename is a uuid nested under a per-user
        // subfolder, not the videoId itself — matches transcode-reconcile.js's pattern.
        const storedFilename = upload.storagePath.replace(/^original\//, "");
        const segment = userStorageSegment(upload.userId);
        const enqueue = await requestTranscodeBatch({
          filename: storedFilename,
          jobs: [
            {
              jobId: upload.videoId,
              outputFilename: `${segment}/${upload.videoId}.${THUMBNAIL_OUTPUT_EXT}`,
              kind: "thumbnail",
              timestampSeconds: parsedTimestamp.tenths / 10,
            },
          ],
        });

        if (!enqueue.ok) {
          logger.error({ error: enqueue.error }, "regenerateVideoThumbnail enqueue failed");
          res.status(502).json({
            error: "processing_unavailable",
            message: "Failed to queue thumbnail regeneration.",
          });
          return;
        }

        await upload.update({ thumbnailTimestampTenths: parsedTimestamp.tenths });

        res.status(202).json({ success: true });
      } catch (err) {
        logger.error({ err }, "regenerateVideoThumbnail failed");
        res.status(500).json({
          error: "internal_error",
          message: "Failed to regenerate thumbnail.",
        });
      }
    },
  );

  /**
   * PATCH /videos/:id — updateVideo
   * Auth: required. Owner, admin, or a user with an "edit" VIDEO_ACCESS grant.
   * Body: title, description, visibility, commentsEnabled, createdAt, tags. A
   * caller who is not the owner/admin (i.e. an edit-grantee) may update any
   * field except `visibility` or `createdAt` — including either of those in
   * the body at all is rejected outright (the whole request, not just that
   * field). `createdAt` backdates the video's listed upload date (e.g. for a
   * bulk migration from another platform) and cannot be set in the future.
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
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               title:
   *                 type: string
   *               description:
   *                 type: string
   *                 nullable: true
   *               visibility:
   *                 type: string
   *                 enum: [public, unlisted, private, hidden]
   *               commentsEnabled:
   *                 type: boolean
   *               createdAt:
   *                 type: string
   *                 format: date-time
   *                 description: >
   *                   Backdates the video's upload date. Owner/admin only;
   *                   cannot be in the future.
   *               tags:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       "200":
   *         description: Updated video
   *       "401":
   *         description: Unauthorized
   *       "403":
   *         description: Not the owner/admin/edit-grantee, or an edit-grantee attempted to change visibility or createdAt
   */
  router.patch("/videos/:id", requireAuth, requireApiKeyScope("content_edit"), async (req, res) => {
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
      const isOwnerAdmin = isOwnerOrAdmin(req.user, req.authRole, upload);
      const hasEditGrant = isOwnerAdmin ? false : await userHasEditGrant(upload.id, req.user.id);

      if (!isOwnerAdmin && !hasEditGrant) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the owner, an admin, or a user with edit access can update this video.",
        });
        return;
      }

      if (!isOwnerAdmin && parsed.patch.visibility !== undefined) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the owner or an admin can change this video's visibility.",
        });
        return;
      }

      if (!isOwnerAdmin && parsed.patch.createdAt !== undefined) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the owner or an admin can change this video's upload date.",
        });
        return;
      }

      const previousVisibility = metadata.visibility;

      await sequelize.transaction(async (transaction) => {
        if (Object.keys(parsed.patch).length > 0) {
          // `createdAt` is a Sequelize-managed timestamp attribute: the
          // ordinary set()/update() path treats it as read-only and silently
          // drops it (never marks it "changed", so save() never writes it),
          // so it has to go through setDataValue + an explicit save `fields`
          // list instead.
          const { createdAt, ...restPatch } = parsed.patch;
          if (Object.keys(restPatch).length > 0) {
            await metadata.update(restPatch, { transaction });
          }
          if (createdAt !== undefined) {
            metadata.setDataValue("createdAt", createdAt);
            await metadata.save({ fields: ["createdAt"], transaction });
          }
          if (parsed.patch.visibility === "hidden") {
            // Viewer grants are only meaningful for private videos, so wipe
            // them on entry to hidden rather than leaving stale access
            // behind. Editor grants are meaningful at any visibility and
            // are preserved. Any other visibility change (including back to
            // private) preserves all existing grants.
            const viewPermission = await AccessPermission.findOne({
              where: { name: "view" },
              transaction,
            });
            await VideoAccess.destroy({
              where: { originalUploadId: upload.id, permissionId: viewPermission.id },
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

      if (previousVisibility !== "public" && metadata.visibility === "public") {
        const owner = await User.findByPk(upload.userId);
        const ownerName = owner?.displayName || owner?.username || "Someone";
        const subscribers = await Subscription.findAll({ where: { subscribedToId: upload.userId } });
        await Promise.all(
          subscribers.map((sub) =>
            createNotification({
              recipientUserId: sub.subscriberId,
              actorUserId: upload.userId,
              typeName: "subscription",
              title: "Subscription",
              message: `${ownerName} has posted a new video`,
              target: upload.videoId,
              link: buildPublicLink(`/video?v=${encodeURIComponent(upload.videoId)}`),
            }),
          ),
        );
      }

      const renditions = await loadRenditions(upload);
      const tagsByUploadId = await loadTagsByUploadId([upload.id]);
      const reactionCountsByUploadId = await loadReactionCountsByUploadId([upload.id]);

      res.status(200).json(
        serializeVideo(upload, metadata, {
          tags: tagsByUploadId.get(upload.id) || [],
          renditions,
          viewerPermission: isOwnerAdmin ? "owner" : "edit",
          ...reactionCountsByUploadId.get(upload.id),
        }),
      );
    } catch (err) {
      logger.error({ err }, "updateVideo failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update video.",
      });
    }
  });

  /**
   * POST /videos/:id/tags — addVideoTags
   * Auth: required. Any Trusted User (uploader flag + verified email, admins
   * bypass — see requireUploader) who can view this video. Additive only:
   * merges the given tags into the existing set (deduping case-insensitively)
   * rather than replacing it, so a non-owner can't wipe another user's tags.
   * Owners/admins/edit-grantees needing full add+remove control still use
   * PATCH /videos/:id.
   *
   * @openapi
   * /api/v1/videos/{id}/tags:
   *   post:
   *     tags: [Videos]
   *     summary: Add tags to a video (additive; does not remove existing tags)
   *     operationId: addVideoTags
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
   *             required: [tags]
   *             properties:
   *               tags:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       "200":
   *         description: Updated video
   *       "400":
   *         description: Invalid tags
   *       "401":
   *         description: Unauthorized
   *       "403":
   *         description: Not a Trusted User, or the video isn't visible to the caller
   */
  router.post(
    "/videos/:id/tags",
    requireAuth,
    requireApiKeyScope("content_edit"),
    requireUploader,
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

        const parsed = parseTags(req.body?.tags);
        if (!parsed.ok || parsed.value === undefined) {
          res.status(400).json({
            error: "invalid_body",
            message: parsed.ok ? "tags is required." : parsed.message,
          });
          return;
        }

        const loaded = await loadUploadWithMetadata(id);
        if (!loaded) {
          sendNotFound(res);
          return;
        }

        const { upload, metadata } = loaded;
        const grant = await loadAccessGrant(upload.id, req.user.id);
        if (!canViewVideo(req.user, req.authRole, upload, metadata, Boolean(grant))) {
          sendNotFound(res);
          return;
        }

        const existingTags = await ContentTag.findAll({
          where: { originalUploadId: upload.id },
        });
        const existingKeys = new Set(existingTags.map((row) => row.tag.toLowerCase()));
        const newTags = parsed.value.filter((tag) => !existingKeys.has(tag.toLowerCase()));

        if (existingTags.length + newTags.length > MAX_TAGS) {
          res.status(400).json({
            error: "invalid_body",
            message: `tags must have at most ${MAX_TAGS} items.`,
          });
          return;
        }

        if (newTags.length > 0) {
          await ContentTag.bulkCreate(
            newTags.map((tag) => ({ originalUploadId: upload.id, tag })),
          );
        }

        syncVideoIndex(upload.id);

        const isOwnerAdmin = isOwnerOrAdmin(req.user, req.authRole, upload);
        const hasEditGrant = !isOwnerAdmin && grant?.AccessPermission?.name === "edit";

        const renditions = await loadRenditions(upload);
        const tagsByUploadId = await loadTagsByUploadId([upload.id]);
        const reactionCountsByUploadId = await loadReactionCountsByUploadId([upload.id]);

        res.status(200).json(
          serializeVideo(upload, metadata, {
            tags: tagsByUploadId.get(upload.id) || [],
            renditions,
            viewerPermission: resolveViewerPermission(req.user, req.authRole, upload.userId, hasEditGrant),
            ...reactionCountsByUploadId.get(upload.id),
          }),
        );
      } catch (err) {
        logger.error({ err }, "addVideoTags failed");
        res.status(500).json({
          error: "internal_error",
          message: "Failed to add tags.",
        });
      }
    },
  );

  /**
   * DELETE /videos/:id/tags — removeVideoTags
   * Auth: required. Owner, admin, or moderator (a stricter tier than the
   * additive POST /videos/:id/tags, since removing tags — including ones a
   * Trusted User other than the owner added — is a moderation-level action).
   * Idempotent: tags not currently present are silently ignored.
   *
   * @openapi
   * /api/v1/videos/{id}/tags:
   *   delete:
   *     tags: [Videos]
   *     summary: Remove tags from a video
   *     operationId: removeVideoTags
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
   *             required: [tags]
   *             properties:
   *               tags:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       "200":
   *         description: Updated video
   *       "400":
   *         description: Invalid tags
   *       "401":
   *         description: Unauthorized
   *       "403":
   *         description: Not the owner, an admin, or a moderator
   */
  router.delete(
    "/videos/:id/tags",
    requireAuth,
    requireApiKeyScope("content_edit"),
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

        const parsed = parseTags(req.body?.tags);
        if (!parsed.ok || parsed.value === undefined) {
          res.status(400).json({
            error: "invalid_body",
            message: parsed.ok ? "tags is required." : parsed.message,
          });
          return;
        }

        const loaded = await loadUploadWithMetadata(id);
        if (!loaded) {
          sendNotFound(res);
          return;
        }

        const { upload, metadata } = loaded;
        if (!isOwnerOrAdmin(req.user, req.authRole, upload) && !isModeratorOrAdmin(req.authRole)) {
          res.status(403).json({
            error: "forbidden",
            message: "Only the owner, an admin, or a moderator can remove tags from this video.",
          });
          return;
        }

        if (parsed.value.length > 0) {
          const removeKeys = new Set(parsed.value.map((tag) => tag.toLowerCase()));
          const existingTags = await ContentTag.findAll({
            where: { originalUploadId: upload.id },
          });
          const idsToRemove = existingTags
            .filter((row) => removeKeys.has(row.tag.toLowerCase()))
            .map((row) => row.id);
          if (idsToRemove.length > 0) {
            await ContentTag.destroy({ where: { id: { [Op.in]: idsToRemove } } });
          }
        }

        syncVideoIndex(upload.id);

        const isOwnerAdmin = isOwnerOrAdmin(req.user, req.authRole, upload);
        const grant = await loadAccessGrant(upload.id, req.user.id);
        const hasEditGrant = !isOwnerAdmin && grant?.AccessPermission?.name === "edit";

        const renditions = await loadRenditions(upload);
        const tagsByUploadId = await loadTagsByUploadId([upload.id]);
        const reactionCountsByUploadId = await loadReactionCountsByUploadId([upload.id]);

        res.status(200).json(
          serializeVideo(upload, metadata, {
            tags: tagsByUploadId.get(upload.id) || [],
            renditions,
            viewerPermission: resolveViewerPermission(req.user, req.authRole, upload.userId, hasEditGrant),
            ...reactionCountsByUploadId.get(upload.id),
          }),
        );
      } catch (err) {
        logger.error({ err }, "removeVideoTags failed");
        res.status(500).json({
          error: "internal_error",
          message: "Failed to remove tags.",
        });
      }
    },
  );

  /**
   * DELETE /videos/:id — deleteVideo
   * Auth: required. Owner or admin. Cascades via FK, and also removes the
   * original, thumbnail, and transcoded files from disk.
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
  router.delete("/videos/:id", requireAuth, requireApiKeyScope("content_edit"), async (req, res) => {
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

      const [fileVersions, thumbnail] = await Promise.all([
        FileVersion.findAll({ where: { originalUploadId: id } }),
        VideoThumbnail.findOne({ where: { originalUploadId: id } }),
      ]);
      const mediaFilesToDelete = [resolveMediaPath(upload.storagePath)];
      for (const version of fileVersions) {
        mediaFilesToDelete.push(resolveMediaPath(version.storagePath));
      }
      if (thumbnail) {
        mediaFilesToDelete.push(join(thumbnailsDir, thumbnail.thumbnailFilename));
      }

      await upload.destroy();
      removeVideoDocument(id);
      await Promise.all(mediaFilesToDelete.map((path) => unlink(path).catch(() => {})));

      res.status(200).json({ success: true });
    } catch (err) {
      logger.error({ err }, "deleteVideo failed");
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
   * browse/discovery lists (see `listPublicVideos`). Notifies the video's
   * owner (type "moderation") with a link back to the video.
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
    requireApiKeyScope("full_access"),
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

        await createNotification({
          recipientUserId: upload.userId,
          actorUserId: req.user.id,
          typeName: "moderation",
          title: "Video Moderated",
          message: `Your video "${metadata.title}" was set to unlisted by a moderator.`,
          target: upload.videoId,
          link: buildPublicLink(`/video?v=${encodeURIComponent(upload.videoId)}`),
        });

        const renditions = await loadRenditions(upload);
        const tagsByUploadId = await loadTagsByUploadId([upload.id]);
        const reactionCountsByUploadId = await loadReactionCountsByUploadId([upload.id]);

        res.status(200).json(
          serializeVideo(upload, metadata, {
            tags: tagsByUploadId.get(upload.id) || [],
            renditions,
            ...reactionCountsByUploadId.get(upload.id),
          }),
        );
      } catch (err) {
        logger.error({ err }, "delistVideo failed");
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
    requireApiKeyScope("full_access"),
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
        logger.error({ err }, "setVideoFeatured failed");
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
   *         description: Access grant list, each item including its "view"/"edit" permission
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
        include: [
          { model: User, required: true },
          { model: AccessPermission, required: true },
        ],
        order: [["id", "ASC"]],
      });

      res.status(200).json({
        items: grants.map((grant) => ({
          ...serializeUserRef(
            grant.userId,
            grant.User.username,
            grant.User.displayName,
          ),
          permission: grant.AccessPermission.name,
        })),
      });
    } catch (err) {
      logger.error({ err }, "listVideoAccess failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list video access.",
      });
    }
  });

  /**
   * GET /videos/:id/processing-status — getVideoProcessingStatus
   * Auth: required. Owner or admin. Lightweight polling endpoint the upload
   * page uses to drive the upload/import progress bar (download phase via
   * `status`, transcode phase via complete-vs-total `fileVersions`) without
   * re-fetching the full video payload.
   *
   * @openapi
   * /api/v1/videos/{id}/processing-status:
   *   get:
   *     tags: [Videos]
   *     summary: Get an upload's download/transcode progress
   *     operationId: getVideoProcessingStatus
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
   *         description: Upload status plus per-file-version transcode status
   *       "403":
   *         description: Not the owner or an admin
   *       "404":
   *         description: Not found
   */
  router.get("/videos/:id/processing-status", requireAuth, async (req, res) => {
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
          message: "Only the owner or an admin can view import/processing status.",
        });
        return;
      }

      const versions = await FileVersion.findAll({
        where: { originalUploadId: upload.id },
        order: [["id", "ASC"]],
      });

      res.status(200).json({
        status: upload.status,
        statusMessage: upload.statusMessage ?? null,
        fileVersions: versions.map((v) => ({
          id: v.id,
          resolution: v.resolution,
          status: v.status,
        })),
      });
    } catch (err) {
      logger.error({ err }, "getVideoProcessingStatus failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load processing status.",
      });
    }
  });

  /**
   * PUT /videos/:id/editors — setVideoEditors
   * Auth: required. Owner or admin (edit-grantees cannot manage the access
   * list themselves). Body: `{ usernames: [string, ...] }` replace-all for
   * the video's `"edit"`-level grants only — `"view"` grants are untouched.
   * Unlike viewer grants, editor grants are meaningful (and settable) for a
   * video at any visibility, including `hidden`, so there is no visibility
   * restriction here.
   *
   * @openapi
   * /api/v1/videos/{id}/editors:
   *   put:
   *     tags: [Videos]
   *     summary: Replace editor grants for a video
   *     operationId: setVideoEditors
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
   *             required: [usernames]
   *             properties:
   *               usernames:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       "200":
   *         description: Updated access grant list (all permission levels)
   *       "400":
   *         description: Invalid body or unknown username
   */
  router.put("/videos/:id/editors", requireAuth, requireApiKeyScope("content_edit"), async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const parsed = parseUsernamesBody(req.body);
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
      const { upload } = loaded;
      if (!isOwnerOrAdmin(req.user, req.authRole, upload)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the owner or an admin can set video editors.",
        });
        return;
      }

      const resolved = await resolveUsersByUsername(parsed.usernames);
      if (!resolved.ok) {
        res.status(400).json({ error: "invalid_body", message: resolved.message });
        return;
      }

      const editPermission = await AccessPermission.findOne({ where: { name: "edit" } });
      const items = await replaceVideoAccessForPermission(
        upload.id,
        editPermission.id,
        resolved.users,
      );

      res.status(200).json({ items });
    } catch (err) {
      logger.error({ err }, "setVideoEditors failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to set video editors.",
      });
    }
  });

  /**
   * PUT /videos/:id/viewers — setVideoViewers
   * Auth: required. Owner or admin. Body: `{ usernames: [string, ...] }`
   * replace-all for the video's `"view"`-level grants only — `"edit"`
   * grants are untouched. Only allowed while the video is currently
   * `private`, since viewer grants are only meaningful there (`public`/
   * `unlisted` are already visible to anyone, `hidden` to no one but the
   * owner/admin); viewer grants are wiped automatically if the video is
   * ever set to `hidden` (see `updateVideo`).
   *
   * @openapi
   * /api/v1/videos/{id}/viewers:
   *   put:
   *     tags: [Videos]
   *     summary: Replace viewer grants for a video
   *     operationId: setVideoViewers
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
   *             required: [usernames]
   *             properties:
   *               usernames:
   *                 type: array
   *                 items:
   *                   type: string
   *     responses:
   *       "200":
   *         description: Updated access grant list (all permission levels)
   *       "400":
   *         description: Invalid body, unknown username, or the video is not currently private
   */
  router.put("/videos/:id/viewers", requireAuth, requireApiKeyScope("content_edit"), async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const parsed = parseUsernamesBody(req.body);
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
          message: "Only the owner or an admin can set video viewers.",
        });
        return;
      }
      if (metadata.visibility !== "private") {
        res.status(400).json({
          error: "invalid_state",
          message: "Video viewers can only be managed while the video is private.",
        });
        return;
      }

      const resolved = await resolveUsersByUsername(parsed.usernames);
      if (!resolved.ok) {
        res.status(400).json({ error: "invalid_body", message: resolved.message });
        return;
      }

      const viewPermission = await AccessPermission.findOne({ where: { name: "view" } });
      const items = await replaceVideoAccessForPermission(
        upload.id,
        viewPermission.id,
        resolved.users,
      );

      res.status(200).json({ items });
    } catch (err) {
      logger.error({ err }, "setVideoViewers failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to set video viewers.",
      });
    }
  });

  /**
   * POST /videos/:id/view — recordVideoView
   * Auth: optional. Requires canView. Increments viewCount for every viewer; when
   * authenticated, also upserts the caller's USER_VIEW_HISTORY row for this video
   * (one row per user/video pair - repeat views just bump `updatedAt`).
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
        await UserViewHistory.upsert({
          originalUploadId: upload.id,
          userId: req.user.id,
          updatedAt: sequelize.literal("CURRENT_TIMESTAMP"),
        });
      }

      res.status(200).json({ viewCount: Number(metadata.viewCount) });
    } catch (err) {
      logger.error({ err }, "recordVideoView failed");
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
  router.post("/videos/:id/like", requireAuth, requireApiKeyScope("content_edit"), async (req, res) => {
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

      if (result.liked) {
        await createNotification({
          recipientUserId: upload.userId,
          actorUserId: req.user.id,
          typeName: "like",
          title: "Video received a Like",
          message: `${req.user.displayName || req.user.username} liked your video "${metadata.title}".`,
          target: upload.videoId,
          link: buildPublicLink(`/video?v=${encodeURIComponent(upload.videoId)}`),
        });
      }

      res.status(200).json(result);
    } catch (err) {
      logger.error({ err }, "likeVideo failed");
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
  router.post("/videos/:id/dislike", requireAuth, requireApiKeyScope("content_edit"), async (req, res) => {
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
      logger.error({ err }, "dislikeVideo failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to dislike video.",
      });
    }
  });

  /**
   * POST /videos/:id/hide — hideVideo
   * Auth: required. Requires canView. Hides the video from the caller's own
   * listings/feeds (a per-viewer preference — see lib/video-hidden.js) going
   * forward. Idempotent. A caller cannot hide their own uploaded video.
   *
   * @openapi
   * /api/v1/videos/{id}/hide:
   *   post:
   *     tags: [Videos]
   *     summary: Hide a video from the caller's own listings (idempotent)
   *     operationId: hideVideo
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Numeric video id or its public videoId.
   *     responses:
   *       "200":
   *         description: Resulting hidden state
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 hidden:
   *                   type: boolean
   *       "400":
   *         description: Cannot hide your own video
   *       "404":
   *         description: Video not found or inaccessible
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the resulting hidden state or an error response.
   */
  router.post("/videos/:id/hide", requireAuth, requireApiKeyScope("content_edit"), async (req, res) => {
    try {
      const loaded = await loadUploadWithMetadataByIdentifier(req.params.id);
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

      if (upload.userId != null && Number(upload.userId) === Number(req.user.id)) {
        res.status(400).json({
          error: "invalid_body",
          message: "You cannot hide your own video.",
        });
        return;
      }

      await UserHiddenVideo.findOrCreate({
        where: { userId: req.user.id, originalUploadId: upload.id },
      });

      res.status(200).json({ hidden: true });
    } catch (err) {
      logger.error({ err }, "hideVideo failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to hide video.",
      });
    }
  });

  /**
   * DELETE /videos/:id/hide — unhideVideo
   * Auth: required. Deliberately does not require canView — a caller must be
   * able to unhide a video precisely in the case where they otherwise
   * couldn't see it. Accepts either the numeric id or the public videoId
   * (like getVideo) since the caller may only know the videoId from the URL
   * when the video is currently masked as hidden. Idempotent, including when
   * the identifier doesn't resolve to any video.
   *
   * @openapi
   * /api/v1/videos/{id}/hide:
   *   delete:
   *     tags: [Videos]
   *     summary: Unhide a previously-hidden video (idempotent)
   *     operationId: unhideVideo
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *         description: Numeric video id or its public videoId.
   *     responses:
   *       "200":
   *         description: Resulting hidden state (or was already not hidden)
   *       "401":
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the resulting hidden state or an error response.
   */
  router.delete("/videos/:id/hide", requireAuth, requireApiKeyScope("content_edit"), async (req, res) => {
    try {
      const loaded = await loadUploadWithMetadataByIdentifier(req.params.id);
      if (!loaded) {
        res.status(200).json({ hidden: false });
        return;
      }

      await UserHiddenVideo.destroy({
        where: { userId: req.user.id, originalUploadId: loaded.upload.id },
      });

      res.status(200).json({ hidden: false });
    } catch (err) {
      logger.error({ err }, "unhideVideo failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to unhide video.",
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
  router.post("/videos/:id/comments", requireAuth, requireApiKeyScope("content_edit"), async (req, res) => {
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

      await createNotification({
        recipientUserId: upload.userId,
        actorUserId: req.user.id,
        typeName: "comment",
        title: "New comment on video",
        message: `${req.user.displayName || req.user.username} commented on your video "${metadata.title}".`,
        target: upload.videoId,
        link: buildPublicLink(`/video?v=${encodeURIComponent(upload.videoId)}`),
      });

      res.status(201).json(serializeComment(comment));
    } catch (err) {
      logger.error({ err }, "createComment failed");
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
      logger.error({ err }, "listComments failed");
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
    requireApiKeyScope("content_edit"),
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
        if (
          !comment ||
          comment.originalUploadId !== upload.id ||
          comment.deletedAt
        ) {
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
        logger.error({ err }, "updateComment failed");
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
   * comment unconditionally. This is a soft delete (`deletedAt` is set, the
   * row and its replies are kept) — `serializeComment` redacts the author and
   * body once `deletedAt` is set, and replies are left untouched rather than
   * cascade-deleted, since removing a comment shouldn't destroy conversation
   * that grew on top of it. When a moderator/admin deletes someone else's
   * comment (not a self-delete), the author gets a "moderation" notification;
   * `createNotification` itself already no-ops on self-notifications, so an
   * author who happens to be a moderator/admin deleting their own comment is
   * covered without an extra check.
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
    requireApiKeyScope("content_edit"),
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
        if (
          !comment ||
          comment.originalUploadId !== upload.id ||
          comment.deletedAt
        ) {
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

        await comment.update({ deletedAt: new Date() });

        await createNotification({
          recipientUserId: comment.userId,
          actorUserId: req.user.id,
          typeName: "moderation",
          title: "Comment Removed",
          message: `Your comment on "${metadata.title}" was removed by a moderator.`,
          target: upload.videoId,
          link: buildPublicLink(`/video?v=${encodeURIComponent(upload.videoId)}`),
        });

        res.status(204).send();
      } catch (err) {
        logger.error({ err }, "deleteComment failed");
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
      logger.error({ err }, "listTags failed");
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
   *         description: Paginated tagged public videos
   *       "400":
   *         description: Invalid tag, page, or limit
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

      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { items, totalHits } = await listPublicVideos({
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
        viewerUser: req.user ?? null,
        viewerRole: req.authRole ?? null,
        page,
        limit,
      });
      res.status(200).json({
        items,
        page,
        limit,
        totalHits,
        totalPages: totalHits === 0 ? 0 : Math.ceil(totalHits / limit),
      });
    } catch (err) {
      logger.error({ err }, "listTagVideos failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list tag videos.",
      });
    }
  });

  /**
   * GET /feed/subscriptions — feedSubscriptions
   * Auth: required. Public videos from subscribed channels that the caller
   * hasn't already watched (per USER_VIEW_HISTORY), newest first.
   *
   * @openapi
   * /api/v1/feed/subscriptions:
   *   get:
   *     tags: [Videos]
   *     summary: Subscription feed of new (unwatched) public videos
   *     operationId: feedSubscriptions
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
   *       "200":
   *         description: Paginated subscription feed, excluding videos already in the caller's watch history
   *       "400":
   *         description: Invalid page/limit
   *       "401":
   *         description: Unauthorized
   */
  router.get("/feed/subscriptions", requireAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const subscriptions = await Subscription.findAll({
        where: { subscriberId: req.user.id },
        attributes: ["subscribedToId"],
      });
      const channelIds = subscriptions.map((row) => row.subscribedToId);
      if (channelIds.length === 0) {
        res.status(200).json({ items: [], page, limit, totalHits: 0, totalPages: 0 });
        return;
      }

      // Exclude already-watched videos before pagination (not after), so a
      // page always comes back with `limit` items and `totalHits` reflects
      // only what the caller would actually see.
      const watchedRows = await UserViewHistory.findAll({
        where: { userId: req.user.id },
        attributes: ["originalUploadId"],
      });
      const watchedIds = watchedRows.map((row) => row.originalUploadId);

      const uploadWhere = { userId: { [Op.in]: channelIds } };
      if (watchedIds.length > 0) {
        uploadWhere.id = { [Op.notIn]: watchedIds };
      }

      const { items, totalHits } = await listPublicVideos({
        uploadWhere,
        order: [
          [{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"],
        ],
        viewerUserId: req.user.id,
        viewerUser: req.user,
        viewerRole: req.authRole,
        page,
        limit,
      });

      res.status(200).json({
        items,
        page,
        limit,
        totalHits,
        totalPages: totalHits === 0 ? 0 : Math.ceil(totalHits / limit),
      });
    } catch (err) {
      logger.error({ err }, "feedSubscriptions failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load subscription feed.",
      });
    }
  });

  return router;
}
