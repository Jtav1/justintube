import { Router } from "express";
import { Op, col, fn } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { optionalAuth, requireAuth } from "../lib/auth/require-auth.js";
import { VISIBILITY_VALUES } from "../lib/models/constants.js";
import {
  AccessPermission,
  OriginalUpload,
  PlaylistAccess,
  PlaylistItem,
  User,
  UserPlaylist,
  VideoAccess,
  VideoMetadata,
  VideoThumbnail,
} from "../lib/models/index.js";
import { parsePagination } from "../lib/pagination.js";
import { canEditPlaylist, canViewPlaylist } from "../lib/playlist-access.js";
import { removePlaylistDocument, syncPlaylistIndex } from "../lib/search.js";
import { serializeUserRef } from "../lib/serialize-user-ref.js";
import { isAdmin, isOwnerOrAdmin, resolveViewerPermission } from "../lib/video-access.js";
import {
  loadReactionCountsByUploadId,
  loadTagsByUploadId,
  loadViewerPermissionsByUploadId,
  serializeVideo,
} from "./videos.js";
import { loadHiddenUploadIds } from "../lib/video-hidden.js";

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
 * @param {object} [options] Optional extra fields.
 * @param {"owner"|"edit"|"view"} [options.viewerPermission] The requesting user's effective
 *   permission level, when known (see {@link resolveViewerPermission}). Only attached when
 *   explicitly passed — omitted from the payload entirely otherwise.
 * @returns {object} Public playlist payload.
 */
function serializePlaylist(playlist, itemCount, options = {}) {
  const payload = {
    id: playlist.id,
    name: playlist.title,
    description: playlist.description ?? null,
    visibility: playlist.visibility,
    itemCount,
    owner: playlist.User
      ? {
        id: playlist.User.id,
        username: playlist.User.username,
        displayName: playlist.User.displayName ?? null,
        avatarFilename: playlist.User.avatarFilename ?? null,
      }
      : null,
    lastAddedAt: playlist.lastAddedAt ?? null,
    createdAt: playlist.createdAt,
    updatedAt: playlist.updatedAt,
  };
  if (options.viewerPermission !== undefined) {
    payload.viewerPermission = options.viewerPermission;
  }
  return payload;
}

/**
 * Loads the caller's PLAYLIST_ACCESS grant row for a playlist, if any,
 * including its AccessPermission so callers can inspect the grant's
 * permission level.
 *
 * @param {number} playlistId USER_PLAYLISTS id.
 * @param {number|null|undefined} userId Authenticated user id.
 * @returns {Promise<import('sequelize').Model|null>} The grant row, or null.
 */
async function loadAccessGrant(playlistId, userId) {
  if (!userId) {
    return null;
  }
  return PlaylistAccess.findOne({
    where: { playlistId, userId },
    include: [{ model: AccessPermission }],
  });
}

/**
 * Returns whether the given user has a PLAYLIST_ACCESS grant on the playlist
 * (view or edit level - either is sufficient to view a private playlist).
 *
 * @param {number} playlistId USER_PLAYLISTS id.
 * @param {number|null|undefined} userId Authenticated user id.
 * @returns {Promise<boolean>} True when a grant row exists.
 */
async function userHasAccessGrant(playlistId, userId) {
  return Boolean(await loadAccessGrant(playlistId, userId));
}

/**
 * Returns whether the given user's PLAYLIST_ACCESS grant is specifically
 * "edit"-level (sufficient to update metadata/items, see canEditPlaylist).
 *
 * @param {number} playlistId USER_PLAYLISTS id.
 * @param {number|null|undefined} userId Authenticated user id.
 * @returns {Promise<boolean>} True when an "edit" grant row exists.
 */
async function userHasEditGrant(playlistId, userId) {
  const grant = await loadAccessGrant(playlistId, userId);
  return grant?.AccessPermission?.name === "edit";
}

