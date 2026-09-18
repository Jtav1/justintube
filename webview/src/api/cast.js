import apiClient from './client.js'

/**
 * Creates a new CAST session, seeding its queue from a playlist (a filtered
 * copy), a single video, or nothing. The caller becomes the session's owner.
 * @param {{ sourceType: 'playlist'|'video'|'empty', playlistId?: number, videoId?: string }} body
 * @returns {Promise<object>} The new session snapshot, including its join code.
 */
export async function createCastSession(body) {
  const res = await apiClient.post('/api/v1/cast', body)
  return res.data
}

/**
 * Joins (or rejoins) a CAST session by its join code.
 * @param {string} code
 * @returns {Promise<object>} The joined session snapshot.
 */
export async function joinCastSession(code) {
  const res = await apiClient.post('/api/v1/cast/join', { code })
  return res.data
}

/**
 * Fetches a session's full snapshot (queue, history, nowPlaying, playback
 * clock, members). Caller must be an active member.
 * @param {string|number} id
 * @returns {Promise<object>} Session snapshot.
 */
export async function getCastSession(id) {
  const res = await apiClient.get(`/api/v1/cast/${id}`)
  return res.data
}

/**
 * Fetches the same session snapshot, for the chrome-less TV display view.
 * @param {string|number} id
 * @returns {Promise<object>} Session snapshot.
 */
export async function getCastDisplay(id) {
  const res = await apiClient.get(`/api/v1/cast/${id}/display`)
  return res.data
}

/**
 * Adds a video to the end of a session's queue.
 * @param {string|number} id
 * @param {string} videoId
 * @returns {Promise<object>} Updated session snapshot.
 */
export async function addCastQueueItem(id, videoId) {
  const res = await apiClient.post(`/api/v1/cast/${id}/queue`, { videoId })
  return res.data
}

/**
 * Removes an item from a session's queue.
 * @param {string|number} id
 * @param {string|number} itemId
 * @returns {Promise<void>}
 */
export async function removeCastQueueItem(id, itemId) {
  await apiClient.delete(`/api/v1/cast/${id}/queue/${itemId}`)
}

/**
 * Moves a queued item to a new position among the other queued items.
 * @param {string|number} id
 * @param {string|number} itemId
 * @param {number} toIndex
 * @returns {Promise<object>} Updated session snapshot.
 */
export async function moveCastQueueItem(id, itemId, toIndex) {
  const res = await apiClient.patch(`/api/v1/cast/${id}/queue/${itemId}/move`, { toIndex })
  return res.data
}

/**
 * Lists a session's active members.
 * @param {string|number} id
 * @returns {Promise<{items: object[]}>}
 */
export async function listCastMembers(id) {
  const res = await apiClient.get(`/api/v1/cast/${id}/members`)
  return res.data
}

/**
 * Removes a member from a session. Owner only.
 * @param {string|number} id
 * @param {string|number} userId
 * @returns {Promise<void>}
 */
export async function kickCastMember(id, userId) {
  await apiClient.delete(`/api/v1/cast/${id}/members/${userId}`)
}

/**
 * Ends a session. Owner or admin.
 * @param {string|number} id
 * @returns {Promise<void>}
 */
export async function endCastSession(id) {
  await apiClient.post(`/api/v1/cast/${id}/end`)
}

/**
 * Renames a session. Owner or admin.
 * @param {string|number} id
 * @param {string} title
 * @returns {Promise<object>} Updated session snapshot.
 */
export async function renameCastSession(id, title) {
  const res = await apiClient.patch(`/api/v1/cast/${id}`, { title })
  return res.data
}

/**
 * Leaves a session, dropping the caller's own membership. The session keeps
 * running for everyone else.
 * @param {string|number} id
 * @returns {Promise<void>}
 */
export async function leaveCastSession(id) {
  await apiClient.post(`/api/v1/cast/${id}/leave`)
}

/**
 * Lists the instance's most-used reaction emoji, highest first. Site-wide, not
 * per-user, and padded with the seeded defaults so it's never short.
 * @param {number} [limit]
 * @returns {Promise<{items: string[]}>}
 */
export async function listReactionEmoji(limit) {
  const res = await apiClient.get('/api/v1/reaction-emoji', {
    params: limit ? { limit } : undefined,
  })
  return res.data
}
