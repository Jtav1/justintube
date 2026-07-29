import apiClient from './client.js'

/**
 * Searches/lists videos with pagination and sort.
 * @param {{ q?: string, sort?: string, page?: number, limit?: number }} params
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function searchVideos({ q, sort, page, limit } = {}) {
  const res = await apiClient.get('/api/v1/search', {
    params: { q, sort, page, limit },
  })
  return res.data
}

/**
 * Uploads a video file, creating an ORIGINAL_UPLOADS row (private by
 * default, with a default title derived from the filename). Callers should
 * follow up with updateVideo to set the real title/description/visibility/tags.
 * @param {File} file
 * @returns {Promise<{id: number, originalFilename: string, status: string}>}
 */
export async function uploadVideoFile(file) {
  const formData = new FormData()
  formData.append('file', file)
  const res = await apiClient.post('/api/v1/videos/upload', formData)
  return res.data
}

/**
 * Updates a video's metadata. Usable by the video owner or a moderator/admin.
 * @param {number} id
 * @param {{ title?: string, description?: string|null, visibility?: string, commentsEnabled?: boolean, tags?: string[] }} updates
 * @returns {Promise<object>}
 */
export async function updateVideo(id, updates) {
  const res = await apiClient.patch(`/api/v1/videos/${id}`, updates)
  return res.data
}

/**
 * Replaces the private-access grant list for a video. The video's visibility
 * must currently be "private". Usable by the video owner or a moderator/admin.
 * @param {number} id
 * @param {string[]} usernames
 * @returns {Promise<{items: Array<{userId: number, username: string, displayName: string|null}>}>}
 */
export async function setVideoAccess(id, usernames) {
  const res = await apiClient.put(`/api/v1/videos/${id}/access`, { usernames })
  return res.data
}

/**
 * Checks whether URL import is currently available (i.e. the processing
 * service is reachable and healthy).
 * @returns {Promise<{available: boolean}>}
 */
export async function getImportStatus() {
  const res = await apiClient.get('/api/v1/videos/import/status')
  return res.data
}

/**
 * Uploads (or replaces) a video's thumbnail image. Usable by the video
 * owner or a moderator/admin.
 * @param {number} id
 * @param {File} file
 * @returns {Promise<{thumbnailUrl: string}>}
 */
export async function updateVideoThumbnail(id, file) {
  const formData = new FormData()
  formData.append('file', file)
  const res = await apiClient.post(`/api/v1/videos/${id}/thumbnail`, formData)
  return res.data
}
