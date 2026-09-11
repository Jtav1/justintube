import { Router } from "express";
import { Op } from "sequelize";
import { optionalAuth, requireAuth } from "../lib/auth/require-auth.js";
import { Role, User, UserPlaylist } from "../lib/models/index.js";
import { isAdmin } from "../lib/video-access.js";
import {
  advancedSearchEnabled,
  searchPlaylistsAdvanced,
  searchUsersAdvanced,
  searchVideos,
  searchVideosAdvanced,
  suggestVideos,
} from "../lib/search.js";
import { serializeUserRef } from "../lib/serialize-user-ref.js";
import { loadHiddenUploadIds } from "../lib/video-hidden.js";
import { buildPlaylistsPage } from "./playlists.js";
import { loadUploadCountsByUserId, serializeUserListItem } from "./users.js";
import { loadViewerPermissionsByUploadId } from "./videos.js";
import { logger } from "../lib/logger.js";

/**
 * Maximum page size for GET /search.
 *
 * @type {number}
 */
const MAX_LIMIT = 100;

/**
 * Default page size for GET /search.
 *
 * @type {number}
 */
const DEFAULT_LIMIT = 20;

/**
 * Default suggestion count for GET /search/suggest.
 *
 * @type {number}
 */
const SUGGEST_LIMIT = 8;

/**
 * Maximum suggestion count for GET /search/suggest.
 *
 * @type {number}
 */
const SUGGEST_MAX_LIMIT = 15;

/**
 * Default/maximum per-type result counts for GET /search/advanced. No
 * pagination in v1 — these caps just keep the combined results page from
 * growing unbounded.
 *
 * @type {{video: number, playlist: number, user: number}}
 */
const ADVANCED_LIMITS = { video: 24, playlist: 12, user: 8 };

/**
 * Default result count for GET /search/users.
 *
 * @type {number}
 */
const USER_SEARCH_DEFAULT_LIMIT = 10;

/**
 * Maximum result count for GET /search/users.
 *
 * @type {number}
 */
const USER_SEARCH_MAX_LIMIT = 25;

/**
 * Maps the public `sort` query value to a Meilisearch sort clause. `relevance`
 * (the default) omits `sort` entirely so Meilisearch's own ranking applies.
 *
 * @type {Record<string, string|undefined>}
 */
const SORT_OPTIONS = {
  relevance: undefined,
  newest: "createdAt:desc",
  oldest: "createdAt:asc",
  views: "viewCount:desc",
};

/**
 * Sends the shared "search backend is unreachable" response. Only reachable
 * when advanced search is explicitly enabled and Meilisearch is down — the
 * basic (default) backend has no external dependency to be unreachable.
 *
 * @param {import('express').Response} res Express response.
 * @returns {void} No return value; sends the response.
 */
function sendSearchUnavailable(res) {
  res.status(503).json({
    error: "search_unavailable",
    message: "Search is temporarily unavailable.",
  });
}

/**
 * Sends the shared unexpected-failure response for the basic backend's own
 * errors (e.g. a database failure) — a different failure mode than an
 * external Meilisearch outage, so it gets the generic shape used elsewhere in
 * this codebase rather than `search_unavailable`.
 *
 * @param {import('express').Response} res Express response.
 * @returns {void} No return value; sends the response.
 */
function sendSearchFailed(res) {
  res.status(500).json({
    error: "internal_error",
    message: "Search failed unexpectedly.",
  });
}

/**
 * Logs and responds to a search failure with the error shape appropriate to
 * the active backend: `503 search_unavailable` when advanced search is
 * enabled (a Meilisearch outage), `500 internal_error` otherwise (the basic
 * backend has no external dependency, so its errors are more fundamental).
 *
 * @param {import('express').Response} res Express response.
 * @param {unknown} err The caught error, for logging.
 * @param {string} label Log label identifying which handler failed.
 * @returns {void} No return value; sends the response.
 */
function handleSearchError(res, err, label) {
  logger.error({ err }, `${label} failed`);
  if (advancedSearchEnabled()) {
    sendSearchUnavailable(res);
  } else {
    sendSearchFailed(res);
  }
}

