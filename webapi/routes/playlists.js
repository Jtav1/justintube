import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { optionalAuth, requireAuth } from "../lib/auth/require-auth.js";
import { VISIBILITY_VALUES } from "../lib/models/constants.js";
import {
  OriginalUpload,
  PlaylistAccess,
  PlaylistItem,
  User,
  UserPlaylist,
  VideoMetadata,
  VideoThumbnail,
} from "../lib/models/index.js";
import { canViewPlaylist } from "../lib/playlist-access.js";
import { serializeUserRef } from "../lib/serialize-user-ref.js";
import { isOwnerOrAdmin } from "../lib/video-access.js";
import { serializeVideo } from "./videos.js";

/**
 * Parses a route param as a positive integer.
 *
 * @param {unknown} raw Raw path parameter.
 * @returns {number|null} Parsed id, or null when invalid.
 */
function parsePositiveInt(raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return null;
  }
  return value;
}

/**
 * Sends 404 for a missing or unviewable playlist.
 *
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendNotFound(res) {
  res.status(404).json({
    error: "not_found",
    message: "Playlist not found.",
  });
}

/**
 * Serializes a USER_PLAYLISTS row into the public Playlist shape.
 *
 * @param {import('sequelize').Model} playlist USER_PLAYLISTS row.
 * @param {number} itemCount Number of PLAYLIST_ITEMS rows for this playlist.
 * @returns {object} Public playlist payload.
 */
function serializePlaylist(playlist, itemCount) {
  return {
    id: playlist.id,
    name: playlist.title,
    description: playlist.description ?? null,
    visibility: playlist.visibility,
    itemCount,
    lastAddedAt: playlist.lastAddedAt ?? null,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
  };
}

/**
 * Returns whether the given user has a PLAYLIST_ACCESS grant on the playlist.
 *
 * @param {number} playlistId USER_PLAYLISTS id.
 * @param {number|null|undefined} userId Authenticated user id.
 * @returns {Promise<boolean>} True when a grant row exists.
 */
async function userHasAccessGrant(playlistId, userId) {
  if (!userId) {
    return false;
  }
  const grant = await PlaylistAccess.findOne({ where: { playlistId, userId } });
  return Boolean(grant);
}

