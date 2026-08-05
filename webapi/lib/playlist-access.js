import { isAdmin, isOwnerOrAdmin } from "./video-access.js";

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

/**
 * Returns true when the caller may edit a playlist's metadata (name,
 * description) and manage its items (add/remove): the owner, an admin, or a
 * user holding an "edit" PLAYLIST_ACCESS grant. Distinct from
 * `isOwnerOrAdmin`, which gates delete/visibility/access-management.
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user.
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @param {import('sequelize').Model} playlist USER_PLAYLISTS row.
 * @param {boolean} [hasEditGrant=false] Whether the caller holds an "edit" PLAYLIST_ACCESS grant.
 * @returns {boolean} Whether the caller may edit the playlist's metadata/items.
 */
export function canEditPlaylist(user, role, playlist, hasEditGrant = false) {
  if (isOwnerOrAdmin(user, role, playlist)) {
    return true;
  }
  return Boolean(hasEditGrant);
}
