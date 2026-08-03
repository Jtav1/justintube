import { PlaylistItem, UserPlaylist } from "./models/index.js";
import { syncPlaylistIndex } from "./search.js";

/**
 * Display title for the auto-managed "My Likes" playlist.
 *
 * @type {string}
 */
export const LIKES_PLAYLIST_TITLE = "My Likes";

/**
 * Finds a user's system-managed "My Likes" playlist (USER_PLAYLISTS row with
 * `kind: "likes"`), creating it on first use. At most one exists per user.
 *
 * @param {number} userId Owning user's id.
 * @returns {Promise<import('sequelize').Model>} The user's "My Likes" playlist.
 */
export async function getOrCreateLikesPlaylist(userId) {
  const [playlist] = await UserPlaylist.findOrCreate({
    where: { userId, kind: "likes" },
    defaults: { title: LIKES_PLAYLIST_TITLE, visibility: "private" },
  });
  return playlist;
}

/**
 * Adds a video to the user's "My Likes" playlist, creating the playlist first
 * if this is their first-ever like. Idempotent.
 *
 * @param {number} userId Liking user's id.
 * @param {number} originalUploadId ORIGINAL_UPLOADS id of the liked video.
 * @returns {Promise<void>} Resolves once the playlist reflects the like.
 */
export async function addVideoToLikesPlaylist(userId, originalUploadId) {
  const playlist = await getOrCreateLikesPlaylist(userId);
  await PlaylistItem.findOrCreate({
    where: { playlistId: playlist.id, originalUploadId },
  });
  await playlist.update({ lastAddedAt: new Date() });
  syncPlaylistIndex(playlist.id);
}

/**
 * Removes a video from the user's "My Likes" playlist, if one exists. A
 * no-op when the user has never liked a video (no playlist yet).
 *
 * @param {number} userId User's id.
 * @param {number} originalUploadId ORIGINAL_UPLOADS id of the unliked video.
 * @returns {Promise<void>} Resolves once the playlist no longer contains the video.
 */
export async function removeVideoFromLikesPlaylist(userId, originalUploadId) {
  const playlist = await UserPlaylist.findOne({ where: { userId, kind: "likes" } });
  if (!playlist) {
    return;
  }
  await PlaylistItem.destroy({ where: { playlistId: playlist.id, originalUploadId } });
  syncPlaylistIndex(playlist.id);
}