/**
 * Builds the playlists router.
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createPlaylistsRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * POST /playlists — createPlaylist
   * Auth: required. Creates a playlist owned by the caller.
   *
   * @openapi
   * /api/v1/playlists:
   *   post:
   *     tags: [Playlists]
   *     summary: Create a playlist
   *     operationId: createPlaylist
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [name]
   *             properties:
   *               name:
   *                 type: string
   *               description:
   *                 type: string
   *               visibility:
   *                 type: string
   *                 enum: [public, private, unlisted, hidden]
   *     responses:
   *       "201":
   *         description: Created playlist
   *       "400":
   *         description: Invalid body
   */
  router.post("/playlists", requireAuth, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const name = String(body.name ?? "").trim();
      if (!name) {
        res.status(400).json({
          error: "invalid_body",
          message: "name is required.",
        });
        return;
      }

      const description =
        body.description == null ? null : String(body.description);

      let visibility = "private";
      if (body.visibility != null) {
        visibility = String(body.visibility);
        if (!VISIBILITY_VALUES.includes(visibility)) {
          res.status(400).json({
            error: "invalid_body",
            message: `visibility must be one of: ${VISIBILITY_VALUES.join(", ")}.`,
          });
          return;
        }
      }

      const playlist = await UserPlaylist.create({
        userId: req.user.id,
        title: name,
        description,
        visibility,
      });

      res.status(201).json(serializePlaylist(playlist, 0));
    } catch (err) {
      console.error("createPlaylist failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to create playlist.",
      });
    }
  });

  /**
   * GET /playlists/:id — getPlaylist
   * Auth: optional. Returns the playlist and its items when viewable.
   *
   * @openapi
   * /api/v1/playlists/{id}:
   *   get:
   *     tags: [Playlists]
   *     summary: Get a playlist and its items
   *     operationId: getPlaylist
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Playlist with items
   *       "404":
   *         description: Playlist not found or not viewable
   */
  router.get("/playlists/:id", optionalAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const playlist = await UserPlaylist.findByPk(id);
      if (!playlist) {
        sendNotFound(res);
        return;
      }

      const hasGrant = await userHasAccessGrant(playlist.id, req.user?.id);
      if (!canViewPlaylist(req.user, req.authRole, playlist, hasGrant)) {
        sendNotFound(res);
        return;
      }

      const items = await PlaylistItem.findAll({
        where: { playlistId: playlist.id },
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
        order: [
          ["position", "ASC"],
          ["addedAt", "ASC"],
        ],
      });

      const payload = serializePlaylist(playlist, items.length);
      payload.items = items.map((item) =>
        serializeVideo(item.OriginalUpload, item.OriginalUpload.VideoMetadata),
      );

      res.status(200).json(payload);
    } catch (err) {
      console.error("getPlaylist failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to get playlist.",
      });
    }
  });

  /**
   * PATCH /playlists/:id — updatePlaylist
   * Auth: required. Owner or admin.
   *
   * @openapi
   * /api/v1/playlists/{id}:
   *   patch:
   *     tags: [Playlists]
   *     summary: Update playlist metadata
   *     operationId: updatePlaylist
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
   *         description: Updated playlist
   *       "403":
   *         description: Not the owner or an admin
   *       "404":
   *         description: Playlist not found
   */
  router.patch("/playlists/:id", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const playlist = await UserPlaylist.findByPk(id);
      if (!playlist) {
        sendNotFound(res);
        return;
      }
      if (!isOwnerOrAdmin(req.user, req.authRole, playlist)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner or an admin can update this playlist.",
        });
        return;
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const updates = {};

      if (body.name !== undefined) {
        const name = String(body.name ?? "").trim();
        if (!name) {
          res.status(400).json({
            error: "invalid_body",
            message: "name must be a non-empty string.",
          });
          return;
        }
        updates.title = name;
      }

      if (body.description !== undefined) {
        updates.description = body.description == null ? null : String(body.description);
      }

      if (body.visibility !== undefined) {
        const visibility = String(body.visibility);
        if (!VISIBILITY_VALUES.includes(visibility)) {
          res.status(400).json({
            error: "invalid_body",
            message: `visibility must be one of: ${VISIBILITY_VALUES.join(", ")}.`,
          });
          return;
        }
        updates.visibility = visibility;
      }

      await playlist.update(updates);

      const itemCount = await PlaylistItem.count({ where: { playlistId: playlist.id } });
      res.status(200).json(serializePlaylist(playlist, itemCount));
    } catch (err) {
      console.error("updatePlaylist failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update playlist.",
      });
    }
  });

  /**
   * DELETE /playlists/:id — deletePlaylist
   * Auth: required. Owner or admin. Cascades to PLAYLIST_ITEMS and PLAYLIST_ACCESS.
   *
   * @openapi
   * /api/v1/playlists/{id}:
   *   delete:
   *     tags: [Playlists]
   *     summary: Delete a playlist
   *     operationId: deletePlaylist
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
   *         description: Playlist deleted
   *       "403":
   *         description: Not the owner or an admin
   *       "404":
   *         description: Playlist not found
   */
  router.delete("/playlists/:id", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const playlist = await UserPlaylist.findByPk(id);
      if (!playlist) {
        sendNotFound(res);
        return;
      }
      if (!isOwnerOrAdmin(req.user, req.authRole, playlist)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner or an admin can delete this playlist.",
        });
        return;
      }

      await playlist.destroy();
      res.status(204).send();
    } catch (err) {
      console.error("deletePlaylist failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to delete playlist.",
      });
    }
  });

  /**
   * POST /playlists/:id/items — addPlaylistItem
   * Auth: required. Playlist owner only.
   *
   * @openapi
   * /api/v1/playlists/{id}/items:
   *   post:
   *     tags: [Playlists]
   *     summary: Add a video to a playlist
   *     operationId: addPlaylistItem
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
   *             required: [videoId]
   *             properties:
   *               videoId:
   *                 type: string
   *     responses:
   *       "200":
   *         description: Updated item count
   *       "403":
   *         description: Not the playlist owner or an admin
   *       "404":
   *         description: Playlist not found
   *       "409":
   *         description: Video is already in the playlist
   */
  router.post("/playlists/:id/items", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const playlist = await UserPlaylist.findByPk(id);
      if (!playlist) {
        sendNotFound(res);
        return;
      }
      if (!isOwnerOrAdmin(req.user, req.authRole, playlist)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner or an admin can add items to this playlist.",
        });
        return;
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const videoId = parsePositiveInt(body.videoId);
      if (videoId == null) {
        res.status(400).json({
          error: "invalid_body",
          message: "videoId must be a positive integer.",
        });
        return;
      }

      const upload = await OriginalUpload.findByPk(videoId);
      if (!upload) {
        res.status(400).json({
          error: "invalid_body",
          message: "videoId does not refer to an existing video.",
        });
        return;
      }

      try {
        await PlaylistItem.create({
          playlistId: playlist.id,
          originalUploadId: videoId,
        });
      } catch (err) {
        if (err.name === "SequelizeUniqueConstraintError") {
          res.status(409).json({
            error: "conflict",
            message: "This video is already in the playlist.",
          });
          return;
        }
        throw err;
      }

      await playlist.update({ lastAddedAt: new Date() });

      const itemCount = await PlaylistItem.count({ where: { playlistId: playlist.id } });
      res.status(200).json({ itemCount });
    } catch (err) {
      console.error("addPlaylistItem failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to add item to playlist.",
      });
    }
  });

  /**
   * DELETE /playlists/:id/items/:videoId — removePlaylistItem
   * Auth: required. Playlist owner only.
   *
   * @openapi
   * /api/v1/playlists/{id}/items/{videoId}:
   *   delete:
   *     tags: [Playlists]
   *     summary: Remove a video from a playlist
   *     operationId: removePlaylistItem
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
   *         name: videoId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Updated item count
   *       "403":
   *         description: Not the playlist owner or an admin
   *       "404":
   *         description: Playlist not found
   */
  router.delete("/playlists/:id/items/:videoId", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      const videoId = parsePositiveInt(req.params.videoId);
      if (id == null || videoId == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id and videoId must be positive integers.",
        });
        return;
      }

      const playlist = await UserPlaylist.findByPk(id);
      if (!playlist) {
        sendNotFound(res);
        return;
      }
      if (!isOwnerOrAdmin(req.user, req.authRole, playlist)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner or an admin can remove items from this playlist.",
        });
        return;
      }

      await PlaylistItem.destroy({
        where: { playlistId: playlist.id, originalUploadId: videoId },
      });

      const itemCount = await PlaylistItem.count({ where: { playlistId: playlist.id } });
      res.status(200).json({ itemCount });
    } catch (err) {
      console.error("removePlaylistItem failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to remove item from playlist.",
      });
    }
  });

  /**
   * GET /playlists/:id/access — listPlaylistAccess
   * Auth: required. Owner or admin.
   *
   * @openapi
   * /api/v1/playlists/{id}/access:
   *   get:
   *     tags: [Playlists]
   *     summary: List private-access grants for a playlist
   *     operationId: listPlaylistAccess
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
   *       "403":
   *         description: Not the owner or an admin
   *       "404":
   *         description: Playlist not found
   */
  router.get("/playlists/:id/access", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const playlist = await UserPlaylist.findByPk(id);
      if (!playlist) {
        sendNotFound(res);
        return;
      }
      if (!isOwnerOrAdmin(req.user, req.authRole, playlist)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner or an admin can list playlist access.",
        });
        return;
      }

      const grants = await PlaylistAccess.findAll({
        where: { playlistId: playlist.id },
        include: [{ model: User, required: true }],
        order: [["id", "ASC"]],
      });

      res.status(200).json({
        items: grants.map((grant) =>
          serializeUserRef(grant.userId, grant.User.username, grant.User.displayName),
        ),
      });
    } catch (err) {
      console.error("listPlaylistAccess failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list playlist access.",
      });
    }
  });

  /**
   * POST /playlists/:id/access — addPlaylistAccess
   * Auth: required. Owner or admin. Grants a single user access to a private playlist.
   *
   * @openapi
   * /api/v1/playlists/{id}/access:
   *   post:
   *     tags: [Playlists]
   *     summary: Grant a user access to a playlist
   *     operationId: addPlaylistAccess
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
   *             required: [username]
   *             properties:
   *               username:
   *                 type: string
   *     responses:
   *       "200":
   *         description: Grant created (or already existed)
   *       "400":
   *         description: Invalid body
   *       "403":
   *         description: Not the owner or an admin
   *       "404":
   *         description: Playlist or user not found
   */
  router.post("/playlists/:id/access", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const playlist = await UserPlaylist.findByPk(id);
      if (!playlist) {
        sendNotFound(res);
        return;
      }
      if (!isOwnerOrAdmin(req.user, req.authRole, playlist)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner or an admin can grant playlist access.",
        });
        return;
      }

      const body = req.body && typeof req.body === "object" ? req.body : {};
      const username = String(body.username ?? "").trim();
      if (!username) {
        res.status(400).json({
          error: "invalid_body",
          message: "username is required.",
        });
        return;
      }

      const targetUser = await User.findOne({ where: { username } });
      if (!targetUser) {
        res.status(404).json({
          error: "not_found",
          message: "Unknown username.",
        });
        return;
      }

      if (playlist.userId != null && Number(targetUser.id) === Number(playlist.userId)) {
        res.status(400).json({
          error: "invalid_body",
          message: "The playlist owner already has access.",
        });
        return;
      }

      await PlaylistAccess.findOrCreate({
        where: { playlistId: playlist.id, userId: targetUser.id },
      });

      res.status(200).json({
        ...serializeUserRef(targetUser.id, targetUser.username, targetUser.displayName),
        granted: true,
      });
    } catch (err) {
      console.error("addPlaylistAccess failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to grant playlist access.",
      });
    }
  });

  /**
   * DELETE /playlists/:id/access/:userId — removePlaylistAccess
   * Auth: required. Owner or admin. Revokes a user's access to a private playlist.
   *
   * @openapi
   * /api/v1/playlists/{id}/access/{userId}:
   *   delete:
   *     tags: [Playlists]
   *     summary: Revoke a user's access to a playlist
   *     operationId: removePlaylistAccess
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
   *         name: userId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Grant revoked (or did not exist)
   *       "403":
   *         description: Not the owner or an admin
   *       "404":
   *         description: Playlist not found
   */
  router.delete("/playlists/:id/access/:userId", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      const userId = parsePositiveInt(req.params.userId);
      if (id == null || userId == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id and userId must be positive integers.",
        });
        return;
      }

      const playlist = await UserPlaylist.findByPk(id);
      if (!playlist) {
        sendNotFound(res);
        return;
      }
      if (!isOwnerOrAdmin(req.user, req.authRole, playlist)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner or an admin can revoke playlist access.",
        });
        return;
      }

      const targetUser = await User.findByPk(userId);

      await PlaylistAccess.destroy({
        where: { playlistId: playlist.id, userId },
      });

      res.status(200).json({
        ...serializeUserRef(userId, targetUser?.username, targetUser?.displayName),
        granted: false,
      });
    } catch (err) {
      console.error("removePlaylistAccess failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to revoke playlist access.",
      });
    }
  });

  return router;
}
