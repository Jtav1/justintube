import { Router } from "express";
import { optionalAuth } from "../lib/auth/require-auth.js";
import { advancedSearchEnabled, searchVideos, suggestVideos } from "../lib/search.js";
import { serializeUserRef } from "../lib/serialize-user-ref.js";

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
  console.error(`${label} failed:`, err);
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
    uploader: serializeUserRef(hit.userId, hit.username, hit.displayName),
    tags: Array.isArray(hit.tags) ? hit.tags : [],
    durationSeconds: hit.durationSeconds ?? null,
    thumbnailUrl: hit.thumbnailUrl ?? null,
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
      res.status(200).json({
        items: (result.hits || []).map(serializeHit),
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
   *     responses:
   *       200:
   *         description: Suggested matches
   *       500:
   *         description: Search failed unexpectedly
   *       503:
   *         description: Search backend unreachable (advanced search enabled but Meilisearch is down)
   */
  router.get("/search/suggest", optionalAuth, async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

    try {
      const result = await suggestVideos(q, SUGGEST_LIMIT);
      res.status(200).json({
        items: (result.hits || []).map((hit) => ({
          id: hit.id,
          title: hit.title,
          uploader: serializeUserRef(hit.userId, hit.username, hit.displayName),
        })),
      });
    } catch (err) {
      handleSearchError(res, err, "searchSuggest");
    }
  });

  return router;
}
