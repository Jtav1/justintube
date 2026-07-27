import { isAdmin } from "./video-access.js";

/**
 * Playlist visibility helpers, mirroring the video visibility model but
 * reading straight off USER_PLAYLISTS.visibility (playlists have no separate
 * metadata table).
 */

/**
 * Returns true when the caller may view the playlist given its visibility.
 * Public, unlisted, and hidden are viewable by id; private requires owner,
 * access grant, or admin.
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user (optional).
 * @param {import('sequelize').Model|null|undefined} role Authenticated role (optional).
 * @param {import('sequelize').Model} playlist USER_PLAYLISTS row.
 * @param {boolean} [hasAccessGrant=false] Whether PLAYLIST_ACCESS grants this user.
 * @returns {boolean} Whether the caller may view the playlist.
 */
export function canViewPlaylist(user, role, playlist, hasAccessGrant = false) {
  const visibility = playlist.visibility;
  if (
    visibility === "public" ||
    visibility === "unlisted" ||
    visibility === "hidden"
  ) {
    return true;
  }

  if (visibility !== "private") {
    return false;
  }

  if (isAdmin(role)) {
    return true;
  }
  if (user && playlist.userId != null && Number(user.id) === Number(playlist.userId)) {
    return true;
  }
  return Boolean(hasAccessGrant);
}
