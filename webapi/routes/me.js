import { Router } from "express";
import { Op } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import {
  OriginalUpload,
  User,
  VideoAccess,
  VideoLike,
  VideoMetadata,
  VideoThumbnail,
} from "../lib/models/index.js";
import { serializeVideo } from "./videos.js";

/**
 * Maximum page size for GET /me/videos and GET /me/likes.
 *
 * @type {number}
 */
const MAX_LIMIT = 99;

/**
 * Default page size for GET /me/videos and GET /me/likes.
 *
 * @type {number}
 */
const DEFAULT_LIMIT = 20;

const FORBIDDEN_FIELDS = [
  "id",
  "username",
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
 * Validates and normalizes a `PATCH /me` request body. Only `displayName`,
 * `bio`, and `email` may be changed; any other known User field present in
 * the body is rejected rather than silently ignored.
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
    updates.email = email;
  }

  if (Object.keys(updates).length === 0) {
    return { ok: false, message: "No editable fields provided." };
  }

  return { ok: true, updates };
}

/**
 * Parses and validates `page`/`limit` query params shared by GET /me/videos
 * and GET /me/likes.
 *
 * @param {import('express').Request['query']} query Raw Express query object.
 * @returns {{ok: true, page: number, limit: number}|{ok: false, message: string}}
 *   Parsed pagination or a validation error.
 */
function parsePagination(query) {
  const pageRaw = query.page === undefined ? 1 : Number(query.page);
  if (!Number.isInteger(pageRaw) || pageRaw < 1) {
    return { ok: false, message: "page must be a positive integer." };
  }

  const limitRaw = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) {
    return { ok: false, message: "limit must be a positive integer." };
  }
  if (limitRaw > MAX_LIMIT) {
    return { ok: false, message: "limit must be less than 100." };
  }

  return { ok: true, page: pageRaw, limit: limitRaw };
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
   * Updates the authenticated user's editable account fields (`displayName`,
   * `bio`, `email`). Changing `email` resets `emailVerified`/`emailVerifiedAt`.
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
   *         description: Email already registered to another account
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
        ],
        order: [[{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"]],
        limit,
        offset: (page - 1) * limit,
      });

      res.status(200).json({
        items: rows.map((upload) => serializeVideo(upload, upload.VideoMetadata)),
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
   * currently see: public/unlisted always; private only with ownership or a
   * VIDEO_ACCESS grant; hidden only when the user owns it.
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

      const likes = await VideoLike.findAll({
        where: { userId: req.user.id, likeValue: { [Op.gt]: 0 } },
        include: [
          {
            model: OriginalUpload,
            required: true,
            include: [
              { model: VideoMetadata, as: "VideoMetadata", required: true },
              { model: VideoThumbnail, required: false },
            ],
          },
        ],
        order: [["createdAt", "DESC"]],
      });

      const visibleLikes = likes.filter((like) => {
        const upload = like.OriginalUpload;
        const { visibility } = upload.VideoMetadata;
        const isOwner =
          upload.userId != null && Number(upload.userId) === Number(req.user.id);
        if (visibility === "public" || visibility === "unlisted") {
          return true;
        }
        if (visibility === "private") {
          return isOwner || grantedUploadIds.has(upload.id);
        }
        if (visibility === "hidden") {
          return isOwner;
        }
        return false;
      });

      const totalHits = visibleLikes.length;
      const offset = (page - 1) * limit;
      const pageLikes = visibleLikes.slice(offset, offset + limit);

      res.status(200).json({
        items: pageLikes.map((like) =>
          serializeVideo(like.OriginalUpload, like.OriginalUpload.VideoMetadata),
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

  return router;
}
