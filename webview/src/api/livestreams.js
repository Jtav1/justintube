import apiClient from './client.js'

/**
 * Fetches the current user's stream key metadata (masked - never the raw key).
 * @returns {Promise<{keyDisplay: string, createdAt: string, lastUsedAt: string|null, revokedAt: string|null}>}
 */
export async function getMyStreamKey() {
  const res = await apiClient.get('/api/v1/me/stream-key')
  return res.data
}

/**
 * Generates a fresh stream key for the current user, invalidating any previous
 * one. Also creates the first key. The plaintext `key` is only ever present
 * in this response.
 * @returns {Promise<{keyDisplay: string, key: string, createdAt: string, lastUsedAt: string|null, revokedAt: string|null}>}
 */
export async function rotateMyStreamKey() {
  const res = await apiClient.post('/api/v1/me/stream-key/rotate')
  return res.data
}

/**
 * Revokes the current user's stream key.
 * @returns {Promise<void>}
 */
export async function revokeMyStreamKey() {
  await apiClient.delete('/api/v1/me/stream-key')
}

/**
 * Fetches the current user's own livestream (any visibility) - used by the
 * Go Live page to load current settings.
 * @returns {Promise<object>}
 */
export async function getMyLivestream() {
  const res = await apiClient.get('/api/v1/me/livestream')
  return res.data
}

/**
 * Lists currently-live streams visible to the caller, newest-started first.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number}>}
 */
export async function listLivestreams({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/livestreams', { params: { page, limit } })
  return res.data
}

/**
 * Fetches a single livestream by id.
 * @param {string|number} id
 * @returns {Promise<object>}
 */
export async function getLivestream(id) {
  const res = await apiClient.get(`/api/v1/livestreams/${id}`)
  return res.data
}

/**
 * Updates a livestream's title/description/visibility. Owner or admin only.
 * @param {string|number} id
 * @param {{ title?: string|null, description?: string|null, visibility?: string }} body
 * @returns {Promise<object>}
 */
export async function updateLivestream(id, body) {
  const res = await apiClient.patch(`/api/v1/livestreams/${id}`, body)
  return res.data
}

/**
 * Fetches HLS playback info for a livestream.
 * @param {string|number} id
 * @returns {Promise<{status: string, playbackUrl: string|null}>}
 */
export async function getLivestreamPlayback(id) {
  const res = await apiClient.get(`/api/v1/livestreams/${id}/playback`)
  return res.data
}

/**
 * Fetches a user's current live status, for a channel-page "LIVE" badge.
 * @param {string} username
 * @returns {Promise<{live: boolean, livestreamId?: number, title?: string|null, viewerCount?: number}>}
 */
export async function getUserLiveStatus(username) {
  const res = await apiClient.get(`/api/v1/users/${username}/live`)
  return res.data
}
