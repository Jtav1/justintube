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

/**
 * Returns true when the caller may edit a video's metadata/content (title,
 * description, tags): the owner, an admin, or a user holding an "edit"
 * VIDEO_ACCESS grant. Distinct from `isOwnerOrAdmin`, which gates the
 * strictly owner/admin-only actions (delete, visibility, access management)
 * that edit-grantees may never perform.
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user.
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @param {import('sequelize').Model} upload ORIGINAL_UPLOADS row.
 * @param {boolean} [hasEditGrant=false] Whether the caller holds an "edit" VIDEO_ACCESS grant.
 * @returns {boolean} Whether the caller may edit the video's metadata/content.
 */
export function canEditVideo(user, role, upload, hasEditGrant = false) {
  if (isOwnerOrAdmin(user, role, upload)) {
    return true;
  }
  return Boolean(hasEditGrant);
}

/**
 * Resolves the caller's effective permission level for a video/playlist they
 * can already view: "owner" for the owner or an admin, "edit" for a user
 * holding an edit-level access grant, "view" otherwise (anonymous viewers,
 * public/unlisted viewers, and plain view-grantees all collapse to "view").
 * Generic over both VIDEO_ACCESS and PLAYLIST_ACCESS - callers pass whichever
 * resource's owning userId. Intended for embedding in GET/PATCH response
 * payloads so a non-owner client can learn its own edit rights without
 * needing the owner-only list-access endpoint.
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user.
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @param {number|null|undefined} ownerId Owning user id (upload.userId / playlist.userId).
 * @param {boolean} [hasEditGrant=false] Whether the caller holds an "edit" access grant.
 * @returns {"owner"|"edit"|"view"} The caller's effective permission level.
 */
export function resolveViewerPermission(user, role, ownerId, hasEditGrant = false) {
  if (isAdmin(role)) {
    return "owner";
  }
  if (user && ownerId != null && Number(user.id) === Number(ownerId)) {
    return "owner";
  }
  if (hasEditGrant) {
    return "edit";
  }
  return "view";
}
