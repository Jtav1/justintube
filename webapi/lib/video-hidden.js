/**
 * Per-viewer "hidden video" helpers, backed by USER_HIDDEN_VIDEOS. Distinct
 * from VIDEO_METADATA.visibility (see lib/video-access.js) — this tracks a
 * user's personal preference to no longer see a specific video, not a
 * property of the video itself.
 */

import { UserHiddenVideo } from "./models/index.js";

/**
 * Loads the set of ORIGINAL_UPLOADS ids the given user has hidden.
 *
 * @param {number|null|undefined} userId Authenticated user's id, if any.
 * @returns {Promise<Set<number>>} Hidden upload ids (empty when userId is null/undefined).
 */
export async function loadHiddenUploadIds(userId) {
  if (userId == null) {
    return new Set();
  }
  const rows = await UserHiddenVideo.findAll({
    where: { userId },
    attributes: ["originalUploadId"],
  });
  return new Set(rows.map((row) => row.originalUploadId));
}

/**
 * Returns whether the given user has hidden the given upload.
 *
 * @param {number|null|undefined} userId Authenticated user's id, if any.
 * @param {number} originalUploadId ORIGINAL_UPLOADS id to check.
 * @returns {Promise<boolean>} Whether a USER_HIDDEN_VIDEOS row exists for this pair.
 */
export async function isVideoHidden(userId, originalUploadId) {
  if (userId == null) {
    return false;
  }
  const row = await UserHiddenVideo.findOne({
    where: { userId, originalUploadId },
    attributes: ["id"],
  });
  return Boolean(row);
}
