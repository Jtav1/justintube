import { Meilisearch } from "meilisearch";
import {
  loadEligibleDocument,
  loadEligiblePlaylistDocument,
  loadEligibleUserDocument,
} from "./document.js";

/**
 * Meilisearch index name for video documents.
 *
 * @type {string}
 */
const INDEX_NAME = process.env.MEILI_INDEX_NAME || "videos";

/**
 * Meilisearch index name for playlist documents.
 *
 * @type {string}
 */
const PLAYLIST_INDEX_NAME = process.env.MEILI_PLAYLIST_INDEX_NAME || "playlists";

/**
 * Meilisearch index name for user documents.
 *
 * @type {string}
 */
const USER_INDEX_NAME = process.env.MEILI_USER_INDEX_NAME || "users";

/** @type {import("meilisearch").Meilisearch|null} */
let cachedClient = null;

/** @type {boolean} */
let indexEnsured = false;

/** @type {boolean} */
let playlistIndexEnsured = false;

/** @type {boolean} */
let userIndexEnsured = false;

/**
 * Returns a lazily created Meilisearch client from env vars.
 *
 * @private
 * @returns {import("meilisearch").Meilisearch} Configured client.
 */
function getClient() {
  if (!cachedClient) {
    cachedClient = new Meilisearch({
      host: process.env.MEILI_HOST,
      apiKey: process.env.MEILI_MASTER_KEY || undefined,
    });
  }
  return cachedClient;
}

/**
 * Checks whether a Meilisearch index already exists, so callers can avoid
 * re-issuing `createIndex` (which enqueues a task that fails server-side
 * with "Index already exists" rather than rejecting the initiating call).
 *
 * @private
 * @param {import("meilisearch").Meilisearch} client Meilisearch client.
 * @param {string} indexName Index UID to check.
 * @returns {Promise<boolean>} True if the index already exists.
 */
async function indexExists(client, indexName) {
  try {
    await client.getIndex(indexName);
    return true;
  } catch (err) {
    if (err?.cause?.code === "index_not_found") {
      return false;
    }
    throw err;
  }
}

/**
 * Lazily creates and configures the video index (searchable/filterable/sortable
 * attributes). Safe to call repeatedly; only does work once per process.
 *
 * @private
 * @returns {Promise<void>} Resolves once the index is ready.
 */
async function ensureIndexConfigured() {
  if (indexEnsured) {
    return;
  }
  const client = getClient();
  if (!(await indexExists(client, INDEX_NAME))) {
    await client.createIndex(INDEX_NAME, { primaryKey: "id" }).waitTask();
  }
  const index = client.index(INDEX_NAME);
  // Settings updates only enqueue a task server-side; awaiting the call alone
  // just confirms the enqueue, not that Meilisearch has applied it yet. A
  // search immediately afterward (e.g. right after a fresh boot) can 400 with
  // "not filterable" if it races ahead of the task. `.waitTask()` (attached
  // by the client to the returned promise) blocks until the task finishes.
  await Promise.all([
    index.updateSearchableAttributes([
      "title",
      "description",
      "tags",
      "username",
      "displayName",
    ]).waitTask(),
    index.updateFilterableAttributes(["visibility", "userId", "tags", "username"]).waitTask(),
    index.updateSortableAttributes(["createdAt", "viewCount"]).waitTask(),
  ]);
  indexEnsured = true;
}

/**
 * Upserts or removes a video's search document based on current eligibility.
 * Throws on failure — unlike the other functions in this file, this one is
 * called exclusively by `lib/search-reindex.js`'s nightly batch, which needs
 * a real exception to know a row's sync failed and should stay `"pending"`
 * for retry on the next run (its own per-row try/catch provides the safety
 * net that write-path callers elsewhere get from catching internally).
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to sync.
 * @returns {Promise<void>} Resolves once the sync completes.
 */
