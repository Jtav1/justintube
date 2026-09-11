const LAST_LOGIN_KEY = 'jt.lastLogIn'

/**
 * Reads the last-recorded login timestamp for this browser - written just
 * before each fresh login/register overwrites `user.lastLogIn` with the new
 * session's timestamp, so it always reflects the login *before* the current
 * one. Used to show "previous login" without exposing the current session's
 * own login time.
 * @returns {string|null}
 */
export function readLastLogIn() {
  return localStorage.getItem(LAST_LOGIN_KEY)
}

/**
 * Persists a login timestamp to this browser, for display as "previous
 * login" the next time a fresh login happens. No-ops for a falsy value (e.g.
 * a freshly registered account has no prior login).
 * @param {string|null|undefined} lastLogIn
 */
export function writeLastLogIn(lastLogIn) {
  if (lastLogIn) {
    localStorage.setItem(LAST_LOGIN_KEY, lastLogIn)
  }
}
