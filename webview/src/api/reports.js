import apiClient from './client.js'

/**
 * Creates a new report. Requires authentication.
 * @param {{ reportType: string, link?: string|null, description: string, videoId?: number|null,
 *   reportedUserId?: number|null, playlistId?: number|null }} report
 * @returns {Promise<object>}
 */
export async function createReport({ reportType, link, description, videoId, reportedUserId, playlistId }) {
  const res = await apiClient.post('/api/v1/reports', {
    reportType,
    link,
    description,
    videoId,
    reportedUserId,
    playlistId,
  })
  return res.data
}

/**
 * Lists reports filed by the current user, newest first, paginated.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, total: number}>}
 */
export async function listMyReports({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/reports/mine', { params: { page, limit } })
  return res.data
}

/**
 * Lists all reports site-wide, newest first, paginated. Moderator/admin only.
 * @param {{ page?: number, limit?: number, resolved?: boolean }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, total: number}>}
 */
export async function listReports({ page, limit, resolved } = {}) {
  const res = await apiClient.get('/api/v1/reports', { params: { page, limit, resolved } })
  return res.data
}

/**
 * Gets a single report by id. Moderator/admin only.
 * @param {number|string} id
 * @returns {Promise<object>}
 */
export async function getReport(id) {
  const res = await apiClient.get(`/api/v1/reports/${id}`)
  return res.data
}

/**
 * Updates a report's description and/or closes it. Only the report's
 * creator may call this; reopening (`resolved: false`) is not permitted.
 * @param {number|string} id
 * @param {{ description?: string, resolved?: true }} updates
 * @returns {Promise<object>}
 */
export async function updateReport(id, updates) {
  const res = await apiClient.patch(`/api/v1/reports/${id}`, updates)
  return res.data
}

/**
 * Updates a report's resolved state and/or moderator comment. Moderator/admin only.
 * @param {number|string} id
 * @param {{ resolved?: boolean, comment?: string }} updates
 * @returns {Promise<object>}
 */
export async function moderateReport(id, updates) {
  const res = await apiClient.patch(`/api/v1/reports/${id}/moderate`, updates)
  return res.data
}

/**
 * Deletes a report entirely. Admin only.
 * @param {number|string} id
 * @returns {Promise<{success: boolean}>}
 */
export async function deleteReport(id) {
  const res = await apiClient.delete(`/api/v1/reports/${id}`)
  return res.data
}
