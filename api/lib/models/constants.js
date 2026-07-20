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
 * Allowed like_value integers on VIDEO_LIKES (1 = like, delete on video id + user id for dislike).
 *
 * @type {number[]}
 */
export const LIKE_VALUES = [1];

/**
 * Allowed notification types
 *
 * @type {string[]}
 */
export const NOTIFICATION_TYPES = [
  "subscription",
  "like",
  "comment",
  "subscriber",
];
