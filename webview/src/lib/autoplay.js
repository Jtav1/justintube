const AUTOPLAY_ENABLED_KEY = 'jt.autoplayEnabled'

/**
 * Reads the user's autoplay preference - a browser-local setting (never sent
 * to the server) governing whether the video player auto-advances to a
 * random suggested video once the current one finishes. Defaults to off.
 * @returns {boolean}
 */
export function readAutoplayEnabled() {
  return localStorage.getItem(AUTOPLAY_ENABLED_KEY) === 'true'
}

/**
 * Persists the user's autoplay preference to this browser.
 * @param {boolean} enabled
 */
export function writeAutoplayEnabled(enabled) {
  localStorage.setItem(AUTOPLAY_ENABLED_KEY, enabled ? 'true' : 'false')
}