/**
 * Batch-resolves the caller's effective permission level ("owner"/"edit"/"view")
 * for a set of playlists, using a single PLAYLIST_ACCESS+AccessPermission
 * query (scoped to the non-owned ids) rather than one grant lookup per row.
 * Mirrors `loadViewerPermissionsByUploadId` (see webapi/routes/videos.js).
 *
 * @param {import('sequelize').Model[]} playlists USER_PLAYLISTS rows.
 * @param {import('sequelize').Model|null|undefined} user Authenticated user.
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @returns {Promise<Map<number, "owner"|"edit"|"view">>} Map of playlist id to permission level.
 */
async function loadViewerPermissionsByPlaylistId(playlists, user, role) {
  const result = new Map();
  if (!user) {
    for (const playlist of playlists) {
      result.set(playlist.id, "view");
    }
    return result;
  }

  let editGrantedIds = new Set();
  if (!isAdmin(role)) {
    const nonOwnedIds = playlists
      .filter((playlist) => Number(playlist.userId) !== Number(user.id))
      .map((playlist) => playlist.id);
    if (nonOwnedIds.length > 0) {
      const grants = await PlaylistAccess.findAll({
        where: { userId: user.id, playlistId: { [Op.in]: nonOwnedIds } },
        include: [{ model: AccessPermission, required: true }],
      });
      editGrantedIds = new Set(
        grants
          .filter((grant) => grant.AccessPermission.name === "edit")
          .map((grant) => grant.playlistId),
      );
    }
  }

  for (const playlist of playlists) {
    result.set(
      playlist.id,
      resolveViewerPermission(user, role, playlist.userId, editGrantedIds.has(playlist.id)),
    );
  }
  return result;
}

/**
 * Filters PLAYLIST_ITEMS rows (with `OriginalUpload.VideoMetadata` preloaded)
 * down to the videos the requesting caller may actually see, independent of
 * whether they can see the playlist itself: `public`/`unlisted` videos are
 * always kept; `hidden` videos are always dropped (delisted content has no
 * business surfacing via a playlist, even to the playlist owner); `private`
 * videos are kept only for their owner, an admin, or someone holding a
 * VIDEO_ACCESS grant on that specific video.
 *
 * Also drops any video the caller has personally hidden (USER_HIDDEN_VIDEOS,
 * see `lib/video-hidden.js`) — a per-viewer preference distinct from
 * VIDEO_METADATA.visibility.
 *
 * @param {import('sequelize').Model[]} items PLAYLIST_ITEMS rows to filter.
 * @param {import('sequelize').Model|null|undefined} user Authenticated user (optional).
 * @param {import('sequelize').Model|null|undefined} role Authenticated role (optional).
 * @returns {Promise<import('sequelize').Model[]>} The subset of `items` the caller may view.
 */
async function filterViewablePlaylistItems(items, user, role) {
  const privateItems = items.filter(
    (item) => item.OriginalUpload.VideoMetadata.visibility === "private",
  );

  let grantedUploadIds = new Set();
  if (privateItems.length > 0 && user && !isAdmin(role)) {
    const grants = await VideoAccess.findAll({
      where: {
        userId: user.id,
        originalUploadId: privateItems.map((item) => item.OriginalUpload.id),
      },
      attributes: ["originalUploadId"],
    });
    grantedUploadIds = new Set(grants.map((grant) => grant.originalUploadId));
  }

  const hiddenUploadIds = await loadHiddenUploadIds(user?.id);

  return items.filter((item) => {
    const upload = item.OriginalUpload;
    if (hiddenUploadIds.has(upload.id)) {
      return false;
    }
    const visibility = upload.VideoMetadata.visibility;
    if (visibility === "hidden") {
      return false;
    }
    if (visibility !== "private") {
      return true;
    }
    if (isAdmin(role)) {
      return true;
    }
    if (user && upload.userId != null && Number(user.id) === Number(upload.userId)) {
      return true;
    }
    return grantedUploadIds.has(upload.id);
  });
}

