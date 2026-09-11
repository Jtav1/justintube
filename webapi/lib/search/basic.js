import MiniSearch from "minisearch";
import {
  loadAllEligibleDocuments,
  loadAllEligiblePlaylistDocuments,
  loadAllEligibleUserDocuments,
  loadEligibleDocument,
  loadEligiblePlaylistDocument,
  loadEligibleUserDocument,
} from "./document.js";
import { logger } from "../logger.js";

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
  "videoId",
  "title",
  "description",
  "tags",
  "userId",
  "username",
  "displayName",
  "visibility",
  "commentsEnabled",
  "viewCount",
  "durationSeconds",
  "thumbnailUrl",
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
    logger.error({ err }, `[search:basic] syncVideoIndex(${originalUploadId}) failed`);
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
    logger.error({ err }, `[search:basic] removeVideoDocument(${originalUploadId}) failed`);
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
 * Runs a fuzzy ("close match") video search for the advanced/combined search
 * flow. Unlike `searchVideos`, this tolerates typos (`fuzzy: 0.2`, MiniSearch's
 * edit-distance-relative-to-term-length option) — the plain `/search` endpoint
 * intentionally stays exact/prefix so its existing behavior doesn't change.
 *
 * @param {object} params Search parameters.
 * @param {string} [params.q] Free-text query.
 * @param {number} params.limit Maximum results to return.
 * @returns {Promise<{hits: object[]}>} Matching video documents.
 */
export async function searchVideosAdvanced({ q, limit }) {
  await ensureBuilt();
  if (!q) {
    return { hits: [] };
  }
  const hits = index.search(q, {
    prefix: true,
    fuzzy: 0.2,
    filter: (result) => matchesFilters(result, {}),
  });
  return { hits: hits.slice(0, limit) };
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
  playlistIndex = null;
  playlistBuildPromise = null;
  userIndex = null;
  userBuildPromise = null;
}

/**
 * MiniSearch full-text fields for playlist documents. `contentText` (not
 * `contentTitles`/`contentTags`) is indexed — same synthetic-field trick as
 * `tagsText` above, so tokenizing playlist content doesn't corrupt the stored
 * `contentTitles`/`contentTags` arrays (which aren't stored at all here,
 * since nothing downstream needs them back — see `PLAYLIST_STORE_FIELDS`).
 *
 * @type {string[]}
 */
const PLAYLIST_FIELDS = ["title", "description", "username", "displayName", "contentText"];

/**
 * Fields copied verbatim into every playlist search result.
 *
 * @type {string[]}
 */
const PLAYLIST_STORE_FIELDS = [
  "title",
  "description",
  "userId",
  "username",
  "displayName",
  "visibility",
  "itemCount",
  "createdAt",
  "updatedAt",
];

/** @type {MiniSearch|null} */
let playlistIndex = null;

/** @type {Promise<void>|null} */
let playlistBuildPromise = null;

/**
 * Builds a fresh, empty MiniSearch index configured for playlist documents.
 *
 * @private
 * @returns {MiniSearch} Empty configured index.
 */
function createPlaylistIndex() {
  return new MiniSearch({
    idField: "id",
    fields: PLAYLIST_FIELDS,
    storeFields: PLAYLIST_STORE_FIELDS,
  });
}

/**
 * Adds the synthetic `contentText` field MiniSearch tokenizes for
 * playlist-content matching (contained videos' titles/tags).
 *
 * @private
 * @param {object} doc Document in `loadEligiblePlaylistDocument` shape.
 * @returns {object} Document ready to pass to `playlistIndex.add()`.
 */
function toIndexedPlaylistDocument(doc) {
  return {
    ...doc,
    contentText: [...(doc.contentTitles || []), ...(doc.contentTags || [])].join(" "),
  };
}

/**
 * Lazily builds the in-process playlist index from the database on first use.
 *
 * @private
 * @returns {Promise<void>} Resolves once the index is ready.
 */
async function ensurePlaylistBuilt() {
  if (playlistIndex) {
    return;
  }
  if (!playlistBuildPromise) {
    playlistBuildPromise = (async () => {
      const docs = await loadAllEligiblePlaylistDocuments();
      const newIndex = createPlaylistIndex();
      for (const doc of docs) {
        newIndex.add(toIndexedPlaylistDocument(doc));
      }
      playlistIndex = newIndex;
    })().finally(() => {
      playlistBuildPromise = null;
    });
  }
  await playlistBuildPromise;
}

/**
 * Inserts or updates a document in the playlist index.
 *
 * @private
 * @param {object} doc Document in `loadEligiblePlaylistDocument` shape.
 * @returns {void}
 */
function upsertPlaylist(doc) {
  if (playlistIndex.has(doc.id)) {
    playlistIndex.discard(doc.id);
  }
  playlistIndex.add(toIndexedPlaylistDocument(doc));
}

/**
 * Upserts or removes a playlist's search document based on current
 * eligibility. Never throws — errors are caught and logged.
 *
 * @param {number} playlistId USER_PLAYLISTS id to sync.
 * @returns {Promise<void>} Resolves once the sync attempt completes.
 */
export async function syncPlaylistIndex(playlistId) {
  try {
    await ensurePlaylistBuilt();
    const doc = await loadEligiblePlaylistDocument(playlistId);
    if (doc) {
      upsertPlaylist(doc);
    } else if (playlistIndex.has(playlistId)) {
      playlistIndex.discard(playlistId);
    }
  } catch (err) {
    logger.error({ err }, `[search:basic] syncPlaylistIndex(${playlistId}) failed`);
  }
}

