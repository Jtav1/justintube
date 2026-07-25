import { Router } from "express";
import { optionalAuth } from "../lib/auth/require-auth.js";
import { searchEnabled, searchVideos, suggestVideos } from "../lib/search.js";

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
 * Fixed suggestion count for GET /search/suggest.
 *
 * @type {number}
 */
const SUGGEST_LIMIT = 8;

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
 * Sends the shared "advanced search is disabled on this server" response.
 * Mirrors `registration_disabled` in `routes/auth.js`.
 *
 * @param {import('express').Response} res Express response.
 * @returns {void} No return value; sends the response.
 */
function sendSearchDisabled(res) {
  res.status(403).json({
    error: "search_disabled",
    message: "Advanced search is disabled on this server.",
  });
}

/**
 * Sends the shared "search backend is unreachable" response.
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

  const sortKey = typeof query.sort === "string" ? query.sort.trim() : "relevance";
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

  const limitRaw = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
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
 * Maps a raw Meilisearch hit to the public search result DTO.
 *
 * @param {object} hit Document as stored in the `videos` index.
 * @returns {object} Public search result payload.
 */
function serializeHit(hit) {
  return {
    id: hit.id,
    title: hit.title,
    description: hit.description ?? null,
    visibility: hit.visibility,
    commentsEnabled: Boolean(hit.commentsEnabled),
    viewCount: Number(hit.viewCount ?? 0),
    userId: hit.userId ?? null,
    username: hit.username ?? null,
    displayName: hit.displayName ?? null,
    tags: Array.isArray(hit.tags) ? hit.tags : [],
    createdAt: hit.createdAt,
    updatedAt: hit.updatedAt,
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
   * GET /search — searchVideos
   * Auth: optional. Full-text search across title/description/tags/username.
   * Returns 403 when advanced search is disabled on this server, 503 when it's
   * enabled but the search backend is unreachable.
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
   *       403:
   *         description: Advanced search is disabled on this server
   *       503:
   *         description: Search backend unreachable
   */
  router.get("/search", optionalAuth, async (req, res) => {
    if (!searchEnabled()) {
      sendSearchDisabled(res);
      return;
    }

    const parsed = parseSearchQuery(req.query);
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid_query", message: parsed.message });
      return;
    }

    try {
      const result = await searchVideos(parsed);
      res.status(200).json({
        items: (result.hits || []).map(serializeHit),
        page: result.page ?? parsed.page,
        limit: result.hitsPerPage ?? parsed.limit,
        totalHits: result.totalHits ?? 0,
        totalPages: result.totalPages ?? 0,
      });
    } catch (err) {
      console.error("searchVideos failed:", err);
      sendSearchUnavailable(res);
    }
  });

  /**
   * GET /search/suggest — searchSuggest
   * Auth: optional. Lightweight typeahead: a handful of title/username matches.
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
   *     responses:
   *       200:
   *         description: Suggested matches
   *       403:
   *         description: Advanced search is disabled on this server
   *       503:
   *         description: Search backend unreachable
   */
  router.get("/search/suggest", optionalAuth, async (req, res) => {
    if (!searchEnabled()) {
      sendSearchDisabled(res);
      return;
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    try {
      const result = await suggestVideos(q, SUGGEST_LIMIT);
      res.status(200).json({
        items: (result.hits || []).map((hit) => ({
          id: hit.id,
          title: hit.title,
          username: hit.username ?? null,
        })),
      });
    } catch (err) {
      console.error("searchSuggest failed:", err);
      sendSearchUnavailable(res);
    }
  });

  return router;
}
