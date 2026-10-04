import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { CastServiceError } from "../lib/cast/errors.js";
import { topReactionEmoji } from "../lib/cast/emoji-usage.js";
import {
  addPlaylistToQueue,
  addQueueItem,
  createSession,
  endSession,
  joinSessionByCode,
  kickMember,
  leaveSession,
  loadActiveMembership,
  loadSessionById,
  loadSessionSnapshot,
  removeQueueItem,
  renameSession,
  reorderQueueItem,
  setSessionAutoAdvance,
} from "../lib/cast/queue-service.js";
import {
  disconnectMember,
  notifyActivity,
  notifySessionChanged,
  notifySessionEnded,
} from "../lib/cast/realtime.js";
import { logger } from "../lib/logger.js";

/**
 * Maximum accepted CAST session title length, matching CAST_SESSIONS.title.
 *
 * @type {number}
 */
const MAX_TITLE_LENGTH = 255;

/**
 * How many reaction emoji the bar asks for when it doesn't say.
 *
 * @type {number}
 */
const DEFAULT_EMOJI_LIMIT = 6;

/**
 * Upper bound on a caller-supplied reaction-emoji `limit`.
 *
 * @type {number}
 */
const MAX_EMOJI_LIMIT = 24;

/**
 * Parses a route `:id`/`:itemId`/`:userId` param as a positive integer.
 *
 * @param {unknown} raw Raw path parameter.
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
 * A display name for activity-feed attribution, mirroring the identical
 * helper in lib/cast/realtime.js.
 *
 * @param {import('sequelize').Model} user Authenticated user.
 * @returns {string} The user's display name, username, or a fallback.
 */
function displayNameFor(user) {
  return user.displayName || user.username || "Someone";
}

/**
 * Sends the standard error envelope for a {@link CastServiceError} and
 * returns whether one was handled, so route handlers can write
 * `if (handleServiceError(res, err)) return;` in their `catch` block before
 * falling through to the generic 500 response.
 *
 * @param {import('express').Response} res Express response.
 * @param {unknown} err The caught error.
 * @returns {boolean} True when `err` was a CastServiceError and a response was sent.
 */
function handleServiceError(res, err) {
  if (err instanceof CastServiceError) {
    res.status(err.status).json({ error: err.code, message: err.message });
    return true;
  }
  return false;
}

/**
 * Sends 400 for an invalid `:id`-style path parameter.
 *
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendInvalidId(res) {
  res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
}

/**
 * Sends 403 for an authenticated caller who isn't a member of the session.
 *
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendNotAMember(res) {
  res.status(403).json({
    error: "forbidden",
    message: "You are not a member of this CAST session.",
  });
}

/**
 * Loads a session by its `:id` route param and confirms the caller is an
 * active member (the owner counts as a member). Writes the appropriate error
 * response and returns null on any failure; callers should `return` when
 * this returns null.
 *
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<import('sequelize').Model|null>} The session row, or null if a response was already sent.
 * @throws {CastServiceError} Propagates a 404 from `loadSessionById` to the caller's own try/catch.
 */
async function requireSessionMembership(req, res) {
  const id = parsePositiveInt(req.params.id);
  if (id == null) {
    sendInvalidId(res);
    return null;
  }
  const session = await loadSessionById(id);
  const membership = await loadActiveMembership(session.id, req.user.id);
  if (!membership) {
    sendNotAMember(res);
    return null;
  }
  return session;
}

/**
 * Builds the `/cast` router (mounted under `/api/v1`). Shared watch sessions:
 * a join code, a live queue seeded (as a filtered copy) from a playlist or a
 * single video, and realtime sync over the `/cast` Socket.IO namespace
 * (lib/cast/realtime.js) — this router covers the REST surface only.
 * Playback control (play/pause/seek/skip/previous) is socket-only; see
 * lib/cast/realtime.js's client→server event catalog.
 *
 * @returns {import('express').Router} Configured CAST router.
 */
