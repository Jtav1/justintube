import * as advanced from "./search/meilisearch.js";
import * as basic from "./search/basic.js";
import { advancedSearchEnabled } from "./search-backend-config.js";
import { deferOrRemovePlaylist, deferOrRemoveUser, deferOrRemoveVideo } from "./search-reindex.js";

export { resetBasicIndexForTests } from "./search/basic.js";

/**
 * Returns whether the Meilisearch-backed search backend should be used.
 * Mirrors the `ENABLE_*` flag pattern used by `registrationEnabled()` in
 * `routes/auth.js`. When false (the default), the in-process basic backend
 * (`./search/basic.js`) is used instead — search is always available, this
 * flag only picks which backend serves it. Defined in
 * `./search-backend-config.js` (split out to avoid a circular import with
 * `./search-reindex.js`, which also needs it) and re-exported here so
 * existing importers of `advancedSearchEnabled` from this module keep
 * working unchanged.
 *
 * @type {() => boolean}
 */
export { advancedSearchEnabled };

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
 * Upserts or removes a video's search document based on current eligibility.
 * The single entry point every write path (upload processing, video edits,
 * visibility changes, uploader renames) should call after changing state
 * that affects search. Never throws.
 *
 * On the default in-process backend this is instant, exactly as before. On
 * the Meilisearch backend it's deferred: still/newly eligible content is
 * just marked `searchIndexStatus: "pending"` for the next nightly reindex
 * (see lib/search-reindex.js) rather than hitting Meilisearch synchronously;
 * content that just became ineligible is still removed immediately (takedown
 * correctness shouldn't wait for a nightly batch).
 *
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to sync.
 * @returns {Promise<void>} Resolves once the sync attempt completes.
 */
export function syncVideoIndex(originalUploadId) {
  return advancedSearchEnabled()
    ? deferOrRemoveVideo(originalUploadId)
    : backend().syncVideoIndex(originalUploadId);
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

/**
 * Upserts or removes a playlist's search document based on current
 * eligibility. Never throws. The entry point every write path affecting a
 * playlist's searchability (create/update/delete/item add/remove) should
 * call after changing state. Same instant-vs-deferred split as
 * `syncVideoIndex` (see its doc comment) depending on the active backend.
 *
 * @param {number} playlistId USER_PLAYLISTS id to sync.
 * @returns {Promise<void>} Resolves once the sync attempt completes.
 */
export function syncPlaylistIndex(playlistId) {
  return advancedSearchEnabled()
    ? deferOrRemovePlaylist(playlistId)
    : backend().syncPlaylistIndex(playlistId);
}

/**
 * Removes a playlist's search document outright, for use when the underlying
 * USER_PLAYLISTS row is already gone (post-delete). Never throws.
 *
 * @param {number} playlistId USER_PLAYLISTS id to remove.
 * @returns {Promise<void>} Resolves once the removal attempt completes.
 */
export function removePlaylistDocument(playlistId) {
  return backend().removePlaylistDocument(playlistId);
}

/**
 * Upserts or removes a user's search document based on current eligibility
 * (excluded once locked). Never throws. The entry point every write path
 * affecting a user's searchability (rename, lock/unlock, registration)
 * should call after changing state. Same instant-vs-deferred split as
 * `syncVideoIndex` (see its doc comment) depending on the active backend.
 *
 * @param {number} userId USERS id to sync.
 * @returns {Promise<void>} Resolves once the sync attempt completes.
 */
export function syncUserIndex(userId) {
  return advancedSearchEnabled()
    ? deferOrRemoveUser(userId)
    : backend().syncUserIndex(userId);
}

/**
 * Removes a user's search document outright, for use when the underlying
 * USERS row is already gone (post-delete). Never throws.
 *
 * @param {number} userId USERS id to remove.
 * @returns {Promise<void>} Resolves once the removal attempt completes.
 */
export function removeUserDocument(userId) {
  return backend().removeUserDocument(userId);
}

/**
 * Runs a full-text playlist search against the active backend. Throws on
 * failure so the caller can return a clean error. Exists for parity with
 * `searchVideos`; not currently called by the v1 UI (which uses the
 * advanced/combined flow below).
 *
 * @param {object} params Search parameters (see backend modules for shape).
 * @returns {Promise<object>} Search response.
 */
export function searchPlaylists(params) {
  return backend().searchPlaylists(params);
}

/**
 * Runs a fuzzy ("close match") video search for the advanced/combined search
 * flow. The basic backend needs an explicit fuzzy option; Meilisearch's typo
 * tolerance is always on, so it just reuses the plain `searchVideos` call.
 * Throws on failure so the caller can return a clean error.
 *
 * @param {{q?: string, limit: number}} params Search parameters.
 * @returns {Promise<object>} Search response (`{hits}` or Meilisearch response).
 */
export async function searchVideosAdvanced({ q, limit }) {
  return advancedSearchEnabled()
    ? backend().searchVideos({ q, page: 1, limit })
    : backend().searchVideosAdvanced({ q, limit });
}

/**
 * Runs a fuzzy ("close match") playlist search for the advanced/combined
 * search flow, matching on title/description/owner/content. Same
 * backend-selection rationale as `searchVideosAdvanced`.
 *
 * @param {{q?: string, limit: number}} params Search parameters.
 * @returns {Promise<object>} Search response (`{hits}` or Meilisearch response).
 */
export async function searchPlaylistsAdvanced({ q, limit }) {
  return advancedSearchEnabled()
    ? backend().searchPlaylists({ q, page: 1, limit })
    : backend().searchPlaylistsAdvanced({ q, limit });
}

/**
 * Runs a fuzzy ("close match") username/display-name search for the
 * advanced/combined search flow. Same backend-selection rationale as
 * `searchVideosAdvanced`.
 *
 * @param {{q?: string, limit: number}} params Search parameters.
 * @returns {Promise<object>} Search response (`{hits}` or Meilisearch response).
 */
export async function searchUsersAdvanced({ q, limit }) {
  return advancedSearchEnabled()
    ? backend().searchUsers({ q, limit })
    : backend().searchUsersAdvanced({ q, limit });
}
