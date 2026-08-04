import apiClient from './client.js'

/**
 * Fetches the current session's notifications, newest first, paginated.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function listNotifications({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/notifications', { params: { page, limit } })
  return res.data
}

/**
 * Marks the given notification IDs (owned by the current session) as read.
 * @param {number[]} notificationIds
 * @returns {Promise<{success: boolean}>}
 */
export async function markNotificationsRead(notificationIds) {
  const res = await apiClient.post('/api/v1/notifications/read', { notificationIds })
  return res.data
}

/**
 * Fetches the current session's notification preferences: one entry per
 * active notification type, defaulting to `enabled: true` when the user has
 * no explicit setting for that type. `enabledLocked: true` marks types whose
 * in-app delivery can't be disabled (moderation, account, admin) - `enabled`
 * always reads true for those.
 * @returns {Promise<{preferences: {notificationType: string, description: string|null, enabled: boolean, emailEnabled: boolean, enabledLocked: boolean}[]}>}
 */
export async function getNotificationPreferences() {
  const res = await apiClient.get('/api/v1/me/notification-preferences')
  return res.data
}

/**
 * Updates one or more of the current session's notification preferences.
 * @param {{notificationType: string, enabled: boolean}[]} preferences
 * @returns {Promise<{preferences: {notificationType: string, enabled: boolean}[]}>}
 */
export async function updateNotificationPreferences(preferences) {
  const res = await apiClient.patch('/api/v1/me/notification-preferences', { preferences })
  return res.data
}