/**
 * Builds the `{items, page, limit, totalHits, totalPages}` page envelope for
 * a set of already-fetched USER_PLAYLISTS rows (with `User` included),
 * computing each playlist's `itemCount` (a single grouped count query) and
 * up to 3 viewable thumbnail URLs (per {@link filterViewablePlaylistItems}).
 * Shared by `GET /playlists` and `GET /users/:username/playlists`.
 *
 * @param {import('sequelize').Model[]} rows USER_PLAYLISTS rows for this page (with `User` included).
 * @param {number} count Total matching row count (pre-pagination).
 * @param {{page: number, limit: number, user: import('sequelize').Model|null|undefined, role: import('sequelize').Model|null|undefined}} options
 *   Pagination echo plus the requesting caller, used for per-video viewability filtering.
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 *   Paginated playlist list envelope.
 */
export async function buildPlaylistsPage(rows, count, { page, limit, user, role }) {
  const playlistIds = rows.map((playlist) => playlist.id);

  const counts = playlistIds.length > 0
    ? await PlaylistItem.findAll({
      where: { playlistId: playlistIds },
      attributes: ["playlistId", [fn("COUNT", col("id")), "itemCount"]],
      group: ["playlistId"],
      raw: true,
    })
    : [];
  const itemCountByPlaylistId = new Map(
    counts.map((row) => [row.playlistId, Number(row.itemCount)]),
  );

  const thumbnailEntries = await Promise.all(
    rows.map(async (playlist) => {
      const items = await PlaylistItem.findAll({
        where: { playlistId: playlist.id },
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
        order: [
          ["position", "ASC"],
          ["addedAt", "DESC"],
        ],
        limit: 5,
      });

      const viewableItems = await filterViewablePlaylistItems(items, user, role);
      const thumbnails = viewableItems
        .slice(0, 3)
        .map((item) => (item.OriginalUpload.VideoThumbnail
          ? `/api/v1/videos/${item.OriginalUpload.id}/thumbnail`
          : null))
        .filter(Boolean);
      const latestVideoId = viewableItems[0]?.OriginalUpload.videoId ?? null;

      return [playlist.id, { thumbnails, latestVideoId }];
    }),
  );
  const thumbnailsByPlaylistId = new Map(thumbnailEntries);
  const viewerPermissionByPlaylistId = await loadViewerPermissionsByPlaylistId(rows, user, role);

  return {
    items: rows.map((playlist) => ({
      id: playlist.id,
      name: playlist.title,
      description: playlist.description ?? null,
      visibility: playlist.visibility,
      itemCount: itemCountByPlaylistId.get(playlist.id) ?? 0,
      owner: playlist.User
        ? {
          id: playlist.User.id,
          username: playlist.User.username,
          displayName: playlist.User.displayName ?? null,
          avatarFilename: playlist.User.avatarFilename ?? null,
        }
        : null,
      thumbnails: thumbnailsByPlaylistId.get(playlist.id)?.thumbnails ?? [],
      latestVideoId: thumbnailsByPlaylistId.get(playlist.id)?.latestVideoId ?? null,
      lastAddedAt: playlist.lastAddedAt ?? null,
      createdAt: playlist.createdAt,
      viewerPermission: viewerPermissionByPlaylistId.get(playlist.id),
    })),
    page,
    limit,
    totalHits: count,
    totalPages: count === 0 ? 0 : Math.ceil(count / limit),
  };
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
      syncPlaylistIndex(playlist.id);

      res.status(201).json(serializePlaylist(playlist, 0, { viewerPermission: "owner" }));
    } catch (err) {
      console.error("createPlaylist failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to create playlist.",
      });
    }
  });

  /**
   * GET /playlists — listPlaylists
   * Auth: optional. Lists playlists the caller may discover: public
   * playlists (any owner), the caller's own playlists (any visibility), and
   * private playlists the caller holds a PLAYLIST_ACCESS grant on. This is
   * intentionally narrower than {@link canViewPlaylist}: another user's
   * `unlisted`/`hidden` playlist is viewable by direct id but is not surfaced
   * in this listing.
   *
   * @openapi
   * /api/v1/playlists:
   *   get:
   *     tags: [Playlists]
   *     summary: List playlists visible to the caller
   *     operationId: listPlaylists
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
   *         description: Paginated list of visible playlists
   *       "400":
   *         description: Invalid page/limit
   */
  router.get("/playlists", optionalAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const orConditions = [{ visibility: "public" }];
      if (req.user) {
        orConditions.push({ userId: req.user.id });

        const grants = await PlaylistAccess.findAll({
          where: { userId: req.user.id },
          attributes: ["playlistId"],
        });
        const grantedIds = grants.map((grant) => grant.playlistId);
        if (grantedIds.length > 0) {
          orConditions.push({ id: { [Op.in]: grantedIds }, visibility: "private" });
        }
      }

      const { rows, count } = await UserPlaylist.findAndCountAll({
        where: { [Op.or]: orConditions },
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
      console.error("listPlaylists failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list playlists.",
      });
    }
  });

  /**
   * GET /playlists/:id — getPlaylist
   * Auth: optional. Returns the playlist and its items when viewable. Items
   * are additionally filtered per-video: `hidden` videos are never returned,
   * `private` videos are only returned to their owner, an admin, or a
   * caller holding a VIDEO_ACCESS grant on that video, and videos the caller
   * has personally hidden are dropped (see {@link filterViewablePlaylistItems})
   * — independent of whether the playlist itself is public.
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

      const playlist = await UserPlaylist.findByPk(id, {
        include: [{ model: User, required: false }],
      });
      if (!playlist) {
        sendNotFound(res);
        return;
      }

      const grant = await loadAccessGrant(playlist.id, req.user?.id);
      if (!canViewPlaylist(req.user, req.authRole, playlist, Boolean(grant))) {
        sendNotFound(res);
        return;
      }

      const isOwnerAdmin = isOwnerOrAdmin(req.user, req.authRole, playlist);
      const hasEditGrant = !isOwnerAdmin && grant?.AccessPermission?.name === "edit";
      const viewerPermission = resolveViewerPermission(
        req.user,
        req.authRole,
        playlist.userId,
        hasEditGrant,
      );

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
          ["addedAt", "DESC"],
        ],
      });

      const viewableItems = await filterViewablePlaylistItems(items, req.user, req.authRole);
      const viewableUploadIds = viewableItems.map((item) => item.OriginalUpload.id);
      const tagsByUploadId = await loadTagsByUploadId(viewableUploadIds);
      const reactionCountsByUploadId = await loadReactionCountsByUploadId(viewableUploadIds);
      const itemViewerPermissionByUploadId = await loadViewerPermissionsByUploadId(
        viewableItems.map((item) => item.OriginalUpload),
        req.user,
        req.authRole,
      );

      const payload = serializePlaylist(playlist, viewableItems.length, { viewerPermission });
      payload.items = viewableItems.map((item) =>
        serializeVideo(item.OriginalUpload, item.OriginalUpload.VideoMetadata, {
          tags: tagsByUploadId.get(item.OriginalUpload.id) || [],
          viewerPermission: itemViewerPermissionByUploadId.get(item.OriginalUpload.id),
          ...reactionCountsByUploadId.get(item.OriginalUpload.id),
        }),
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
   * Auth: required. Owner, admin, or a user with an "edit" PLAYLIST_ACCESS
   * grant. A caller who is not the owner/admin (i.e. an edit-grantee) may
   * update `name`/`description` but not `visibility` — including
   * `visibility` in the body at all is rejected outright (the whole
   * request, not just that field).
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
   *         description: Not the owner/admin/edit-grantee, or an edit-grantee attempted to change visibility
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

      const body = req.body && typeof req.body === "object" ? req.body : {};

      const isOwnerAdmin = isOwnerOrAdmin(req.user, req.authRole, playlist);
      const hasEditGrant = isOwnerAdmin ? false : await userHasEditGrant(playlist.id, req.user.id);

      if (!isOwnerAdmin && !hasEditGrant) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner, an admin, or a user with edit access can update this playlist.",
        });
        return;
      }

      if (!isOwnerAdmin && body.visibility !== undefined) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner or an admin can change this playlist's visibility.",
        });
        return;
      }

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
      syncPlaylistIndex(playlist.id);

      const itemCount = await PlaylistItem.count({ where: { playlistId: playlist.id } });
      res.status(200).json(
        serializePlaylist(playlist, itemCount, {
          viewerPermission: isOwnerAdmin ? "owner" : "edit",
        }),
      );
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
   *       "200":
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
          success: false,
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
          success: false,
          error: "forbidden",
          message: "Only the playlist owner or an admin can delete this playlist.",
        });
        return;
      }

      await playlist.destroy();
      removePlaylistDocument(id);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("deletePlaylist failed:", err);
      res.status(500).json({
        success: false,
        error: "internal_error",
        message: "Failed to delete playlist.",
      });
    }
  });

  /**
   * POST /playlists/:id/items — addPlaylistItem
   * Auth: required. Playlist owner, admin, or a user with an "edit"
   * PLAYLIST_ACCESS grant.
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
   *         description: Not the playlist owner, an admin, or an edit-grantee
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
      const isOwnerAdmin = isOwnerOrAdmin(req.user, req.authRole, playlist);
      const hasEditGrant = isOwnerAdmin ? false : await userHasEditGrant(playlist.id, req.user.id);
      if (!canEditPlaylist(req.user, req.authRole, playlist, hasEditGrant)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner, an admin, or a user with edit access can add items to this playlist.",
        });
        return;
      }
      if (playlist.kind === "likes") {
        res.status(403).json({
          error: "forbidden",
          message: "The My Likes playlist is managed automatically by liking videos.",
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
      syncPlaylistIndex(playlist.id);

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
   * Auth: required. Playlist owner, admin, or a user with an "edit"
   * PLAYLIST_ACCESS grant.
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
   *         description: Not the playlist owner, an admin, or an edit-grantee
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
      const isOwnerAdmin = isOwnerOrAdmin(req.user, req.authRole, playlist);
      const hasEditGrant = isOwnerAdmin ? false : await userHasEditGrant(playlist.id, req.user.id);
      if (!canEditPlaylist(req.user, req.authRole, playlist, hasEditGrant)) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the playlist owner, an admin, or a user with edit access can remove items from this playlist.",
        });
        return;
      }
      if (playlist.kind === "likes") {
        res.status(403).json({
          error: "forbidden",
          message: "The My Likes playlist is managed automatically by liking/disliking videos.",
        });
        return;
      }

      await PlaylistItem.destroy({
        where: { playlistId: playlist.id, originalUploadId: videoId },
      });
      syncPlaylistIndex(playlist.id);

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
   *         description: Access grant list, each item including its "view"/"edit" permission
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
        include: [
          { model: User, required: true },
          { model: AccessPermission, required: true },
        ],
        order: [["id", "ASC"]],
      });

      res.status(200).json({
        items: grants.map((grant) => ({
          ...serializeUserRef(grant.userId, grant.User.username, grant.User.displayName),
          permission: grant.AccessPermission.name,
        })),
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
   * Auth: required. Owner or admin. Grants a single user access to a private
   * playlist at a given permission level (`"view"` or `"edit"`, defaults to
   * `"view"`). Calling this again for a user who already has a grant updates
   * their permission level (upsert) rather than erroring, so an owner can
   * promote/demote an existing grantee through the same endpoint.
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
   *               permission:
   *                 type: string
   *                 enum: [view, edit]
   *                 default: view
   *     responses:
   *       "200":
   *         description: Grant created or updated
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

      const permissionRows = await AccessPermission.findAll();
      const permissionByName = new Map(permissionRows.map((p) => [p.name, p]));
      const permissionName = body.permission === undefined ? "view" : String(body.permission);
      const permissionRow = permissionByName.get(permissionName);
      if (!permissionRow) {
        res.status(400).json({
          error: "invalid_body",
          message: `permission must be one of: ${[...permissionByName.keys()].join(", ")}.`,
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

      const [grant, created] = await PlaylistAccess.findOrCreate({
        where: { playlistId: playlist.id, userId: targetUser.id },
        defaults: { permissionId: permissionRow.id },
      });
      if (!created && grant.permissionId !== permissionRow.id) {
        await grant.update({ permissionId: permissionRow.id });
      }

      res.status(200).json({
        ...serializeUserRef(targetUser.id, targetUser.username, targetUser.displayName),
        granted: true,
        permission: permissionRow.name,
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
