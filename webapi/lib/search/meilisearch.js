import { Meilisearch } from "meilisearch";
import { loadEligibleDocument } from "./document.js";

/**
 * Meilisearch index name for video documents.
 *
 * @type {string}
 */
const INDEX_NAME = process.env.MEILI_INDEX_NAME || "videos";

/** @type {import("meilisearch").Meilisearch|null} */
let cachedClient = null;

/** @type {boolean} */
let indexEnsured = false;

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
  await client.createIndex(INDEX_NAME, { primaryKey: "id" }).catch(() => {});
  const index = client.index(INDEX_NAME);
  await index.updateSearchableAttributes([
    "title",
    "description",
    "tags",
    "username",
    "displayName",
  ]);
  await index.updateFilterableAttributes(["visibility", "userId", "tags", "username"]);
  await index.updateSortableAttributes(["createdAt", "viewCount"]);
  indexEnsured = true;
}

/**
 * Upserts or removes a video's search document based on current eligibility.
 * Never throws — errors are caught and logged so a Meilisearch outage never
 * breaks a write request.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to sync.
 * @returns {Promise<void>} Resolves once the sync attempt completes.
 */
export async function syncVideoIndex(originalUploadId) {
  try {
    await ensureIndexConfigured();
    const doc = await loadEligibleDocument(originalUploadId);
    const index = getClient().index(INDEX_NAME);
    if (doc) {
      await index.addDocuments([doc]);
    } else {
      await index.deleteDocument(originalUploadId);
    }
  } catch (err) {
    console.error(`[search:meilisearch] syncVideoIndex(${originalUploadId}) failed:`, err);
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
      attributesToRetrieve: ["id", "title", "userId", "username", "displayName"],
    });
}
