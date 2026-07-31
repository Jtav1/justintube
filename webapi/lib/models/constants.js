/**
 * Allowed resolution labels, kept in sync with the OpenAPI `Resolution` enum.
 *
 * @type {string[]}
 */
export const RESOLUTION_VALUES = [
  "240p",
  "360p",
  "480p",
  "720p",
  "1080p",
  "2kHD",
  "4kHD",
];

/**
 * Allowed visibility labels for videos and playlists.
 *
 * @type {string[]}
 */
export const VISIBILITY_VALUES = ["public", "private", "unlisted", "hidden"];

/**
 * Allowed like_value integers on VIDEO_LIKES (1 = like, -1 = dislike).
 *
 * @type {number[]}
 */
export const LIKE_VALUES = [1, -1];

/**
 * Allowed media-type labels for ORIGINAL_UPLOADS and TRANSCODE_PROFILES,
 * distinguishing audio-only uploads from standard video uploads.
 *
 * @type {string[]}
 */
export const MEDIA_TYPE_VALUES = ["video", "audio"];

/**
 * Allowed search-index sync states for ORIGINAL_UPLOADS/USER_PLAYLISTS/USERS.
 * "pending" means the row needs to be (re)synced by the next Meilisearch
 * reindex run (see lib/search-reindex.js); "indexed" means it was already
 * synced and hasn't changed since. Not used by the default in-process search
 * backend, which stays instantly consistent on every mutation.
 *
 * @type {string[]}
 */
export const SEARCH_INDEX_STATUS_VALUES = ["pending", "indexed"];