export async function syncVideoIndex(originalUploadId) {
  await ensureIndexConfigured();
  const doc = await loadEligibleDocument(originalUploadId);
  const index = getClient().index(INDEX_NAME);
  if (doc) {
    await index.addDocuments([doc]);
  } else {
    await index.deleteDocument(originalUploadId);
  }
}

/**
 * Removes a video's search document outright, for use when the underlying
 * ORIGINAL_UPLOADS row is already gone (post-delete). Never throws.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to remove.
 * @returns {Promise<void>} Resolves once the removal attempt completes.
 */
export async function removeVideoDocument(originalUploadId) {
  try {
    await getClient().index(INDEX_NAME).deleteDocument(originalUploadId);
  } catch (err) {
    console.error(`[search:meilisearch] removeVideoDocument(${originalUploadId}) failed:`, err);
  }
}

/**
 * Runs a full-text video search against Meilisearch. Throws on failure so the
 * caller can return a clean error.
 *
 * @param {object} params Search parameters.
 * @param {string} [params.q] Free-text query.
 * @param {string[]} [params.tags] Tags that must all be present (AND).
 * @param {string} [params.username] Exact uploader username filter.
 * @param {string} [params.sort] Meilisearch sort clause, e.g. "createdAt:desc".
 * @param {number} params.page 1-indexed page number.
 * @param {number} params.limit Page size.
 * @returns {Promise<import("meilisearch").SearchResponse>} Raw Meilisearch response.
 */
export async function searchVideos({ q, tags, username, sort, page, limit }) {
  await ensureIndexConfigured();
  const filterClauses = ["visibility = public"];
  if (tags?.length) {
    filterClauses.push(`(${tags.map((t) => `tags = ${JSON.stringify(t)}`).join(" OR ")})`);
  }
  if (username) {
    filterClauses.push(`username = ${JSON.stringify(username)}`);
  }
  return getClient()
    .index(INDEX_NAME)
    .search(q || "", {
      filter: filterClauses.join(" AND "),
      sort: sort ? [sort] : undefined,
      page,
      hitsPerPage: limit,
    });
}

/**
 * Runs a lightweight typeahead query against Meilisearch. Throws on failure
 * (same contract as `searchVideos`).
 *
 * @param {string} q Free-text query.
 * @param {number} [limit] Maximum suggestions to return.
 * @returns {Promise<import("meilisearch").SearchResponse>} Raw Meilisearch response.
 */
export async function suggestVideos(q, limit = 8) {
  await ensureIndexConfigured();
  return getClient()
    .index(INDEX_NAME)
    .search(q || "", {
      filter: "visibility = public",
      limit,
      attributesToRetrieve: ["id", "videoId", "title", "userId", "username", "displayName"],
    });
}

/**
 * Lazily creates and configures the playlist index. Safe to call repeatedly.
 *
 * @private
 * @returns {Promise<void>} Resolves once the index is ready.
 */
async function ensurePlaylistIndexConfigured() {
  if (playlistIndexEnsured) {
    return;
  }
  const client = getClient();
  if (!(await indexExists(client, PLAYLIST_INDEX_NAME))) {
    await client.createIndex(PLAYLIST_INDEX_NAME, { primaryKey: "id" }).waitTask();
  }
  const index = client.index(PLAYLIST_INDEX_NAME);
  // See the matching comment in ensureIndexConfigured() above for why these
  // are awaited via .waitTask() rather than just awaiting the enqueue call.
  await Promise.all([
    index.updateSearchableAttributes([
      "title",
      "description",
      "username",
      "displayName",
      "contentText",
    ]).waitTask(),
    index.updateFilterableAttributes(["visibility", "userId"]).waitTask(),
    index.updateSortableAttributes(["createdAt"]).waitTask(),
  ]);
  playlistIndexEnsured = true;
}

/**
 * Upserts or removes a playlist's search document based on current
 * eligibility. Throws on failure — same rationale as `syncVideoIndex` above
 * (exclusively called by `lib/search-reindex.js`'s nightly batch).
 *
 * @param {number} playlistId USER_PLAYLISTS id to sync.
 * @returns {Promise<void>} Resolves once the sync completes.
 */
