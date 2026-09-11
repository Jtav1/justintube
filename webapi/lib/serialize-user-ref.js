/**
 * Builds the standard `{ userId, username, displayName }` shape used whenever
 * an API response references another user (an uploader, a grant, a profile
 * creator, etc.) so clients never have to make a follow-up lookup just to
 * show who a foreign-key id refers to.
 *
 * @param {number|null|undefined} userId Referenced user's id.
 * @param {string|null|undefined} [username] Referenced user's username, when loaded.
 * @param {string|null|undefined} [displayName] Referenced user's display name, when loaded.
 * @returns {{userId: number|null, username: string|null, displayName: string|null}}
 *   Resolved user reference payload.
 */
export function serializeUserRef(userId, username = null, displayName = null) {
  return {
    userId: userId ?? null,
    username: username ?? null,
    displayName: displayName ?? null,
  };
}
