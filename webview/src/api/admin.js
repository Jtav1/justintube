import apiClient from './client.js'

/**
 * Sends a sitewide notification to every user (including the sending admin).
 * @param {string} title
 * @param {string} message
 * @returns {Promise<{success: boolean, notifiedCount: number}>}
 */
export async function adminBroadcastNotification(title, message) {
  const res = await apiClient.post('/api/v1/admin/notifications/broadcast', { title, message })
  return res.data
}

/**
 * Sends a moderation notification to a specific set of users.
 * @param {string} title
 * @param {string} message
 * @param {number[]} userIds
 * @returns {Promise<{success: boolean, notifiedCount: number}>}
 */
export async function adminModerationNotification(title, message, userIds) {
  const res = await apiClient.post('/api/v1/admin/notifications/moderation', {
    title,
    message,
    userIds,
  })
  return res.data
}

/**
 * Lists every active CAST session across all users (admin only).
 * @param {{limit?: number, offset?: number}} [params]
 * @returns {Promise<{items: object[], total: number, limit: number, offset: number}>}
 */
export async function adminListCastSessions(params = {}) {
  const res = await apiClient.get('/api/v1/admin/cast/sessions', { params })
  return res.data
}

/**
 * Ends any CAST session administratively, disconnecting every participant.
 * @param {number} id CAST session id.
 * @returns {Promise<void>}
 */
export async function adminEndCastSession(id) {
  await apiClient.post(`/api/v1/admin/cast/sessions/${id}/end`)
}
