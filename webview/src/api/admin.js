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