/**
 * Parses and validates GET /search query params.
 *
 * @param {import('express').Request['query']} query Raw Express query object.
 * @returns {{
 *   ok: true,
 *   q: string,
 *   tags: string[],
 *   username?: string,
 *   sort?: string,
 *   page: number,
 *   limit: number
 * }|{ok: false, message: string}} Parsed params or a validation error.
 */
function parseSearchQuery(query) {
  const q = typeof query.q === "string" ? query.q.trim() : "";

  let tags = [];
  if (query.tags !== undefined) {
    const raw = Array.isArray(query.tags) ? query.tags : [query.tags];
    tags = raw
      .flatMap((entry) => String(entry ?? "").split(","))
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  const username =
    typeof query.username === "string" && query.username.trim()
      ? query.username.trim()
      : undefined;

  const sortKey =
    typeof query.sort === "string" ? query.sort.trim() : "relevance";
  if (!Object.prototype.hasOwnProperty.call(SORT_OPTIONS, sortKey)) {
    return {
      ok: false,
      message: `sort must be one of: ${Object.keys(SORT_OPTIONS).join(", ")}.`,
    };
  }

  const pageRaw = query.page === undefined ? 1 : Number(query.page);
  if (!Number.isInteger(pageRaw) || pageRaw < 1) {
    return { ok: false, message: "page must be a positive integer." };
  }

  const limitRaw =
    query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) {
    return { ok: false, message: "limit must be a positive integer." };
  }
  if (limitRaw > MAX_LIMIT) {
    return { ok: false, message: `limit must be at most ${MAX_LIMIT}.` };
  }

  return {
    ok: true,
    q,
    tags,
    username,
    sort: SORT_OPTIONS[sortKey],
    page: pageRaw,
    limit: limitRaw,
  };
}

/**
 * Parses and validates GET /search/users query params.
 *
 * @param {import('express').Request['query']} query Raw Express query object.
 * @returns {{ok: true, q: string, limit: number}|{ok: false, message: string}}
 *   Parsed params or a validation error.
 */
function parseUserSearchQuery(query) {
  const q = typeof query.q === "string" ? query.q.trim() : "";

  const limitRaw =
    query.limit === undefined ? USER_SEARCH_DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) {
    return { ok: false, message: "limit must be a positive integer." };
  }
  if (limitRaw > USER_SEARCH_MAX_LIMIT) {
    return {
      ok: false,
      message: `limit must be at most ${USER_SEARCH_MAX_LIMIT}.`,
    };
  }

  return { ok: true, q, limit: limitRaw };
}

/**
 * Parses and validates GET /search/suggest query params.
 *
 * @param {import('express').Request['query']} query Raw Express query object.
 * @returns {{ok: true, q: string, limit: number}|{ok: false, message: string}}
 *   Parsed params or a validation error.
 */
function parseSuggestQuery(query) {
  const q = typeof query.q === "string" ? query.q.trim() : "";

  const limitRaw =
    query.limit === undefined ? SUGGEST_LIMIT : Number(query.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) {
    return { ok: false, message: "limit must be a positive integer." };
  }
  if (limitRaw > SUGGEST_MAX_LIMIT) {
    return {
      ok: false,
      message: `limit must be at most ${SUGGEST_MAX_LIMIT}.`,
    };
  }

  return { ok: true, q, limit: limitRaw };
}

/**
 * Parses and validates GET /search/advanced query params.
 *
 * @param {import('express').Request['query']} query Raw Express query object.
 * @returns {{ok: true, q: string, videoLimit: number, playlistLimit: number, userLimit: number}
 *   |{ok: false, message: string}} Parsed params or a validation error.
 */
