import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { optionalAuth, requireAuth } from "../lib/auth/require-auth.js";
import { requireUploader } from "../lib/auth/require-uploader.js";
import { serializeUserRef } from "../lib/serialize-user-ref.js";
import { Livestream, User } from "../lib/models/index.js";
import { parsePagination } from "../lib/pagination.js";
import { isAdmin } from "../lib/video-access.js";

/**
 * Maximum length for a livestream title, mirroring VIDEO_METADATA.title (see
 * `webapi/lib/models/video-metadata.js`).
 *
 * @type {number}
 */
const MAX_TITLE_LENGTH = 255;

/**
 * Maximum length for a livestream description, mirroring VIDEO_METADATA.description.
 *
 * @type {number}
 */
const MAX_DESCRIPTION_LENGTH = 65535;

/**
 * Allowed livestream visibility values, mirroring VIDEO_METADATA.visibility.
 *
 * @type {string[]}
 */
const VISIBILITY_VALUES = ["public", "private", "unlisted", "hidden"];

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
 * Returns true when the caller may view a livestream: the owner (or an
 * admin) always may; a `public` stream is viewable by anyone; anything else
 * (private/unlisted/hidden) is owner/admin-only for now, since livestreams
 * have no VIDEO_ACCESS-style grant table yet.
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user (optional).
 * @param {import('sequelize').Model|null|undefined} role Authenticated role (optional).
 * @param {import('sequelize').Model} livestream LIVESTREAMS row.
 * @returns {boolean} Whether the caller may view the livestream.
 */
function canViewLivestream(user, role, livestream) {
  if (user && Number(user.id) === Number(livestream.userId)) {
    return true;
  }
  if (isAdmin(role)) {
    return true;
  }
  return livestream.visibility === "public";
}

/**
 * Returns true when the caller owns the livestream or is an admin.
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user.
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @param {import('sequelize').Model} livestream LIVESTREAMS row.
 * @returns {boolean} Whether the caller may mutate the livestream.
 */
function isOwnerOrAdmin(user, role, livestream) {
  if (isAdmin(role)) {
    return true;
  }
  return Boolean(user) && Number(user.id) === Number(livestream.userId);
}

/**
 * Maps a LIVESTREAMS row (with its owning User eager-loaded) to the public
 * JSON shape.
 *
 * @param {import('sequelize').Model} row Livestream instance, with `User` included.
 * @returns {object} Public livestream payload.
 */
