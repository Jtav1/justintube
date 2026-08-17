const VOLUME_KEY = 'jt.volume'

/**
 * Reads the user's video/audio volume preference - a browser-local setting
 * (never sent to the server). Defaults to 1 (100%) when nothing is stored or
 * the stored value is invalid.
 * @returns {number} Volume from 0 to 1.
 */
export function readVolume() {
  const raw = localStorage.getItem(VOLUME_KEY)
  if (raw === null) {
    return 1
  }
  const value = Number(raw)
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    return 1
  }
  return value
}

/**
 * Persists the user's video/audio volume preference to this browser.
 * @param {number} volume Volume from 0 to 1.
 */
export function writeVolume(volume) {
  localStorage.setItem(VOLUME_KEY, String(volume))
}