function parseAdvancedSearchQuery(query) {
  const q = typeof query.q === "string" ? query.q.trim() : "";

  /**
   * @param {unknown} raw Raw query value.
   * @param {number} max Maximum allowed value (also the default).
   * @param {string} label Field name, for error messages.
   * @returns {{ok: true, value: number}|{ok: false, message: string}} Parsed limit.
   */
  function parseLimit(raw, max, label) {
    const value = raw === undefined ? max : Number(raw);
    if (!Number.isInteger(value) || value < 1) {
      return { ok: false, message: `${label} must be a positive integer.` };
    }
    if (value > max) {
      return { ok: false, message: `${label} must be at most ${max}.` };
    }
    return { ok: true, value };
  }

  const videoLimit = parseLimit(
    query.videoLimit,
    ADVANCED_LIMITS.video,
    "videoLimit",
  );
  if (!videoLimit.ok) {
    return videoLimit;
  }
  const playlistLimit = parseLimit(
    query.playlistLimit,
    ADVANCED_LIMITS.playlist,
    "playlistLimit",
  );
  if (!playlistLimit.ok) {
    return playlistLimit;
  }
  const userLimit = parseLimit(
    query.userLimit,
    ADVANCED_LIMITS.user,
    "userLimit",
  );
  if (!userLimit.ok) {
    return userLimit;
  }

  return {
    ok: true,
    q,
    videoLimit: videoLimit.value,
    playlistLimit: playlistLimit.value,
    userLimit: userLimit.value,
  };
}

/**
 * Maps a raw Meilisearch hit to the public search result DTO.
 *
 * @param {object} hit Document as stored in the `videos` index.
 * @param {"owner"|"edit"|"view"} [viewerPermission] The requesting caller's effective
 *   permission level for this video (see {@link loadViewerPermissionsByUploadId}).
 * @returns {object} Public search result payload.
 */
function serializeHit(hit, viewerPermission) {
  return {
    id: hit.id,
    videoId: hit.videoId,
    title: hit.title,
    // The search index stores an unset description as "" (empty string), not
    // null/undefined, so `?? null` alone would never fire here — `|| null`
    // normalizes it back to the same `null` every other video route uses.
    description: hit.description || null,
    visibility: hit.visibility,
    commentsEnabled: Boolean(hit.commentsEnabled),
    viewCount: Number(hit.viewCount ?? 0),
    uploader: serializeUserRef(hit.userId, hit.username, hit.displayName),
    tags: Array.isArray(hit.tags) ? hit.tags : [],
    durationSeconds: hit.durationSeconds ?? null,
    thumbnailUrl: hit.thumbnailUrl ?? null,
    createdAt: hit.createdAt,
    updatedAt: hit.updatedAt,
    viewerPermission,
  };
}

