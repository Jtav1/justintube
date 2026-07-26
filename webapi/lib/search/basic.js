import MiniSearch from "minisearch";
import { loadAllEligibleDocuments, loadEligibleDocument } from "./document.js";

/**
 * MiniSearch full-text fields. `tagsText` (not `tags`) is indexed — MiniSearch
 * uses the same `extractField` for tokenizing searchable fields AND for
 * capturing `storeFields` values, so indexing the real `tags` array through a
 * custom extractField would also corrupt the *stored* copy of `tags` that
 * filters/DTOs rely on. `tagsText` is a synthetic, space-joined string added
 * to each document purely for tokenization (see `toIndexedDocument` below);
 * the stored `tags` field stays the original array, untouched.
 *
 * @type {string[]}
 */
const FIELDS = ["title", "description", "tagsText", "username", "displayName"];

/**
 * Fields copied verbatim into every search result (needed by filters and by
 * `routes/search.js`'s DTO mapping).
 *
 * @type {string[]}
 */
const STORE_FIELDS = [
  "title",
  "description",
  "tags",
  "userId",
  "username",
  "displayName",
  "visibility",
  "commentsEnabled",
  "viewCount",
  "createdAt",
  "updatedAt",
];

/** @type {MiniSearch|null} */
let index = null;

/** @type {Promise<void>|null} */
let buildPromise = null;

/**
 * Builds a fresh, empty MiniSearch index configured for video documents.
 *
 * @private
 * @returns {MiniSearch} Empty configured index.
 */
function createIndex() {
  return new MiniSearch({
    idField: "id",
    fields: FIELDS,
    storeFields: STORE_FIELDS,
  });
}

/**
 * Adds the synthetic `tagsText` field MiniSearch tokenizes for tag matching,
 * without touching the original `tags` array (see the `FIELDS` comment above
 * for why this can't be done via a custom `extractField` instead).
 *
 * @private
 * @param {object} doc Document in `loadEligibleDocument` shape.
 * @returns {object} Document ready to pass to `index.add()`.
 */
function toIndexedDocument(doc) {
  return { ...doc, tagsText: (doc.tags || []).join(" ") };
}

/**
 * Lazily builds the in-process index from the database on first use.
 * Concurrent callers share one build via `buildPromise`.
 *
 * @private
 * @returns {Promise<void>} Resolves once the index is ready.
 */
async function ensureBuilt() {
  if (index) {
    return;
  }
  if (!buildPromise) {
    buildPromise = (async () => {
      const docs = await loadAllEligibleDocuments();
      const newIndex = createIndex();
      for (const doc of docs) {
        newIndex.add(toIndexedDocument(doc));
      }
      index = newIndex;
    })().finally(() => {
      buildPromise = null;
    });
  }
  await buildPromise;
}

/**
 * Inserts or updates a document in the index (MiniSearch has no built-in
 * upsert: `discard()` throws if the id isn't already present).
 *
 * @private
 * @param {object} doc Document in `loadEligibleDocument` shape.
 * @returns {void}
 */
function upsert(doc) {
  if (index.has(doc.id)) {
    index.discard(doc.id);
  }
  index.add(toIndexedDocument(doc));
}

/**
 * Upserts or removes a video's search document based on current eligibility.
 * Never throws — errors are caught and logged.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to sync.
 * @returns {Promise<void>} Resolves once the sync attempt completes.
 */
export async function syncVideoIndex(originalUploadId) {
  try {
    await ensureBuilt();
    const doc = await loadEligibleDocument(originalUploadId);
    if (doc) {
      upsert(doc);
    } else if (index.has(originalUploadId)) {
      index.discard(originalUploadId);
    }
  } catch (err) {
    console.error(`[search:basic] syncVideoIndex(${originalUploadId}) failed:`, err);
  }
}

/**
 * Removes a video's search document outright. Never throws.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to remove.
 * @returns {Promise<void>} Resolves once the removal attempt completes.
 */
