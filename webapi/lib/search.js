import * as advanced from "./search/meilisearch.js";
import * as basic from "./search/basic.js";

export { resetBasicIndexForTests } from "./search/basic.js";

/**
 * Returns whether the Meilisearch-backed search backend should be used.
 * Mirrors the `ENABLE_*` flag pattern used by `registrationEnabled()` in
 * `routes/auth.js`. When false (the default), the in-process basic backend
 * (`./search/basic.js`) is used instead — search is always available, this
 * flag only picks which backend serves it.
 *
 * @returns {boolean} True when ENABLE_ADVANCED_SEARCH is the string "true".
 */
export function advancedSearchEnabled() {
  return String(process.env.ENABLE_ADVANCED_SEARCH || "").toLowerCase() === "true";
}

/**
 * Returns the active search backend module for the current request. Backend
 * selection is a static, config-time choice, not a runtime failover: if
 * advanced search is enabled but Meilisearch is unreachable, callers should
 * surface that error rather than silently falling back to the basic backend.
 *
 * @private
 * @returns {typeof advanced|typeof basic} The active backend module.
 */
function backend() {
  return advancedSearchEnabled() ? advanced : basic;
}

/**
 * Upserts or removes a video's search document in the active backend based on
 * current eligibility. The single entry point every write path (upload
 * processing, video edits, visibility changes, uploader renames) should call
 * after changing state that affects search. Never throws.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to sync.
 * @returns {Promise<void>} Resolves once the sync attempt completes.
 */
export function syncVideoIndex(originalUploadId) {
  return backend().syncVideoIndex(originalUploadId);
}

/**
 * Removes a video's search document outright, for use when the underlying
 * ORIGINAL_UPLOADS row is already gone (post-delete). Never throws.
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to remove.
 * @returns {Promise<void>} Resolves once the removal attempt completes.
 */
export function removeVideoDocument(originalUploadId) {
  return backend().removeVideoDocument(originalUploadId);
}

/**
 * Runs a full-text video search against the active backend. Throws on
 * failure so the caller can return a clean error.
 *
 * @param {object} params Search parameters (see backend modules for shape).
 * @returns {Promise<object>} Search response (`{hits, page, hitsPerPage, totalHits, totalPages}`).
 */
export function searchVideos(params) {
  return backend().searchVideos(params);
}

/**
 * Runs a lightweight typeahead query against the active backend. Throws on
 * failure (same contract as `searchVideos`).
 *
 * @param {string} q Free-text query.
 * @param {number} [limit] Maximum suggestions to return.
 * @returns {Promise<object>} Suggestion response (`{hits}`).
 */
export function suggestVideos(q, limit) {
  return backend().suggestVideos(q, limit);
}
