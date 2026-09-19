import { Router } from "express";
import { Op, col, fn } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { CastServiceError } from "../lib/cast/errors.js";
import { endSession, loadSessionById } from "../lib/cast/queue-service.js";
import { notifySessionEnded } from "../lib/cast/realtime.js";
import {
  CastQueueItem,
  CastSession,
  CastSessionMember,
  OriginalUpload,
  User,
  VideoMetadata,
} from "../lib/models/index.js";
import { logger } from "../lib/logger.js";

/**
 * Maximum page size for adminListCastSessions.
 *
 * @type {number}
 */
const MAX_LIST_LIMIT = 100;

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
 * Parses pagination query params for adminListCastSessions. Unlike
 * adminListUsers both params are optional here, since the admin screen opens
 * on an unparameterised list.
 *
 * @param {unknown} rawLimit Query `limit` value.
 * @param {unknown} rawOffset Query `offset` value.
 * @returns {{ok: true, limit: number, offset: number}|{ok: false, message: string}}
 *   Parsed pagination or a validation error.
 */
function parsePagination(rawLimit, rawOffset) {
  const limit =
    rawLimit === undefined || rawLimit === null || rawLimit === ""
      ? MAX_LIST_LIMIT
      : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, message: "limit must be a positive integer." };
  }
  if (limit > MAX_LIST_LIMIT) {
    return { ok: false, message: `limit must be at most ${MAX_LIST_LIMIT}.` };
  }

  const offset =
    rawOffset === undefined || rawOffset === null || rawOffset === "" ? 0 : Number(rawOffset);
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, message: "offset must be a non-negative integer." };
  }

  return { ok: true, limit, offset };
}

/**
 * Counts active members for every listed session in one grouped query, so the
 * list stays a fixed number of queries no matter how many sessions are shown.
 *
 * @param {number[]} sessionIds CAST_SESSIONS ids on the current page.
 * @returns {Promise<Map<number, number>>} Session id to active member count.
 */
async function loadMemberCounts(sessionIds) {
  if (sessionIds.length === 0) {
    return new Map();
  }
  const rows = await CastSessionMember.findAll({
    attributes: ["castSessionId", [fn("COUNT", col("id")), "memberCount"]],
    where: { castSessionId: { [Op.in]: sessionIds }, status: "active" },
    group: ["castSessionId"],
    raw: true,
  });
  return new Map(rows.map((row) => [Number(row.castSessionId), Number(row.memberCount)]));
}

/**
 * Loads the currently playing queue item for every listed session in one
 * query. Deliberately lighter than loadSessionSnapshot, which also fetches
 * history, renditions and the full member roster this view never renders.
 *
 * @param {number[]} sessionIds CAST_SESSIONS ids on the current page.
 * @returns {Promise<Map<number, string>>} Session id to now-playing video title.
 */
async function loadNowPlayingTitles(sessionIds) {
  if (sessionIds.length === 0) {
    return new Map();
  }
  const rows = await CastQueueItem.findAll({
    where: { castSessionId: { [Op.in]: sessionIds }, status: "playing" },
    include: [
      {
        model: OriginalUpload,
        required: true,
        include: [{ model: VideoMetadata, as: "VideoMetadata", required: true }],
      },
    ],
  });
  return new Map(
    rows.map((row) => [Number(row.castSessionId), row.OriginalUpload.VideoMetadata.title]),
  );
}

/**
 * Serializes an active session for the admin list. Carries only what the admin
 * table renders — no join code secrets beyond the code itself, which an admin
 * may legitimately need to reach a session.
 *
 * @param {import('sequelize').Model} session CAST_SESSIONS row with its Owner.
 * @param {Map<number, number>} memberCounts Active member counts by session id.
 * @param {Map<number, string>} nowPlaying Now-playing titles by session id.
 * @returns {object} Admin cast session payload.
 */