function serializeLivestream(row) {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    visibility: row.visibility,
    status: row.status,
    viewerCount: row.viewerCount,
    startedAt: row.startedAt,
    streamer: serializeUserRef(row.userId, row.User?.username, row.User?.displayName),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Builds the public Livestreams router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured livestreams router.
 */
export function createLivestreamsRouter() {
  const router = Router();

  /**
   * Returns the authenticated user's own livestream "channel" row (their
   * stream's id/title/description/visibility/status), regardless of
   * visibility - used by the Go Live page to load current settings. 404 when
   * the user has never generated a stream key (no row exists yet; see
   * POST /api/v1/me/stream-key/rotate, which find-or-creates it).
   * GET /api/v1/me/livestream
   * Auth: session cookie or Bearer API key; uploader status + verified email required.
   *
   * @openapi
   * /api/v1/me/livestream:
   *   get:
   *     tags: [Livestreams]
   *     summary: Get my livestream
   *     operationId: getMyLivestream
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: The caller's own livestream, any visibility
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Uploader access and a verified email are required
   *       404:
   *         description: No livestream exists yet
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the livestream payload or an error response.
   */
  router.get("/me/livestream", requireAuth, requireUploader, async (req, res) => {
    try {
      const row = await Livestream.findOne({
        where: { userId: req.user.id },
        include: [{ model: User, required: true, attributes: ["id", "username", "displayName"] }],
      });
      if (!row) {
        res.status(404).json({ error: "not_found", message: "No livestream exists yet." });
        return;
      }
      res.json(serializeLivestream(row));
    } catch (err) {
      console.error("getMyLivestream failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to fetch livestream.",
      });
    }
  });

  /**
   * Lists currently-live public livestreams, newest-started first.
   * GET /api/v1/livestreams?page=&limit=
   * Auth: optional (anonymous callers see only public streams).
   *
   * @openapi
   * /api/v1/livestreams:
   *   get:
   *     tags: [Livestreams]
   *     summary: List currently-live streams
   *     operationId: listLivestreams
   *     parameters:
   *       - name: page
   *         in: query
   *         schema: { type: integer }
   *       - name: limit
   *         in: query
   *         schema: { type: integer }
   *     responses:
   *       200:
   *         description: Currently-live streams visible to the caller
   *       400:
   *         description: Invalid pagination
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ items, page, limit }` or an error response.
   */
  router.get("/livestreams", optionalAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }

      const { page, limit } = pagination;
      const isViewerAdmin = isAdmin(req.authRole);
      const where = { status: "live" };
      if (!isViewerAdmin) {
        // Anonymous and non-admin callers only ever see public live streams
        // in the discovery list; owners still see their own via /me flows.
        where.visibility = "public";
      }

      const rows = await Livestream.findAll({
        where,
        include: [{ model: User, required: true, attributes: ["id", "username", "displayName"] }],
        order: [["startedAt", "DESC"]],
        offset: (page - 1) * limit,
        limit,
      });

      res.json({ items: rows.map(serializeLivestream), page, limit });
    } catch (err) {
      console.error("listLivestreams failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list livestreams.",
      });
    }
  });

  /**
   * Fetches a single livestream by id.
   * GET /api/v1/livestreams/:id
   * Auth: optional (visibility rules apply).
   *
   * @openapi
   * /api/v1/livestreams/{id}:
   *   get:
   *     tags: [Livestreams]
   *     summary: Get a livestream
   *     operationId: getLivestream
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200:
   *         description: Livestream status, viewer count, and metadata
   *       400:
   *         description: Invalid id
   *       404:
   *         description: Not found or not visible to the caller
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the livestream payload or an error response.
   */
  router.get("/livestreams/:id", optionalAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const row = await Livestream.findByPk(id, {
        include: [{ model: User, required: true, attributes: ["id", "username", "displayName"] }],
      });
      if (!row || !canViewLivestream(req.user, req.authRole, row)) {
        res.status(404).json({ error: "not_found", message: "Livestream not found." });
        return;
      }

      res.json(serializeLivestream(row));
    } catch (err) {
      console.error("getLivestream failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to fetch livestream.",
      });
    }
  });

  /**
   * Updates a livestream's title/description/visibility. Owner or admin only.
   * PATCH /api/v1/livestreams/:id with `{ title?, description?, visibility? }`.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/livestreams/{id}:
   *   patch:
   *     tags: [Livestreams]
   *     summary: Update livestream metadata
   *     operationId: updateLivestream
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer }
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
   *               title: { type: string, maxLength: 255, nullable: true }
   *               description: { type: string, maxLength: 65535, nullable: true }
   *               visibility: { type: string, enum: [public, private, unlisted, hidden] }
   *     responses:
   *       200:
   *         description: Updated livestream
   *       400:
   *         description: Invalid body or id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not the owner or an admin
   *       404:
   *         description: Not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated livestream or an error response.
   */
  router.patch("/livestreams/:id", csrfProtection, requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const row = await Livestream.findByPk(id, {
        include: [{ model: User, required: true, attributes: ["id", "username", "displayName"] }],
      });
      if (!row) {
        res.status(404).json({ error: "not_found", message: "Livestream not found." });
        return;
      }
      if (!isOwnerOrAdmin(req.user, req.authRole, row)) {
        res.status(403).json({ error: "forbidden", message: "Not the owner or an admin." });
        return;
      }

      const body = req.body || {};
      /** @type {Record<string, unknown>} */
      const patch = {};

      if (Object.prototype.hasOwnProperty.call(body, "title")) {
        if (body.title !== null) {
          const title = String(body.title);
          if (title.length > MAX_TITLE_LENGTH) {
            res.status(400).json({
              error: "invalid_body",
              message: `title must be at most ${MAX_TITLE_LENGTH} characters.`,
            });
            return;
          }
          patch.title = title;
        } else {
          patch.title = null;
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, "description")) {
        if (body.description !== null) {
          const description = String(body.description);
          if (description.length > MAX_DESCRIPTION_LENGTH) {
            res.status(400).json({
              error: "invalid_body",
              message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
            });
            return;
          }
          patch.description = description;
        } else {
          patch.description = null;
        }
      }

      if (Object.prototype.hasOwnProperty.call(body, "visibility")) {
        if (!VISIBILITY_VALUES.includes(body.visibility)) {
          res.status(400).json({
            error: "invalid_body",
            message: `visibility must be one of: ${VISIBILITY_VALUES.join(", ")}.`,
          });
          return;
        }
        patch.visibility = body.visibility;
      }

      await row.update(patch);
      // The in-memory instance doesn't reliably hydrate updatedAt's real
      // timestamp after .update() (it can surface the raw CURRENT_TIMESTAMP
      // SQL literal instead) - reload so the response matches a subsequent GET.
      await row.reload({ include: [{ model: User, required: true, attributes: ["id", "username", "displayName"] }] });
      res.json(serializeLivestream(row));
    } catch (err) {
      console.error("updateLivestream failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update livestream.",
      });
    }
  });

  /**
   * Resolves playback info for a livestream. The MediaMTX ingest server
   * (see `docs/api-checklist.md` "Livestreaming") publishes each user's
   * channel to a stable `live/{userId}` path and serves its HLS manifest at
   * that same path under HLS_BASE_URL, so `playbackUrl` is derived directly
   * from `row.userId` - no ingest-server lookup needed, and it's null
   * whenever the channel isn't currently live.
   * GET /api/v1/livestreams/:id/playback
   * Auth: optional (visibility rules apply, same as GET /livestreams/:id).
   *
   * @openapi
   * /api/v1/livestreams/{id}/playback:
   *   get:
   *     tags: [Livestreams]
   *     summary: Get livestream playback info
   *     operationId: getLivestreamPlayback
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer }
   *     responses:
   *       200:
   *         description: Playback info (playbackUrl is an HLS manifest URL when live, otherwise null)
   *       400:
   *         description: Invalid id
   *       404:
   *         description: Not found or not visible to the caller
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ status, playbackUrl }` or an error response.
   */
  router.get("/livestreams/:id/playback", optionalAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const row = await Livestream.findByPk(id);
      if (!row || !canViewLivestream(req.user, req.authRole, row)) {
        res.status(404).json({ error: "not_found", message: "Livestream not found." });
        return;
      }

      const hlsBaseUrl = process.env.HLS_BASE_URL || "";
      res.json({
        status: row.status,
        playbackUrl:
          row.status === "live" && hlsBaseUrl ? `${hlsBaseUrl}/live/${row.userId}/index.m3u8` : null,
      });
    } catch (err) {
      console.error("getLivestreamPlayback failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to fetch playback info.",
      });
    }
  });

  /**
   * Returns a user's current live status, driving a "LIVE" badge on their profile.
   * GET /api/v1/users/:username/live
   * Auth: optional (visibility rules apply).
   *
   * @openapi
   * /api/v1/users/{username}/live:
   *   get:
   *     tags: [Livestreams]
   *     summary: Get a user's live status
   *     operationId: getUserLiveStatus
   *     parameters:
   *       - name: username
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: "`{ live: false }` when offline, not visible, or the user has never streamed"
   *       404:
   *         description: User not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends live status or an error response.
   */
  router.get("/users/:username/live", optionalAuth, async (req, res) => {
    try {
      const user = await User.findOne({ where: { username: req.params.username } });
      if (!user) {
        res.status(404).json({ error: "not_found", message: "User not found." });
        return;
      }

      const row = await Livestream.findOne({ where: { userId: user.id } });
      if (!row || row.status !== "live" || !canViewLivestream(req.user, req.authRole, row)) {
        res.json({ live: false });
        return;
      }

      res.json({
        live: true,
        livestreamId: row.id,
        title: row.title,
        viewerCount: row.viewerCount,
      });
    } catch (err) {
      console.error("getUserLiveStatus failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to fetch live status.",
      });
    }
  });

  return router;
}