/**
 * Builds the search router.
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createSearchRouter() {
  const router = Router();

  /**
   * GET /search/users — searchUsers
   * Auth: required (any authenticated user). Prefix-matches username or
   * displayName, excluding locked accounts. Powers client-side recipient
   * pickers (e.g. the Upload page's private-share field).
   *
   * @openapi
   * /api/v1/search/users:
   *   get:
   *     tags: [Search]
   *     summary: Search users by username or display name prefix
   *     operationId: searchUsers
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: q
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 25
   *           default: 10
   *     responses:
   *       200:
   *         description: Matching users
   *       400:
   *         description: Invalid query
   *       401:
   *         description: Not authenticated
   *       500:
   *         description: Search failed unexpectedly
   */
  router.get("/search/users", requireAuth, async (req, res) => {
    const parsed = parseUserSearchQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid_query", message: parsed.message });
      return;
    }

    if (!parsed.q) {
      res.status(200).json({ items: [] });
      return;
    }

    try {
      const rows = await User.findAll({
        where: {
          [Op.or]: [
            { username: { [Op.like]: `${parsed.q}%` } },
            { displayName: { [Op.like]: `${parsed.q}%` } },
          ],
        },
        include: [{ model: Role, required: false }],
        order: [["username", "ASC"]],
        limit: parsed.limit,
      });
      const items = rows
        .filter((row) => row.Role?.name !== "locked")
        .map((row) => serializeUserRef(row.id, row.username, row.displayName));
      res.status(200).json({ items });
    } catch (err) {
      logger.error({ err }, "searchUsers failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to search users.",
      });
    }
  });

  /**
   * GET /search — searchVideos
   * Auth: optional. Full-text search across title/description/tags/username.
   * Always available: uses the built-in basic backend by default, or
   * Meilisearch when ENABLE_ADVANCED_SEARCH=true. Returns 503 only when
   * advanced search is enabled and Meilisearch is unreachable.
   *
   * @openapi
   * /api/v1/search:
   *   get:
   *     tags: [Search]
   *     summary: Search public videos by title, description, tags, or uploader username
   *     operationId: searchVideos
   *     parameters:
   *       - name: q
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *       - name: tags
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *         description: Comma-separated tags; results must include all of them.
   *       - name: username
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *       - name: sort
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *           enum: [relevance, newest, oldest, views]
   *           default: relevance
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
   *           maximum: 100
   *           default: 20
   *     responses:
   *       200:
   *         description: Paginated search results
   *       400:
   *         description: Invalid query
   *       500:
   *         description: Search failed unexpectedly
   *       503:
   *         description: Search backend unreachable (advanced search enabled but Meilisearch is down)
   */
  router.get("/search", optionalAuth, async (req, res) => {
    const parsed = parseSearchQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid_query", message: parsed.message });
      return;
    }

    try {
      const result = await searchVideos(parsed);
      const hiddenUploadIds = await loadHiddenUploadIds(req.user?.id);
      const hits = (result.hits || []).filter(
        (hit) => !hiddenUploadIds.has(hit.id),
      );
      const viewerPermissionByUploadId = await loadViewerPermissionsByUploadId(
        hits.map((hit) => ({ id: hit.id, userId: hit.userId })),
        req.user,
        req.authRole,
      );
      res.status(200).json({
        items: hits.map((hit) =>
          serializeHit(hit, viewerPermissionByUploadId.get(hit.id)),
        ),
        page: result.page ?? parsed.page,
        limit: result.hitsPerPage ?? parsed.limit,
        totalHits: result.totalHits ?? 0,
        totalPages: result.totalPages ?? 0,
      });
    } catch (err) {
      handleSearchError(res, err, "searchVideos");
    }
  });

  /**
   * GET /search/suggest — searchSuggest
   * Auth: optional. Lightweight typeahead: a handful of title/username matches.
   * Always available (see GET /search for backend selection details).
   *
   * @openapi
   * /api/v1/search/suggest:
   *   get:
   *     tags: [Search]
   *     summary: Typeahead suggestions for the search box
   *     operationId: searchSuggest
   *     parameters:
   *       - name: q
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 15
   *           default: 8
   *     responses:
   *       200:
   *         description: Suggested matches
   *       400:
   *         description: Invalid query
   *       500:
   *         description: Search failed unexpectedly
   *       503:
   *         description: Search backend unreachable (advanced search enabled but Meilisearch is down)
   */
  router.get("/search/suggest", optionalAuth, async (req, res) => {
    const parsed = parseSuggestQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid_query", message: parsed.message });
      return;
    }

    try {
      const result = await suggestVideos(parsed.q, parsed.limit);
      const hiddenUploadIds = await loadHiddenUploadIds(req.user?.id);
      const hits = (result.hits || []).filter(
        (hit) => !hiddenUploadIds.has(hit.id),
      );
      res.status(200).json({
        items: hits.map((hit) => ({
          id: hit.id,
          videoId: hit.videoId,
          title: hit.title,
          uploader: serializeUserRef(hit.userId, hit.username, hit.displayName),
        })),
      });
    } catch (err) {
      handleSearchError(res, err, "searchSuggest");
    }
  });

  /**
   * GET /search/advanced — searchAdvanced
   * Auth: optional. Combined search across public videos, public playlists
   * (including their contained videos' titles/tags), and users, with fuzzy
   * ("close match") tolerance. Locked users are only visible to admin
   * callers. Powers the search-results page.
   *
   * @openapi
   * /api/v1/search/advanced:
   *   get:
   *     tags: [Search]
   *     summary: Combined fuzzy search across videos, playlists, and users
   *     operationId: searchAdvanced
   *     parameters:
   *       - name: q
   *         in: query
   *         required: false
   *         schema:
   *           type: string
   *       - name: videoLimit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 24
   *           default: 24
   *       - name: playlistLimit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 12
   *           default: 12
   *       - name: userLimit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 8
   *           default: 8
   *     responses:
   *       200:
   *         description: Combined video/playlist/user matches
   *       400:
   *         description: Invalid query
   *       500:
   *         description: Search failed unexpectedly
   *       503:
   *         description: Search backend unreachable (advanced search enabled but Meilisearch is down)
   */
  router.get("/search/advanced", optionalAuth, async (req, res) => {
    const parsed = parseAdvancedSearchQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid_query", message: parsed.message });
      return;
    }

    if (!parsed.q) {
      res.status(200).json({ videos: [], playlists: [], users: [] });
      return;
    }

    try {
      const isAdminCaller = isAdmin(req.authRole);
      // Locked users are indexed like anyone else and only filtered out of
      // the response below for non-admins, so overfetch hits for them -
      // otherwise a locked user occupying a top-N slot would silently crowd
      // out a real, visible match instead of just being dropped.
      const userSearchLimit = isAdminCaller
        ? parsed.userLimit
        : Math.max(parsed.userLimit * 4, 40);

      const [videoResult, playlistResult, userResult, hiddenUploadIds] =
        await Promise.all([
          searchVideosAdvanced({ q: parsed.q, limit: parsed.videoLimit }),
          searchPlaylistsAdvanced({ q: parsed.q, limit: parsed.playlistLimit }),
          searchUsersAdvanced({ q: parsed.q, limit: userSearchLimit }),
          loadHiddenUploadIds(req.user?.id),
        ]);

      const videoHits = (videoResult.hits || []).filter(
        (hit) => !hiddenUploadIds.has(hit.id),
      );
      const videoViewerPermissionByUploadId =
        await loadViewerPermissionsByUploadId(
          videoHits.map((hit) => ({ id: hit.id, userId: hit.userId })),
          req.user,
          req.authRole,
        );
      const videos = videoHits.map((hit) =>
        serializeHit(hit, videoViewerPermissionByUploadId.get(hit.id)),
      );

      const playlistHits = playlistResult.hits || [];
      const playlistIds = playlistHits.map((hit) => hit.id);
      const playlistRows =
        playlistIds.length > 0
          ? await UserPlaylist.findAll({
              where: { id: playlistIds },
              include: [{ model: User, required: false }],
            })
          : [];
      const playlistRowById = new Map(playlistRows.map((row) => [row.id, row]));
      const orderedPlaylistRows = playlistIds
        .map((id) => playlistRowById.get(id))
        .filter(Boolean);
      const playlistsPage = await buildPlaylistsPage(
        orderedPlaylistRows,
        orderedPlaylistRows.length,
        {
          page: 1,
          limit: Math.max(orderedPlaylistRows.length, 1),
          user: req.user,
          role: req.authRole,
        },
      );

      const userHits = userResult.hits || [];
      const userIds = userHits.map((hit) => hit.id);
      const userRows =
        userIds.length > 0
          ? await User.findAll({
              where: { id: userIds },
              include: [{ model: Role, required: false }],
            })
          : [];
      const userRowById = new Map(userRows.map((row) => [row.id, row]));
      const visibleUserRows = userIds
        .map((id) => userRowById.get(id))
        .filter(Boolean)
        .filter((user) => isAdminCaller || user.Role?.name !== "locked")
        .slice(0, parsed.userLimit);
      const uploadCounts = await loadUploadCountsByUserId(
        visibleUserRows.map((user) => user.id),
      );
      const users = visibleUserRows.map((user) =>
        serializeUserListItem(user, {
          isAdminCaller,
          uploadCount: uploadCounts.get(user.id) ?? 0,
        }),
      );

      res.status(200).json({
        videos,
        playlists: playlistsPage.items,
        users,
      });
    } catch (err) {
      handleSearchError(res, err, "searchAdvanced");
    }
  });

  return router;
}
