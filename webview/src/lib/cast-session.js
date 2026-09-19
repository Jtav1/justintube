const ACTIVE_SESSION_KEY = 'jt.castActiveSessionId'

/**
 * Reads the CAST session this browser was last in, so a reload rejoins it
 * instead of silently dropping out. A stale or ended id is self-correcting:
 * the socket's `session:join` ack fails and CastContext clears it.
 * @returns {number|null}
 */
export function readActiveCastSessionId() {
  const raw = localStorage.getItem(ACTIVE_SESSION_KEY)
  if (!raw) {
    return null
  }
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Persists (or clears, when passed null) the active CAST session id.
 * @param {number|null} sessionId
 */
export function writeActiveCastSessionId(sessionId) {
  if (sessionId == null) {
    localStorage.removeItem(ACTIVE_SESSION_KEY)
    return
  }
  localStorage.setItem(ACTIVE_SESSION_KEY, String(sessionId))
}
