import { join } from "node:path";
import { Router } from "express";
import { Op, literal } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { optionalAuth, requireAuth } from "../lib/auth/require-auth.js";
import { requireModerator } from "../lib/auth/require-moderator.js";
import { mimeTypeForImage, resolveMediaPath } from "../lib/media-meta.js";
import { VISIBILITY_VALUES } from "../lib/models/constants.js";
import {
  ContentTag,
  FeaturedVideo,
  FileVersion,
  OriginalUpload,
  Subscription,
  User,
  VideoAccess,
  VideoLike,
  VideoMetadata,
  VideoThumbnail,
  sequelize,
} from "../lib/models/index.js";
import {
  canViewVideo,
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
 * @param {Array<{resolution: string|null, width: number|null, height: number|null}>} [options.renditions]
 *   Available complete renditions (full `getVideo` only — omitted elsewhere to
 *   keep list/search responses lightweight).
 * @returns {{
 *   id: number,
 *   title: string,
 *   description: string|null,
 *   visibility: string,
 *   commentsEnabled: boolean,
 *   viewCount: number,
 *   uploader: {userId: number|null, username: string|null, displayName: string|null},
 *   durationSeconds: number|null,
 *   thumbnailUrl: string|null,
 *   createdAt: Date,
 *   updatedAt: Date
 * }} Public video payload.
 */
export function serializeVideo(upload, metadata, options = {}) {
  const payload = {
    id: upload.id,
    title: metadata.title,
    description: metadata.description ?? null,
    visibility: metadata.visibility,
    commentsEnabled: Boolean(metadata.commentsEnabled),
    viewCount: Number(metadata.viewCount ?? 0),
    uploader: serializeUserRef(upload.userId, upload.User?.username, upload.User?.displayName),
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
  return payload;
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
 * ordered. Public videos are always included; `unlisted`/`hidden` videos are
 * included only for their owner (`options.viewerUserId`) — everyone else
 * never sees delisted or hidden content in these bulk lists.
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
      "$VideoMetadata.visibility$": { [Op.in]: ["unlisted", "hidden"] },
    });
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

  return rows.map((upload) => serializeVideo(upload, upload.VideoMetadata));
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

  if (
    Object.keys(patch).length === 0 &&
    tags.value === undefined
  ) {
    return {
      ok: false,
      message: "At least one of title, description, visibility, commentsEnabled, or tags is required.",
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
      return { ok: false, message: "usernames entries must be non-empty strings." };
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
        order: [[{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"]],
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
        order: [[{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"]],
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
   * Auth: optional. Private requires owner, grant, or admin.
   *
   * @openapi
   * /api/v1/videos/{id}:
   *   get:
   *     tags: [Videos]
   *     summary: Get a video by id
   *     operationId: getVideo
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Video metadata
   *       "404":
   *         description: Not found or inaccessible
   */
  router.get("/videos/:id", optionalAuth, async (req, res) => {
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

      const completeVersions = await FileVersion.findAll({
        where: { originalUploadId: upload.id, status: "complete" },
        order: [["videoHeight", "ASC"]],
      });

      res.status(200).json(
        serializeVideo(upload, metadata, {
          renditions: completeVersions.map((version) => ({
            resolution: version.resolution,
            width: version.videoWidth,
            height: version.videoHeight,
          })),
        }),
      );
    } catch (err) {
      console.error("getVideo failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load video.",
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
   *           Resolution label (e.g. "720p") matching a complete rendition.
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

      const renditions = await FileVersion.findAll({
        where: { originalUploadId: upload.id, status: "complete" },
      });
      if (renditions.length === 0) {
        sendNotFound(res);
        return;
      }

      const requestedQuality =
        typeof req.query.quality === "string" ? req.query.quality.trim() : "";

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
      await streamFileWithRangeSupport(req, res, absolutePath, version.mimeType);
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
      res.status(200).json(serializeVideo(upload, metadata));
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
   *       "204":
   *         description: Deleted
   */
  router.delete("/videos/:id", requireAuth, async (req, res) => {
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
          message: "Only the owner or an admin can delete this video.",
        });
        return;
      }

      await upload.destroy();
      removeVideoDocument(id);
      res.status(204).end();
    } catch (err) {
      console.error("deleteVideo failed:", err);
      res.status(500).json({
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
        res.status(200).json(serializeVideo(upload, metadata));
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
          serializeUserRef(grant.userId, grant.User.username, grant.User.displayName),
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
          message: "Video access can only be managed while the video is private.",
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
          serializeUserRef(grant.userId, grant.User.username, grant.User.displayName),
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
   * Auth: optional. Requires canView. Increments viewCount.
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
   * Auth: required. Requires canView. Upserts like row.
   *
   * @openapi
   * /api/v1/videos/{id}/like:
   *   post:
   *     tags: [Videos]
   *     summary: Like a video
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
   *         description: Like recorded
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

      const existing = await VideoLike.findOne({
        where: {
          originalUploadId: upload.id,
          userId: req.user.id,
        },
      });
      if (!existing) {
        await VideoLike.create({
          originalUploadId: upload.id,
          userId: req.user.id,
          likeValue: 1,
        });
      }

      res.status(200).json({ liked: true });
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
   * Auth: required. Requires canView. Deletes like row.
   *
   * @openapi
   * /api/v1/videos/{id}/dislike:
   *   post:
   *     tags: [Videos]
   *     summary: Remove a like (dislike)
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
   *         description: Like cleared
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

      await VideoLike.destroy({
        where: {
          originalUploadId: upload.id,
          userId: req.user.id,
        },
      });

      res.status(200).json({ liked: false });
    } catch (err) {
      console.error("dislikeVideo failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to dislike video.",
      });
    }
  });

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
          [literal("COUNT(DISTINCT `ContentTag`.`original_upload_id`)"), "videoCount"],
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
        order: [[{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"]],
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
        order: [[{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"]],
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
