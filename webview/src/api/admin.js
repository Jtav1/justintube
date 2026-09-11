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
 * Fetches every file associated with an upload (original, embed video,
 * thumbnail, transcoded variants), verified against the filesystem.
 * @param {string} identifier Upload pkid, internal uuid, or public videoId.
 * @returns {Promise<{upload: object, files: object}>}
 */
export async function getUploadFileTree(identifier) {
  const res = await apiClient.get(`/api/v1/admin/files/uploads/${encodeURIComponent(identifier)}`)
  return res.data
}

/**
 * Summarizes the live processing queue's currently non-terminal jobs,
 * bucketed by job kind and BullMQ state, alongside whether the processing
 * service itself is currently healthy/reachable.
 * @returns {Promise<{counts: object, total: number, healthy: boolean}>}
 */
export async function getAdminJobQueue() {
  const res = await apiClient.get('/api/v1/admin/jobs/queue')
  return res.data
}

/**
 * Lists the most recently completed/failed processing jobs, newest first,
 * paginated (5 per page by default). Each item carries `uploadId`
 * (ORIGINAL_UPLOADS numeric pkid) and `videoId` (its public id) when the job
 * could still be traced back to an upload — both `null` for a job whose
 * upload has since been deleted, or whose jobId shape isn't recognized.
 * @param {{page?: number, limit?: number}} [options]
 * @returns {Promise<{items: object[], total: number, page: number, limit: number}>}
 */
export async function getAdminJobHistory({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/admin/jobs/history', { params: { page, limit } })
  return res.data
}
