/**
 * Video resolution seam for CAST queue items.
 *
 * Replaces dixtube-live's `server/mediacms.js`, which resolved media over the
 * external MediaCMS REST API. Justintube IS the video platform, so this
 * becomes an internal lookup against the video store (DB/service) once one
 * exists.
 */

/**
 * @typedef {object} ResolvedVideo
 * @property {string} videoId
 * @property {string} title
 * @property {string} [thumbnailUrl]
 * @property {number} [durationSeconds]
 * @property {string} [author] Uploader display name.
 * @property {string} [streamUrl] Direct progressive (MP4) URL — preferred for cast compatibility.
 * @property {string} [hlsUrl] HLS master playlist URL, if transcoded.
 */

/**
 * Resolves a video id to the metadata a CAST queue item needs.
 *
 * @param {string} videoId Internal video id.
 * @returns {Promise<ResolvedVideo>} Resolved metadata.
 * @throws {Error} If the video does not exist or is not viewable by the session.
 */
export async function resolveVideo(videoId) {
  // TODO: internal lookup (respecting visibility/access rules) once the video
  // store exists. Field mapping mirrors dixtube-live's resolveMedia() output.
  throw new Error(`resolveVideo not implemented (videoId: ${videoId})`);
}