export function createCastRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Creates a new CAST session, seeding its queue from a playlist (a
   * filtered copy — the source playlist is never mutated), a single video,
   * or nothing. The caller becomes the session's owner.
   * POST /api/v1/cast
   * Auth: required.
   *
   * @openapi
   * /api/v1/cast:
   *   post:
   *     tags: [Cast]
   *     summary: Create a CAST session
   *     operationId: createCastSpace
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
   *             required: [sourceType]
   *             properties:
   *               sourceType:
   *                 type: string
   *                 enum: [playlist, video, empty]
   *               playlistId:
   *                 type: integer
   *               videoId:
   *                 type: string
   *     responses:
   *       "201":
   *         description: Created session snapshot, including its join code
   *       "400":
   *         description: Invalid sourceType or missing playlistId/videoId
   *       "404":
   *         description: Playlist or video not found (or not viewable)
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the new session snapshot or an error response.
   */
  router.post("/cast", requireAuth, async (req, res) => {
    try {
      const sourceType = req.body?.sourceType;
      let playlistId;
      if (req.body?.playlistId != null) {
        playlistId = parsePositiveInt(req.body.playlistId);
        if (playlistId == null) {
          res.status(400).json({
            error: "invalid_body",
            message: "playlistId must be a positive integer.",
          });
          return;
        }
      }
      const videoIdentifier = req.body?.videoId != null ? String(req.body.videoId) : undefined;

      const snapshot = await createSession({
        user: req.user,
        role: req.authRole,
        sourceType,
        playlistId,
        videoIdentifier,
      });
      res.status(201).json(snapshot);
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "createCastSpace failed");
      res.status(500).json({ error: "internal_error", message: "Failed to create CAST session." });
    }
  });

  /**
   * Joins (or rejoins) a CAST session by its join code.
   * POST /api/v1/cast/join
   * Auth: required.
   *
   * @openapi
   * /api/v1/cast/join:
   *   post:
   *     tags: [Cast]
   *     summary: Join a CAST session by code
   *     operationId: joinCastSpace
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
   *             required: [code]
   *             properties:
   *               code:
   *                 type: string
   *     responses:
   *       "200":
   *         description: The joined session snapshot
   *       "400":
   *         description: Missing code
   *       "403":
   *         description: This user was previously kicked from the session
   *       "404":
   *         description: No active session has this code
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the joined session snapshot or an error response.
   */
  router.post("/cast/join", requireAuth, async (req, res) => {
    try {
      const snapshot = await joinSessionByCode({ code: req.body?.code, user: req.user });
      res.status(200).json(snapshot);
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "joinCastSpace failed");
      res.status(500).json({ error: "internal_error", message: "Failed to join CAST session." });
    }
  });

  /**
   * Fetches a session's full snapshot (queue, history, nowPlaying, playback
   * clock, members). Caller must be an active member.
   * GET /api/v1/cast/:id
   * Auth: required.
   *
   * @openapi
   * /api/v1/cast/{id}:
   *   get:
   *     tags: [Cast]
   *     summary: Get a CAST session
   *     operationId: getCastSpace
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       "200":
   *         description: Session snapshot
   *       "400":
   *         description: Invalid id
   *       "403":
   *         description: Caller is not a member of this session
   *       "404":
   *         description: Session not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the session snapshot or an error response.
   */
  router.get("/cast/:id", requireAuth, async (req, res) => {
    try {
      const session = await requireSessionMembership(req, res);
      if (!session) return;

      res.status(200).json(await loadSessionSnapshot(session));
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "getCastSpace failed");
      res.status(500).json({ error: "internal_error", message: "Failed to get CAST session." });
    }
  });

  /**
   * Fetches the same session snapshot as `getCastSpace`, for the chrome-less
   * TV display view. A separate operation (rather than reusing
   * `getCastSpace`) so the display route can diverge later without
   * disturbing the member-facing one.
   * GET /api/v1/cast/:id/display
   * Auth: required.
   *
   * @openapi
   * /api/v1/cast/{id}/display:
   *   get:
   *     tags: [Cast]
   *     summary: Get a CAST session for the display view
   *     operationId: getCastDisplay
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       "200":
   *         description: Session snapshot
   *       "400":
   *         description: Invalid id
   *       "403":
   *         description: Caller is not a member of this session
   *       "404":
   *         description: Session not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the session snapshot or an error response.
   */
  router.get("/cast/:id/display", requireAuth, async (req, res) => {
    try {
      const session = await requireSessionMembership(req, res);
      if (!session) return;

      res.status(200).json(await loadSessionSnapshot(session));
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "getCastDisplay failed");
      res.status(500).json({ error: "internal_error", message: "Failed to get CAST session." });
    }
  });

  /**
   * Adds a video to the end of a session's queue. Subject to the same
   * per-video visibility rules as anywhere else in the app.
   * POST /api/v1/cast/:id/queue
   * Auth: required, active member.
   *
   * @openapi
   * /api/v1/cast/{id}/queue:
   *   post:
   *     tags: [Cast]
   *     summary: Add a video to a CAST session's queue
   *     operationId: addCastQueueItem
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
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
   *       "201":
   *         description: Updated session snapshot
   *       "400":
   *         description: Invalid id or missing videoId
   *       "403":
   *         description: Caller is not a member of this session
   *       "404":
   *         description: Session or video not found (or the video isn't viewable)
   *       "409":
   *         description: The session has ended
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated session snapshot or an error response.
   */
  router.post("/cast/:id/queue", requireAuth, async (req, res) => {
    try {
      const session = await requireSessionMembership(req, res);
      if (!session) return;

      const videoIdentifier = req.body?.videoId;
      if (!videoIdentifier) {
        res.status(400).json({ error: "invalid_body", message: "videoId is required." });
        return;
      }

      const snapshot = await addQueueItem({
        session,
        user: req.user,
        role: req.authRole,
        videoIdentifier: String(videoIdentifier),
      });
      await notifySessionChanged(session.id);
      notifyActivity(session.id, {
        type: "queue_add",
        actorName: displayNameFor(req.user),
        text: `${displayNameFor(req.user)} added a video to the queue`,
      });
      res.status(201).json(snapshot);
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "addCastQueueItem failed");
      res.status(500).json({ error: "internal_error", message: "Failed to add queue item." });
    }
  });

  /**
   * Appends an entire playlist to a session's queue, in playlist order. Any
   * active member may do this, matching the single-video add. Videos in the
   * playlist the caller can't see are skipped rather than failing the request,
   * so the response's `addedCount` may be lower than the playlist's length.
   * POST /api/v1/cast/:id/queue/playlist
   * Auth: required, active member.
   *
   * @openapi
   * /api/v1/cast/{id}/queue/playlist:
   *   post:
   *     tags: [Cast]
   *     summary: Add every video of a playlist to a CAST session's queue
   *     operationId: addCastQueuePlaylist
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [playlistId]
   *             properties:
   *               playlistId:
   *                 type: integer
   *     responses:
   *       "201":
   *         description: Updated session snapshot, plus how many videos were added
   *       "400":
   *         description: Invalid id or playlistId
   *       "403":
   *         description: Caller is not a member of this session
   *       "404":
   *         description: Session or playlist not found (or the playlist isn't viewable)
   *       "409":
   *         description: The session has ended
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated session snapshot or an error response.
   */
  router.post("/cast/:id/queue/playlist", requireAuth, async (req, res) => {
    try {
      const session = await requireSessionMembership(req, res);
      if (!session) return;

      const playlistId = parsePositiveInt(req.body?.playlistId);
      if (playlistId == null) {
        res.status(400).json({
          error: "invalid_body",
          message: "playlistId must be a positive integer.",
        });
        return;
      }

      const { snapshot, addedCount } = await addPlaylistToQueue({
        session,
        user: req.user,
        role: req.authRole,
        playlistId,
      });
      await notifySessionChanged(session.id);
      const name = displayNameFor(req.user);
      notifyActivity(session.id, {
        type: "queue_add",
        actorName: name,
        text: `${name} added ${addedCount} ${addedCount === 1 ? "video" : "videos"} from a playlist`,
      });
      res.status(201).json({ ...snapshot, addedCount });
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "addCastQueuePlaylist failed");
      res.status(500).json({ error: "internal_error", message: "Failed to add the playlist." });
    }
  });

  /**
   * Removes an item from a session's queue (soft delete).
   * DELETE /api/v1/cast/:id/queue/:itemId
   * Auth: required, active member.
   *
   * @openapi
   * /api/v1/cast/{id}/queue/{itemId}:
   *   delete:
   *     tags: [Cast]
   *     summary: Remove an item from a CAST session's queue
   *     operationId: removeCastQueueItem
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *       - in: path
   *         name: itemId
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       "204":
   *         description: Item removed
   *       "400":
   *         description: Invalid id or itemId
   *       "403":
   *         description: Caller is not a member of this session
   *       "404":
   *         description: Session or queue item not found
   *       "409":
   *         description: The session has ended
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 or an error response.
   */
  router.delete("/cast/:id/queue/:itemId", requireAuth, async (req, res) => {
    try {
      const session = await requireSessionMembership(req, res);
      if (!session) return;

      const itemId = parsePositiveInt(req.params.itemId);
      if (itemId == null) {
        sendInvalidId(res);
        return;
      }

      await removeQueueItem({ session, queueItemId: itemId });
      await notifySessionChanged(session.id);
      notifyActivity(session.id, {
        type: "queue_remove",
        actorName: displayNameFor(req.user),
        text: `${displayNameFor(req.user)} removed a video from the queue`,
      });
      res.status(204).send();
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "removeCastQueueItem failed");
      res.status(500).json({ error: "internal_error", message: "Failed to remove queue item." });
    }
  });

  /**
   * Moves a queued item to a new position among the other queued items.
   * PATCH /api/v1/cast/:id/queue/:itemId/move
   * Auth: required, active member.
   *
   * @openapi
   * /api/v1/cast/{id}/queue/{itemId}/move:
   *   patch:
   *     tags: [Cast]
   *     summary: Reorder a CAST session's queue
   *     operationId: moveCastQueueItem
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *       - in: path
   *         name: itemId
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [toIndex]
   *             properties:
   *               toIndex:
   *                 type: integer
   *     responses:
   *       "200":
   *         description: Updated session snapshot
   *       "400":
   *         description: Invalid id/itemId/toIndex
   *       "403":
   *         description: Caller is not a member of this session
   *       "404":
   *         description: Session not found, or itemId isn't a currently-queued item
   *       "409":
   *         description: The session has ended
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated session snapshot or an error response.
   */
  router.patch("/cast/:id/queue/:itemId/move", requireAuth, async (req, res) => {
    try {
      const session = await requireSessionMembership(req, res);
      if (!session) return;

      const itemId = parsePositiveInt(req.params.itemId);
      if (itemId == null) {
        sendInvalidId(res);
        return;
      }

      const snapshot = await reorderQueueItem({
        session,
        queueItemId: itemId,
        toIndex: Number(req.body?.toIndex),
      });
      await notifySessionChanged(session.id);
      res.status(200).json(snapshot);
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "moveCastQueueItem failed");
      res.status(500).json({ error: "internal_error", message: "Failed to reorder queue item." });
    }
  });

  /**
   * Lists a session's active members.
   * GET /api/v1/cast/:id/members
   * Auth: required, active member.
   *
   * @openapi
   * /api/v1/cast/{id}/members:
   *   get:
   *     tags: [Cast]
   *     summary: List a CAST session's members
   *     operationId: listCastMembers
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       "200":
   *         description: Active members
   *       "400":
   *         description: Invalid id
   *       "403":
   *         description: Caller is not a member of this session
   *       "404":
   *         description: Session not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ items }` or an error response.
   */
  router.get("/cast/:id/members", requireAuth, async (req, res) => {
    try {
      const session = await requireSessionMembership(req, res);
      if (!session) return;

      const snapshot = await loadSessionSnapshot(session);
      res.status(200).json({ items: snapshot.members });
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "listCastMembers failed");
      res.status(500).json({ error: "internal_error", message: "Failed to list members." });
    }
  });

  /**
   * Removes a member from a session. Owner only; the owner cannot kick
   * themselves. Durable — a kicked user can never rejoin via the join code.
   * DELETE /api/v1/cast/:id/members/:userId
   * Auth: required, session owner.
   *
   * @openapi
   * /api/v1/cast/{id}/members/{userId}:
   *   delete:
   *     tags: [Cast]
   *     summary: Kick a member from a CAST session
   *     operationId: kickCastMember
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *       - in: path
   *         name: userId
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       "204":
   *         description: Member kicked
   *       "400":
   *         description: Invalid id/userId, or attempting to kick the owner
   *       "403":
   *         description: Caller is not the session owner
   *       "404":
   *         description: Session not found, or the target isn't an active member
   *       "409":
   *         description: The session has ended
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 or an error response.
   */
  router.delete("/cast/:id/members/:userId", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      const targetUserId = parsePositiveInt(req.params.userId);
      if (id == null || targetUserId == null) {
        sendInvalidId(res);
        return;
      }

      const session = await loadSessionById(id);
      await kickMember({ session, actingUser: req.user, targetUserId });
      disconnectMember(session.id, targetUserId);
      await notifySessionChanged(session.id);
      notifyActivity(session.id, {
        type: "kicked",
        actorName: displayNameFor(req.user),
        text: `${displayNameFor(req.user)} removed a member from the session`,
      });
      res.status(204).send();
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "kickCastMember failed");
      res.status(500).json({ error: "internal_error", message: "Failed to kick member." });
    }
  });

  /**
   * Ends a session. Owner or admin.
   * POST /api/v1/cast/:id/end
   * Auth: required, session owner or admin.
   *
   * @openapi
   * /api/v1/cast/{id}/end:
   *   post:
   *     tags: [Cast]
   *     summary: End a CAST session
   *     operationId: endCastSession
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       "204":
   *         description: Session ended
   *       "400":
   *         description: Invalid id
   *       "403":
   *         description: Caller is neither the session owner nor an admin
   *       "404":
   *         description: Session not found
   *       "409":
   *         description: The session has already ended
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 or an error response.
   */
  router.post("/cast/:id/end", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        sendInvalidId(res);
        return;
      }

      const session = await loadSessionById(id);
      await endSession({ session, actingUser: req.user, actingRole: req.authRole });
      notifySessionEnded(session.id);
      res.status(204).send();
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "endCastSession failed");
      res.status(500).json({ error: "internal_error", message: "Failed to end CAST session." });
    }
  });

  /**
   * Lists the instance's most-used reaction emoji, highest first, for the CAST
   * reaction bar. Site-wide rather than per-user, and padded with the seeded
   * defaults so the bar is never short.
   * GET /api/v1/reaction-emoji?limit=
   * Auth: required.
   *
   * @openapi
   * /api/v1/reaction-emoji:
   *   get:
   *     tags: [Cast]
   *     summary: List the most-used reaction emoji
   *     operationId: listReactionEmoji
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 24
   *           default: 6
   *     responses:
   *       "200":
   *         description: Emoji ordered by usage
   *       "400":
   *         description: Invalid limit
   *       "401":
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ items }` or an error response.
   */
  router.get("/reaction-emoji", requireAuth, async (req, res) => {
    try {
      const raw = req.query.limit;
      const limit = raw === undefined || raw === "" ? DEFAULT_EMOJI_LIMIT : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_EMOJI_LIMIT) {
        res.status(400).json({
          error: "invalid_query",
          message: `limit must be an integer between 1 and ${MAX_EMOJI_LIMIT}.`,
        });
        return;
      }

      res.status(200).json({ items: await topReactionEmoji(limit) });
    } catch (err) {
      logger.error({ err }, "listReactionEmoji failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list reaction emoji.",
      });
    }
  });

  /**
   * Renames a session. Owner or admin.
   * PATCH /api/v1/cast/:id
   * Auth: required, session owner or admin.
   *
   * @openapi
   * /api/v1/cast/{id}:
   *   patch:
   *     tags: [Cast]
   *     summary: Rename a CAST session
   *     operationId: renameCastSession
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [title]
   *             properties:
   *               title:
   *                 type: string
   *                 maxLength: 255
   *     responses:
   *       "200":
   *         description: Updated session snapshot
   *       "400":
   *         description: Invalid id or title
   *       "403":
   *         description: Caller is neither the session owner nor an admin
   *       "404":
   *         description: Session not found
   *       "409":
   *         description: The session has ended
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated session snapshot or an error response.
   */
  router.patch("/cast/:id", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        sendInvalidId(res);
        return;
      }

      const title = req.body?.title == null ? "" : String(req.body.title).trim();
      if (!title) {
        res.status(400).json({ error: "invalid_body", message: "title is required." });
        return;
      }
      if (title.length > MAX_TITLE_LENGTH) {
        res.status(400).json({
          error: "invalid_body",
          message: `title must be at most ${MAX_TITLE_LENGTH} characters.`,
        });
        return;
      }

      // Not requireSessionMembership: an admin renaming someone else's session
      // is not a member of it, so authorization is left to the service.
      const session = await loadSessionById(id);
      const snapshot = await renameSession({
        session,
        actingUser: req.user,
        actingRole: req.authRole,
        title,
      });
      await notifySessionChanged(session.id);
      notifyActivity(session.id, {
        type: "session_renamed",
        actorName: displayNameFor(req.user),
        text: `${displayNameFor(req.user)} renamed the session to "${title}"`,
      });
      res.status(200).json(snapshot);
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "renameCastSession failed");
      res.status(500).json({ error: "internal_error", message: "Failed to rename CAST session." });
    }
  });

  /**
   * Sets whether a session auto-advances to the next queued item once the
   * current one finishes. Owner or admin.
   * PATCH /api/v1/cast/:id/auto-advance
   * Auth: required, session owner or admin.
   *
   * @openapi
   * /api/v1/cast/{id}/auto-advance:
   *   patch:
   *     tags: [Cast]
   *     summary: Set a CAST session's auto-advance setting
   *     operationId: setCastSessionAutoAdvance
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [enabled]
   *             properties:
   *               enabled:
   *                 type: boolean
   *     responses:
   *       "200":
   *         description: Updated session snapshot
   *       "400":
   *         description: Invalid id or enabled
   *       "403":
   *         description: Caller is neither the session owner nor an admin
   *       "404":
   *         description: Session not found
   *       "409":
   *         description: The session has ended
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated session snapshot or an error response.
   */
  router.patch("/cast/:id/auto-advance", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        sendInvalidId(res);
        return;
      }
      if (typeof req.body?.enabled !== "boolean") {
        res.status(400).json({ error: "invalid_body", message: "enabled must be a boolean." });
        return;
      }

      const session = await loadSessionById(id);
      const snapshot = await setSessionAutoAdvance({
        session,
        actingUser: req.user,
        actingRole: req.authRole,
        enabled: req.body.enabled,
      });
      await notifySessionChanged(session.id);
      notifyActivity(session.id, {
        type: "auto_advance_changed",
        actorName: displayNameFor(req.user),
        text: `${displayNameFor(req.user)} turned autoplay ${req.body.enabled ? "on" : "off"}.`,
      });
      res.status(200).json(snapshot);
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "setCastSessionAutoAdvance failed");
      res.status(500).json({ error: "internal_error", message: "Failed to update auto-advance." });
    }
  });

  /**
   * Leaves a session, dropping the caller's own membership. Any member may
   * call it; leaving a session the caller isn't in succeeds quietly.
   * POST /api/v1/cast/:id/leave
   * Auth: required.
   *
   * @openapi
   * /api/v1/cast/{id}/leave:
   *   post:
   *     tags: [Cast]
   *     summary: Leave a CAST session
   *     operationId: leaveCastSession
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       "204":
   *         description: Left the session (or was already not a member)
   *       "400":
   *         description: Invalid id
   *       "404":
   *         description: Session not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 or an error response.
   */
  router.post("/cast/:id/leave", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        sendInvalidId(res);
        return;
      }

      const session = await loadSessionById(id);
      const { ended } = await leaveSession({ session, user: req.user });
      if (ended) {
        // Last active member just left - the session auto-ended, so tell the
        // room the same way an explicit end does rather than leaving it in
        // limbo until someone reopens it and notices.
        notifySessionEnded(session.id);
      } else {
        await notifySessionChanged(session.id);
        notifyActivity(session.id, {
          type: "member_left",
          actorName: displayNameFor(req.user),
          text: `${displayNameFor(req.user)} left the session`,
        });
      }
      // Deliberately not disconnectMember(): that emits `session:kicked`, which
      // the client surfaces as "you were removed". A voluntary leave tears its
      // own socket down when the caller clears its active session.
      res.status(204).send();
    } catch (err) {
      if (handleServiceError(res, err)) return;
      logger.error({ err }, "leaveCastSession failed");
      res.status(500).json({ error: "internal_error", message: "Failed to leave CAST session." });
    }
  });

  return router;
}