export async function syncPlaylistIndex(playlistId) {
  await ensurePlaylistIndexConfigured();
  const doc = await loadEligiblePlaylistDocument(playlistId);
  const index = getClient().index(PLAYLIST_INDEX_NAME);
  if (doc) {
    await index.addDocuments([
      {
        ...doc,
        contentText: [...(doc.contentTitles || []), ...(doc.contentTags || [])].join(" "),
      },
    ]);
  } else {
    await index.deleteDocument(playlistId);
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
    await getClient().index(PLAYLIST_INDEX_NAME).deleteDocument(playlistId);
  } catch (err) {
    console.error(`[search:meilisearch] removePlaylistDocument(${playlistId}) failed:`, err);
  }
}

/**
 * Runs a full-text playlist search against Meilisearch (typo tolerance is
 * always on for this backend, so this call also serves the advanced/combined
 * search flow — no separate "advanced" variant is needed here).
 *
 * @param {object} params Search parameters.
 * @param {string} [params.q] Free-text query.
 * @param {string} [params.sort] Meilisearch sort clause, e.g. "createdAt:desc".
 * @param {number} params.page 1-indexed page number.
 * @param {number} params.limit Page size.
 * @returns {Promise<import("meilisearch").SearchResponse>} Raw Meilisearch response.
 */
export async function searchPlaylists({ q, sort, page, limit }) {
  await ensurePlaylistIndexConfigured();
  return getClient()
    .index(PLAYLIST_INDEX_NAME)
    .search(q || "", {
      filter: "visibility = public",
      sort: sort ? [sort] : undefined,
      page,
      hitsPerPage: limit,
    });
}

/**
 * Lazily creates and configures the user index. Safe to call repeatedly.
 *
 * @private
 * @returns {Promise<void>} Resolves once the index is ready.
 */
async function ensureUserIndexConfigured() {
  if (userIndexEnsured) {
    return;
  }
  const client = getClient();
  if (!(await indexExists(client, USER_INDEX_NAME))) {
    await client.createIndex(USER_INDEX_NAME, { primaryKey: "id" }).waitTask();
  }
  const index = client.index(USER_INDEX_NAME);
  // See the matching comment in ensureIndexConfigured() above for why this is
  // awaited via .waitTask() rather than just awaiting the enqueue call.
  await index.updateSearchableAttributes(["username", "displayName"]).waitTask();
  userIndexEnsured = true;
}

/**
 * Upserts or removes a user's search document based on current eligibility
 * (excluded once locked). Throws on failure — same rationale as
 * `syncVideoIndex` above (exclusively called by `lib/search-reindex.js`'s
 * nightly batch).
 *
 * @param {number} userId USERS id to sync.
 * @returns {Promise<void>} Resolves once the sync completes.
 */
export async function syncUserIndex(userId) {
  await ensureUserIndexConfigured();
  const doc = await loadEligibleUserDocument(userId);
  const index = getClient().index(USER_INDEX_NAME);
  if (doc) {
    await index.addDocuments([doc]);
  } else {
    await index.deleteDocument(userId);
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
    await getClient().index(USER_INDEX_NAME).deleteDocument(userId);
  } catch (err) {
    console.error(`[search:meilisearch] removeUserDocument(${userId}) failed:`, err);
  }
}

/**
 * Runs a full-text user search against Meilisearch (typo tolerance always
 * on, serves the advanced/combined search flow directly).
 *
 * @param {object} params Search parameters.
 * @param {string} [params.q] Free-text query.
 * @param {number} params.limit Maximum results to return.
 * @returns {Promise<import("meilisearch").SearchResponse>} Raw Meilisearch response.
 */
export async function searchUsers({ q, limit }) {
  await ensureUserIndexConfigured();
  return getClient()
    .index(USER_INDEX_NAME)
    .search(q || "", { limit });
}
