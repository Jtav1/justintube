const STORAGE_KEY_PREFIX = 'jt.watchPartyHideJoinInfo:'

/**
 * Reads whether the join code should stay hidden for a given Watch Party
 * session, from sessionStorage - scoped per join code (not global) so
 * switching between sessions doesn't carry one party's preference into
 * another, and cleared when the tab closes rather than persisting like a
 * permanent setting would. Defaults to false (shown) when unset.
 * @param {string} code Watch Party join code.
 * @returns {boolean}
 */
export function readHideJoinInfo(code) {
  if (!code) {
    return false
  }
  return sessionStorage.getItem(STORAGE_KEY_PREFIX + code) === 'true'
}

/**
 * Persists whether the join code should stay hidden for a given Watch Party
 * session.
 * @param {string} code Watch Party join code.
 * @param {boolean} hidden
 * @returns {void}
 */
export function writeHideJoinInfo(code, hidden) {
  if (!code) {
    return
  }
  sessionStorage.setItem(STORAGE_KEY_PREFIX + code, String(hidden))
}