/**
 * Removes a playlist's search document outright. Never throws.
 *
 * @param {number} playlistId USER_PLAYLISTS id to remove.
 * @returns {Promise<void>} Resolves once the removal attempt completes.
 */
export async function removePlaylistDocument(playlistId) {
  try {
    await ensurePlaylistBuilt();
    if (playlistIndex.has(playlistId)) {
      playlistIndex.discard(playlistId);
    }
  } catch (err) {
    logger.error({ err }, `[search:basic] removePlaylistDocument(${playlistId}) failed`);
  }
}

/**
 * Runs a full-text playlist search against the in-process index (prefix,
 * exact — parity with `searchVideos`, not currently used by v1 UI but kept
 * symmetrical/available).
 *
 * @param {object} params Search parameters.
 * @param {string} [params.q] Free-text query.
 * @param {string} [params.sort] Sort clause, e.g. "createdAt:desc".
 * @param {number} params.page 1-indexed page number.
 * @param {number} params.limit Page size.
 * @returns {Promise<{hits: object[], page: number, hitsPerPage: number, totalHits: number, totalPages: number}>}
 */
export async function searchPlaylists({ q, sort, page, limit }) {
  await ensurePlaylistBuilt();
  const query = q ? q : MiniSearch.wildcard;
  let hits = playlistIndex.search(query, { prefix: true });

  if (sort && SORTERS[sort]) {
    hits = [...hits].sort(SORTERS[sort]);
  } else if (!q) {
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
 * Runs a fuzzy ("close match") playlist search for the advanced/combined
 * search flow, matching on title/description/owner/content.
 *
 * @param {object} params Search parameters.
 * @param {string} [params.q] Free-text query.
 * @param {number} params.limit Maximum results to return.
 * @returns {Promise<{hits: object[]}>} Matching playlist documents.
 */
export async function searchPlaylistsAdvanced({ q, limit }) {
  await ensurePlaylistBuilt();
  if (!q) {
    return { hits: [] };
  }
  const hits = playlistIndex.search(q, { prefix: true, fuzzy: 0.2 });
  return { hits: hits.slice(0, limit) };
}

/**
 * Fields indexed for user documents (search-matching only — rendering fields
 * like bio/avatar/uploadCount are hydrated from the database after search).
 *
 * @type {string[]}
 */
const USER_FIELDS = ["username", "displayName"];

/**
 * Fields copied verbatim into every user search result.
 *
 * @type {string[]}
 */
const USER_STORE_FIELDS = ["username", "displayName"];

/** @type {MiniSearch|null} */
let userIndex = null;

/** @type {Promise<void>|null} */
let userBuildPromise = null;

/**
 * Builds a fresh, empty MiniSearch index configured for user documents.
 *
 * @private
 * @returns {MiniSearch} Empty configured index.
 */
function createUserIndex() {
  return new MiniSearch({
    idField: "id",
    fields: USER_FIELDS,
    storeFields: USER_STORE_FIELDS,
  });
}

/**
 * Lazily builds the in-process user index from the database on first use.
 *
 * @private
 * @returns {Promise<void>} Resolves once the index is ready.
 */
async function ensureUserBuilt() {
  if (userIndex) {
    return;
  }
  if (!userBuildPromise) {
    userBuildPromise = (async () => {
      const docs = await loadAllEligibleUserDocuments();
      const newIndex = createUserIndex();
      for (const doc of docs) {
        newIndex.add(doc);
      }
      userIndex = newIndex;
    })().finally(() => {
      userBuildPromise = null;
    });
  }
  await userBuildPromise;
}

/**
 * Inserts or updates a document in the user index.
 *
 * @private
 * @param {object} doc Document in `loadEligibleUserDocument` shape.
 * @returns {void}
 */
function upsertUser(doc) {
  if (userIndex.has(doc.id)) {
    userIndex.discard(doc.id);
  }
  userIndex.add(doc);
}

/**
 * Upserts or removes a user's search document based on current eligibility
 * (excluded once locked). Never throws — errors are caught and logged.
 *
 * @param {number} userId USERS id to sync.
 * @returns {Promise<void>} Resolves once the sync attempt completes.
 */
export async function syncUserIndex(userId) {
  try {
    await ensureUserBuilt();
    const doc = await loadEligibleUserDocument(userId);
    if (doc) {
      upsertUser(doc);
    } else if (userIndex.has(userId)) {
      userIndex.discard(userId);
    }
  } catch (err) {
    logger.error({ err }, `[search:basic] syncUserIndex(${userId}) failed`);
  }
}

/**
 * Removes a user's search document outright. Never throws.
 *
 * @param {number} userId USERS id to remove.
 * @returns {Promise<void>} Resolves once the removal attempt completes.
 */
export async function removeUserDocument(userId) {
  try {
    await ensureUserBuilt();
    if (userIndex.has(userId)) {
      userIndex.discard(userId);
    }
  } catch (err) {
    logger.error({ err }, `[search:basic] removeUserDocument(${userId}) failed`);
  }
}

/**
 * Runs a fuzzy ("close match") username/display-name search for the
 * advanced/combined search flow.
 *
 * @param {object} params Search parameters.
 * @param {string} [params.q] Free-text query.
 * @param {number} params.limit Maximum results to return.
 * @returns {Promise<{hits: object[]}>} Matching user documents.
 */
export async function searchUsersAdvanced({ q, limit }) {
  await ensureUserBuilt();
  if (!q) {
    return { hits: [] };
  }
  const hits = userIndex.search(q, { prefix: true, fuzzy: 0.2 });
  return { hits: hits.slice(0, limit) };
}
