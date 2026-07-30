import apiClient from './client.js'

/**
 * Fetches the current session's full account settings (includes fields not
 * present on `/auth/me`, like avatarFilename/bannerFilename).
 * @returns {Promise<object>}
 */
export async function getMySettings() {
  const res = await apiClient.get('/api/v1/me/settings')
  return res.data
}

/**
 * Updates the current session's editable account fields (username,
 * displayName, bio, email).
 * @param {{ username?: string, displayName?: string, bio?: string, email?: string }} updates
 * @returns {Promise<object>} The updated account settings.
 */
export async function updateMySettings(updates) {
  const res = await apiClient.patch('/api/v1/me', updates)
  return res.data
}
