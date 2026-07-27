/**
 * Video visibility and ownership helpers used by discovery and watch routes.
 */

/**
 * Returns true when the role name is admin.
 *
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @returns {boolean} Whether the role is admin.
 */
export function isAdmin(role) {
  return role?.name === "admin";
}

/**
 * Returns true when the role name is admin or moderator.
 *
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @returns {boolean} Whether the role may moderate content.
 */
export function isModeratorOrAdmin(role) {
  const name = role?.name;
  return name === "admin" || name === "moderator";
}

/**
 * Returns true when the user owns the upload or is an admin.
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user.
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @param {import('sequelize').Model} upload ORIGINAL_UPLOADS row.
 * @returns {boolean} Whether the caller may mutate the video as owner/admin.
 */
export function isOwnerOrAdmin(user, role, upload) {
  if (isAdmin(role)) {
    return true;
  }
  if (!user || upload.userId == null) {
    return false;
  }
  return Number(user.id) === Number(upload.userId);
}

/**
 * Returns true when the caller may watch the video given its visibility.
 * The owner (and admins) may always view their own video regardless of
 * visibility. Otherwise: `public`/`unlisted` are viewable by anyone;
 * `private`/`hidden` require a VIDEO_ACCESS grant. `hidden` is a stricter
 * state than `unlisted` (e.g. a takedown) — unlike `unlisted`, it is not
 * openly viewable by id.
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user (optional).
 * @param {import('sequelize').Model|null|undefined} role Authenticated role (optional).
 * @param {import('sequelize').Model} upload ORIGINAL_UPLOADS row.
 * @param {import('sequelize').Model} metadata VIDEO_METADATA row.
 * @param {boolean} [hasAccessGrant=false] Whether VIDEO_ACCESS grants this user.
 * @returns {boolean} Whether the caller may view the video.
 */
export function canViewVideo(user, role, upload, metadata, hasAccessGrant = false) {
  if (user && upload.userId != null && Number(user.id) === Number(upload.userId)) {
    return true;
  }
  if (isAdmin(role)) {
    return true;
  }

  const visibility = metadata.visibility;
  if (visibility === "public" || visibility === "unlisted") {
    return true;
  }
  if (visibility === "private" || visibility === "hidden") {
    return Boolean(hasAccessGrant);
  }
  return false;
}