function serializeAdminCastSession(session, memberCounts, nowPlaying) {
  return {
    id: session.id,
    code: session.code,
    title: session.title,
    status: session.status,
    playbackStatus: session.playbackStatus,
    createdAt: session.createdAt,
    owner: session.Owner
      ? {
          userId: session.Owner.id,
          username: session.Owner.username,
          displayName: session.Owner.displayName,
        }
      : null,
    memberCount: memberCounts.get(Number(session.id)) ?? 0,
    nowPlayingTitle: nowPlaying.get(Number(session.id)) ?? null,
  };
}

/**
 * Builds the admin-only CAST management router: an overview of every active
 * session plus the ability to end any of them. Mounted alongside the member
 * facing CAST router and gated by the same ENABLE_CAST flag.
 *
 * @returns {import('express').Router} Configured router.
 */
export function createAdminCastRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Lists every active CAST session with its owner, member count and current
   * video.
   * GET /api/v1/admin/cast/sessions?limit=&offset=
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/cast/sessions:
   *   get:
   *     tags: [Admin]
   *     summary: List active CAST sessions
   *     operationId: adminListCastSessions
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
   *           maximum: 100
   *           default: 100
   *       - name: offset
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 0
   *           default: 0
   *     responses:
   *       200:
   *         description: Paginated list of active sessions
   *       400:
   *         description: Invalid pagination query
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with items/total/limit/offset, or error.
   */
  router.get(
    "/admin/cast/sessions",
    requireAuth,
    requireAdmin,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      const pagination = parsePagination(req.query.limit, req.query.offset);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }

      try {
        const { rows, count } = await CastSession.findAndCountAll({
          where: { status: "active" },
          include: [{ model: User, as: "Owner", required: false }],
          order: [["createdAt", "DESC"]],
          limit: pagination.limit,
          offset: pagination.offset,
        });

        const sessionIds = rows.map((row) => Number(row.id));
        const [memberCounts, nowPlaying] = await Promise.all([
          loadMemberCounts(sessionIds),
          loadNowPlayingTitles(sessionIds),
        ]);

        res.status(200).json({
          items: rows.map((row) => serializeAdminCastSession(row, memberCounts, nowPlaying)),
          total: count,
          limit: pagination.limit,
          offset: pagination.offset,
        });
      } catch (err) {
        logger.error({ err }, "adminListCastSessions failed");
        res.status(500).json({
          error: "internal_error",
          message: "Failed to list CAST sessions.",
        });
      }
    },
  );

  /**
   * Ends any active CAST session administratively, disconnecting everyone in
   * it. Authorization lives in endSession (the single mutation path), which
   * accepts an admin role in place of session ownership.
   * POST /api/v1/admin/cast/sessions/:id/end
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/cast/sessions/{id}/end:
   *   post:
   *     tags: [Admin]
   *     summary: End a CAST session as an admin
   *     operationId: adminEndCastSession
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: integer
   *           minimum: 1
   *     responses:
   *       204:
   *         description: Session ended
   *       400:
   *         description: Invalid id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: No such session
   *       409:
   *         description: Session already ended
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 on success, or an error response.
   */
  router.post(
    "/admin/cast/sessions/:id/end",
    requireAuth,
    requireAdmin,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (id == null) {
          res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
          return;
        }

        const session = await loadSessionById(id);
        await endSession({ session, actingUser: req.user, actingRole: req.authRole });
        // The broadcast is not part of the service layer - routes/cast.js does
        // the same thing after its own end, so live viewers get kicked here too.
        notifySessionEnded(session.id);
        res.status(204).send();
      } catch (err) {
        if (err instanceof CastServiceError) {
          res.status(err.status).json({ error: err.code, message: err.message });
          return;
        }
        logger.error({ err }, "adminEndCastSession failed");
        res.status(500).json({
          error: "internal_error",
          message: "Failed to end CAST session.",
        });
      }
    },
  );

  return router;
}
