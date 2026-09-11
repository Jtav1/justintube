const PLAYLIST_SHUFFLE_ENABLED_KEY = 'jt.playlistShuffleEnabled'

/**
 * Reads the user's playlist shuffle preference - a browser-local setting
 * (never sent to the server) governing whether the playlist queue's "next"
 * control advances to a random item versus the next one in order. Defaults
 * to off.
 * @returns {boolean}
 */
export function readPlaylistShuffleEnabled() {
  return localStorage.getItem(PLAYLIST_SHUFFLE_ENABLED_KEY) === 'true'
}

/**
 * Persists the user's playlist shuffle preference to this browser.
 * @param {boolean} enabled
 */
export function writePlaylistShuffleEnabled(enabled) {
  localStorage.setItem(PLAYLIST_SHUFFLE_ENABLED_KEY, enabled ? 'true' : 'false')
}
