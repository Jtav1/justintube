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
 * Allowed USER_PLAYLISTS.kind values. "standard" is a normal user-created
 * playlist; "likes" is the single per-user, system-managed "My Likes"
 * playlist whose membership is driven entirely by video like/dislike
 * actions (see lib/likes-playlist.js) rather than direct item mutation.
 *
 * @type {string[]}
 */
export const PLAYLIST_KIND_VALUES = ["standard", "likes"];

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

/**
 * Allowed REPORTS.report_type values, covering every entity a user can flag
 * for policy review plus non-entity-scoped "website"/"system" reports.
 *
 * @type {string[]}
 */
export const REPORT_TYPE_VALUES = ["video", "user", "playlist", "website", "system"];

/**
 * Allowed PROCESSING_JOB_RUNS.job_kind values - one per processing job kind
 * (see `processing/lib/queue.js`'s own `kind` dispatch).
 *
 * @type {string[]}
 */
export const JOB_KIND_VALUES = [
  "rendition",
  "thumbnail",
  "subtitle",
  "hls",
  "embed",
  "normalize",
  "hash",
];

/**
 * Allowed PROCESSING_JOB_RUNS.status values - mirrors FILE_VERSIONS/
 * ORIGINAL_UPLOADS' own pending/processing/complete/failed lifecycle, plus
 * "cancelled" for a row whose BullMQ job was explicitly removed from the
 * queue (see `cancelQueuedTranscodeJobs`) before it ran to completion.
 *
 * @type {string[]}
 */
export const JOB_RUN_STATUS_VALUES = ["pending", "processing", "complete", "failed", "cancelled"];
