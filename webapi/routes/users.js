import { join } from "node:path";
import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { mimeTypeForImage } from "../lib/media-meta.js";
import {
  OriginalUpload,
  Role,
  Subscription,
  User,
  VideoMetadata,
  VideoThumbnail,
} from "../lib/models/index.js";
import { parsePagination } from "../lib/pagination.js";
import { streamFileWithRangeSupport } from "../lib/range-stream.js";
import { resolveSitedataPath } from "../lib/sitedata-meta.js";
import { serializeVideo } from "./videos.js";

/**
 * Sends a standard 404 for an unknown username or missing avatar.
 *
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendNotFound(res) {
  res.status(404).json({ error: "not_found", message: "Avatar not found." });
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
 * Maps a User instance to the public channel-profile shape.
 *
 * @param {import('sequelize').Model} user User model instance.
 * @returns {{id: number, username: string, displayName: string|null, bio: string|null, avatarFilename: string|null}}
 *   Public-safe channel profile payload.
 */
function serializeChannelUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName ?? null,
    bio: user.bio ?? null,
    avatarFilename: user.avatarFilename ?? null,
  };
}

/**
 * Loads a paginated page of a user's public videos, newest first.
 *
 * @param {number} userId Target user's id.
 * @param {{page: number, limit: number}} pagination Parsed pagination.
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 *   Paginated public video list envelope.
 */
async function loadUserPublicVideosPage(userId, pagination) {
  const { page, limit } = pagination;
  const { rows, count } = await OriginalUpload.findAndCountAll({
    where: { userId },
    include: [
      {
        model: VideoMetadata,
        as: "VideoMetadata",
        required: true,
        where: { visibility: "public" },
      },
      { model: VideoThumbnail, required: false },
      { model: User, required: false },
    ],
    order: [[{ model: VideoMetadata, as: "VideoMetadata" }, "createdAt", "DESC"]],
    limit,
    offset: (page - 1) * limit,
  });

  return {
    items: rows.map((upload) => serializeVideo(upload, upload.VideoMetadata)),
    page,
    limit,
    totalHits: count,
    totalPages: count === 0 ? 0 : Math.ceil(count / limit),
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
   * Returns a user's public channel profile plus a paginated page of their
   * public videos, newest first.
   * GET /api/v1/users/:username
   * Auth: none required (public).
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
   *     responses:
   *       "200":
   *         description: Channel profile and a paginated page of public videos
   *       "400":
   *         description: Invalid page/limit
   *       "404":
   *         description: Unknown username
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the channel profile or an error response.
   */
  router.get("/users/:username", async (req, res) => {
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

      const videos = await loadUserPublicVideosPage(user.id, pagination);
      res.status(200).json({ user: serializeChannelUser(user), videos });
    } catch (err) {
      console.error("getUserChannel failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load channel.",
      });
    }
  });

  /**
   * Returns a paginated list of a user's public videos, newest first.
   * GET /api/v1/users/:username/videos
   * Auth: none required (public).
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
   *     responses:
   *       "200":
   *         description: Paginated list of the user's public videos
   *       "400":
   *         description: Invalid page/limit
   *       "404":
   *         description: Unknown username
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated video list or an error response.
   */
  router.get("/users/:username/videos", async (req, res) => {
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

      const videos = await loadUserPublicVideosPage(user.id, pagination);
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
  router.post("/users/:id/subscribe", requireAuth, async (req, res) => {
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

      await Subscription.findOrCreate({
        where: { subscriberId: req.user.id, subscribedToId: targetId },
      });

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
  router.delete("/users/:id/subscribe", requireAuth, async (req, res) => {
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
  router.post("/users/:id/ban", requireAuth, requireAdmin, async (req, res) => {
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
  router.delete("/users/:id/ban", requireAuth, requireAdmin, async (req, res) => {
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

  return router;
}
