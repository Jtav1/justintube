import apiClient from './client.js'

/**
 * Creates a new Watch Party, seeding its queue from a playlist (a filtered
 * copy), a single video, or nothing. The caller becomes the party's owner.
 * @param {{ sourceType: 'playlist'|'video'|'empty', playlistId?: number, videoId?: string }} body
 * @returns {Promise<object>} The new session snapshot, including its join code.
 */
export async function createWatchParty(body) {
  const res = await apiClient.post('/api/v1/cast', body)
  return res.data
}

/**
 * Joins (or rejoins) a Watch Party by its join code.
 * @param {string} code
 * @returns {Promise<object>} The joined session snapshot.
 */
export async function joinWatchParty(code) {
  const res = await apiClient.post('/api/v1/cast/join', { code })
  return res.data
}

/**
 * Fetches a Watch Party's full snapshot (queue, history, nowPlaying, playback
 * clock, members). Caller must be an active member.
 * @param {string|number} id
 * @returns {Promise<object>} Session snapshot.
 */
export async function getWatchParty(id) {
  const res = await apiClient.get(`/api/v1/cast/${id}`)
  return res.data
}

/**
 * Fetches the same session snapshot, for the chrome-less TV display view.
 * @param {string|number} id
 * @returns {Promise<object>} Session snapshot.
 */
export async function getWatchPartyDisplay(id) {
  const res = await apiClient.get(`/api/v1/cast/${id}/display`)
  return res.data
}

/**
 * Adds a video to the end of a Watch Party's queue.
 * @param {string|number} id
 * @param {string} videoId
 * @returns {Promise<object>} Updated session snapshot.
 */
export async function addWatchPartyQueueItem(id, videoId) {
  const res = await apiClient.post(`/api/v1/cast/${id}/queue`, { videoId })
  return res.data
}

/**
 * Removes an item from a Watch Party's queue.
 * @param {string|number} id
 * @param {string|number} itemId
 * @returns {Promise<void>}
 */
export async function removeWatchPartyQueueItem(id, itemId) {
  await apiClient.delete(`/api/v1/cast/${id}/queue/${itemId}`)
}

/**
 * Moves a queued item to a new position among the other queued items.
 * @param {string|number} id
 * @param {string|number} itemId
 * @param {number} toIndex
 * @returns {Promise<object>} Updated session snapshot.
 */
export async function moveWatchPartyQueueItem(id, itemId, toIndex) {
  const res = await apiClient.patch(`/api/v1/cast/${id}/queue/${itemId}/move`, { toIndex })
  return res.data
}

/**
 * Lists a Watch Party's active members.
 * @param {string|number} id
 * @returns {Promise<{items: object[]}>}
 */
export async function listWatchPartyMembers(id) {
  const res = await apiClient.get(`/api/v1/cast/${id}/members`)
  return res.data
}

/**
 * Removes a member from a Watch Party. Owner only.
 * @param {string|number} id
 * @param {string|number} userId
 * @returns {Promise<void>}
 */
export async function kickWatchPartyMember(id, userId) {
  await apiClient.delete(`/api/v1/cast/${id}/members/${userId}`)
}

/**
 * Ends a Watch Party. Owner or admin.
 * @param {string|number} id
 * @returns {Promise<void>}
 */
export async function endWatchParty(id) {
  await apiClient.post(`/api/v1/cast/${id}/end`)
}

/**
 * Renames a Watch Party. Owner or admin.
 * @param {string|number} id
 * @param {string} title
 * @returns {Promise<object>} Updated session snapshot.
 */
export async function renameWatchParty(id, title) {
  const res = await apiClient.patch(`/api/v1/cast/${id}`, { title })
  return res.data
}

/**
 * Leaves a Watch Party, dropping the caller's own membership. The party keeps
 * running for everyone else.
 * @param {string|number} id
 * @returns {Promise<void>}
 */
export async function leaveWatchParty(id) {
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
