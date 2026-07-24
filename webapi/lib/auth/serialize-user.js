/**
 * Maps a User Sequelize instance (optionally with Role included) to the public
 * JSON shape returned by auth endpoints. Never includes passwordHash or keys.
 *
 * @param {import('sequelize').Model} user User model instance.
 * @param {import('sequelize').Model|null} [role] Optional Role instance if not on user.Role.
 * @returns {{
 *   id: number,
 *   username: string,
 *   email: string,
 *   displayName: string|null,
 *   bio: string|null,
 *   emailVerified: boolean,
 *   uploader: boolean,
 *   role: string|null
 * }} Public user profile object.
 */
export function serializeUser(user, role = null) {
  const resolvedRole = role || user.Role || null;
  return {
    id: user.id,
    username: user.username,
    email: user.email,
    displayName: user.displayName ?? null,
    bio: user.bio ?? null,
    emailVerified: Boolean(user.emailVerified),
    uploader: Boolean(user.uploader),
    role: resolvedRole ? resolvedRole.name : null,
  };
}