export async function removeVideoDocument(originalUploadId) {
  try {
    await ensureBuilt();
    if (index.has(originalUploadId)) {
      index.discard(originalUploadId);
    }
  } catch (err) {
    console.error(`[search:basic] removeVideoDocument(${originalUploadId}) failed:`, err);
  }
}

/**
 * Returns whether a stored search result matches the tags/username filters.
 * Visibility is not checked here: every document that ever enters the index
 * is already public+ready by construction (`loadEligibleDocument`'s gate).
 *
 * @private
 * @param {object} doc Stored search result (includes STORE_FIELDS).
 * @param {{tags?: string[], username?: string}} filters Requested filters.
 * @returns {boolean} True when the document matches all requested filters.
 */
function matchesFilters(doc, { tags, username }) {
  if (tags?.length && !tags.every((t) => (doc.tags || []).includes(t))) {
    return false;
  }
  if (username && doc.username !== username) {
    return false;
  }
  return true;
}

/**
 * Sort comparators matching the sort-clause strings `routes/search.js` already
 * produces for the Meilisearch backend.
 *
 * @type {Record<string, (a: object, b: object) => number>}
 */
const SORTERS = {
  "createdAt:desc": (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  "createdAt:asc": (a, b) => new Date(a.createdAt) - new Date(b.createdAt),
  "viewCount:desc": (a, b) => b.viewCount - a.viewCount,
};

/**
 * Runs a full-text video search against the in-process index. Throws on
 * failure so the caller can return a clean error.
 *
 * @param {object} params Search parameters.
 * @param {string} [params.q] Free-text query (empty/omitted = browse all).
 * @param {string[]} [params.tags] Tags that must all be present (AND).
 * @param {string} [params.username] Exact uploader username filter.
 * @param {string} [params.sort] Sort clause, e.g. "createdAt:desc".
 * @param {number} params.page 1-indexed page number.
 * @param {number} params.limit Page size.
 * @returns {Promise<{hits: object[], page: number, hitsPerPage: number, totalHits: number, totalPages: number}>}
 *   Same response shape as the Meilisearch backend.
 */
export async function searchVideos({ q, tags, username, sort, page, limit }) {
  await ensureBuilt();
  const query = q ? q : MiniSearch.wildcard;
  let hits = index.search(query, {
    prefix: true,
    filter: (result) => matchesFilters(result, { tags, username }),
  });

  if (sort && SORTERS[sort]) {
    hits = [...hits].sort(SORTERS[sort]);
  } else if (!q) {
    // Wildcard browse with no explicit sort: newest first, not MiniSearch's
    // internal (arbitrary, all-scores-equal) wildcard ordering.
    hits = [...hits].sort(SORTERS["createdAt:desc"]);
  }

  const totalHits = hits.length;
  const totalPages = Math.max(1, Math.ceil(totalHits / limit));
  const start = (page - 1) * limit;

  return {
    hits: hits.slice(start, start + limit),
    page,
    hitsPerPage: limit,
    totalHits,
    totalPages,
  };
}

/**
 * Runs a lightweight typeahead query against the in-process index. Throws on
 * failure (same contract as `searchVideos`).
 *
 * @param {string} q Free-text query.
 * @param {number} [limit] Maximum suggestions to return.
 * @returns {Promise<{hits: object[]}>} Suggestion results.
 */
export async function suggestVideos(q, limit = 8) {
  await ensureBuilt();
  if (!q) {
    return { hits: [] };
  }
  const hits = index.search(q, { prefix: true }).slice(0, limit);
  return { hits };
}

/**
 * Discards the in-process index so it rebuilds from the database on next use.
 * For tests only: `resetTables()` wipes rows directly, bypassing the sync
 * hooks that would otherwise keep this index consistent.
 *
 * @returns {void}
 */
export function resetBasicIndexForTests() {
  index = null;
  buildPromise = null;
}
