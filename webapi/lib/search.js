import { Meilisearch } from "meilisearch";
import { ContentTag, OriginalUpload, User, VideoMetadata } from "./models/index.js";

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
 * Returns whether advanced (Meilisearch-backed) search is enabled. Mirrors the
 * `ENABLE_*` flag pattern used by `registrationEnabled()` in `routes/auth.js`.
 * When false, no code in this module talks to Meilisearch and the `search`
 * container is not required to run the app.
 *
 * @returns {boolean} True when ENABLE_ADVANCED_SEARCH is the string "true".
 */
export function searchEnabled() {
  return String(process.env.ENABLE_ADVANCED_SEARCH || "").toLowerCase() === "true";
}

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
  if (indexEnsured || !searchEnabled()) {
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
 * Loads the searchable document for an upload, or null when it isn't eligible
 * to appear in search (missing metadata, not yet processed, or not public).
 * This is the single source of truth for search eligibility.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id.
 * @returns {Promise<object|null>} Document payload, or null when not eligible.
 */
async function loadEligibleDocument(originalUploadId) {
  const upload = await OriginalUpload.findByPk(originalUploadId, {
    include: [
      { model: VideoMetadata, as: "VideoMetadata", required: false },
      { model: User, required: false },
    ],
  });
  if (!upload || !upload.VideoMetadata) {
    return null;
  }
  if (upload.status !== "ready") {
    return null;
  }
  if (upload.VideoMetadata.visibility !== "public") {
    return null;
  }

  const tags = await ContentTag.findAll({ where: { originalUploadId } });

  return {
    id: upload.id,
    title: upload.VideoMetadata.title,
    description: upload.VideoMetadata.description ?? "",
    tags: tags.map((t) => t.tag),
    userId: upload.userId ?? null,
    username: upload.User?.username ?? null,
    displayName: upload.User?.displayName ?? null,
    visibility: upload.VideoMetadata.visibility,
    commentsEnabled: Boolean(upload.VideoMetadata.commentsEnabled),
    viewCount: Number(upload.VideoMetadata.viewCount ?? 0),
    createdAt: upload.VideoMetadata.createdAt,
    updatedAt: upload.VideoMetadata.updatedAt,
  };
}

/**
 * Upserts or removes a video's search document based on current eligibility.
 * The single entry point every write path (upload processing, video edits,
 * visibility changes, uploader renames) should call after changing state that
 * affects search. No-ops when search is disabled. Never throws — errors are
 * caught and logged so a Meilisearch outage never breaks a write request.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to sync.
 * @returns {Promise<void>} Resolves once the sync attempt completes.
 */
export async function syncVideoIndex(originalUploadId) {
  if (!searchEnabled()) {
    return;
  }
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
    console.error(`[search] syncVideoIndex(${originalUploadId}) failed:`, err);
  }
}

/**
 * Removes a video's search document outright, for use when the underlying
 * ORIGINAL_UPLOADS row is already gone (post-delete). No-ops when search is
 * disabled. Never throws — errors are caught and logged.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to remove.
 * @returns {Promise<void>} Resolves once the removal attempt completes.
 */
export async function removeVideoDocument(originalUploadId) {
  if (!searchEnabled()) {
    return;
  }
  try {
    await getClient().index(INDEX_NAME).deleteDocument(originalUploadId);
  } catch (err) {
    console.error(`[search] removeVideoDocument(${originalUploadId}) failed:`, err);
  }
}

/**
 * Runs a full-text video search against Meilisearch. Unlike the sync
 * functions, this throws on failure so the caller can return a clean error.
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
      attributesToRetrieve: ["id", "title", "username"],
    });
}
