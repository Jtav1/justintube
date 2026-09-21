const PLAYLIST_AUTOPLAY_ENABLED_KEY_PREFIX = 'jt.playlistAutoplayEnabled.'

/**
 * Reads the user's autoplay preference for a specific playlist - a
 * browser-local setting (never sent to the server), scoped per playlist so
 * each one remembers its own on/off state independently. Defaults to off.
 * @param {string|number} playlistId
 * @returns {boolean}
 */
export function readPlaylistAutoplayEnabled(playlistId) {
  return localStorage.getItem(PLAYLIST_AUTOPLAY_ENABLED_KEY_PREFIX + playlistId) === 'true'
}

/**
 * Persists the user's autoplay preference for a specific playlist to this browser.
 * @param {string|number} playlistId
 * @param {boolean} enabled
 */
export function writePlaylistAutoplayEnabled(playlistId, enabled) {
  localStorage.setItem(PLAYLIST_AUTOPLAY_ENABLED_KEY_PREFIX + playlistId, enabled ? 'true' : 'false')
}
