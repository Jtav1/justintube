import apiClient, { setCsrfToken } from './client.js'

/**
 * Issues (or refreshes) a CSRF token for the current session.
 * @returns {Promise<string>} The CSRF token to send on subsequent mutating requests.
 */
export async function fetchCsrfToken() {
  const res = await apiClient.get('/api/v1/auth/csrf')
  setCsrfToken(res.data.csrfToken)
  return res.data.csrfToken
}

/**
 * Logs in with a username/password pair, establishing a cookie session.
 * @param {string} username
 * @param {string} password
 * @returns {Promise<object>} The authenticated user's public profile.
 */
export async function login(username, password) {
  const res = await apiClient.post('/api/v1/auth/login', { username, password })
  setCsrfToken(res.data.csrfToken)
  return res.data.user
}

/**
 * Registers a new account with a username/email/password, establishing a
 * cookie session (registration auto-logs the account in).
 * @param {string} username
 * @param {string} email
 * @param {string} password
 * @returns {Promise<object>} The newly created user's public profile.
 */
export async function register(username, email, password) {
  const res = await apiClient.post('/api/v1/auth/register', { username, email, password })
  setCsrfToken(res.data.csrfToken)
  return res.data.user
}

/**
 * Logs out the current session and clears its cookie.
 * @returns {Promise<void>}
 */
export async function logout() {
  await apiClient.post('/api/v1/auth/logout')
}

/**
 * Fetches the current session's user, if any.
 * @returns {Promise<object|null>} The user's public profile, or null if not logged in.
 */
export async function getCurrentUser() {
  try {
    const res = await apiClient.get('/api/v1/auth/me')
    return res.data
  } catch (err) {
    if (err.response && err.response.status === 401) {
      return null
    }
    throw err
  }
}

/**
 * Resends the email verification message to the current session's user.
 * @returns {Promise<{success: boolean}>}
 */
export async function resendVerification() {
  const res = await apiClient.post('/api/v1/auth/resend-verification')
  return res.data
}

/**
 * Consumes a one-time email verification token, marking the account verified.
 * @param {string} token
 * @returns {Promise<object>} The verified user's public profile.
 */
export async function verifyEmail(token) {
  const res = await apiClient.post('/api/v1/auth/verify-email', { token })
  return res.data.user
}

/**
 * Changes the current session's password (session cookie only).
 * @param {string} currentPassword
 * @param {string} newPassword
 * @returns {Promise<{success: boolean}>}
 */
export async function changePassword(currentPassword, newPassword) {
  const res = await apiClient.post('/api/v1/auth/password', { currentPassword, newPassword })
  return res.data
}
