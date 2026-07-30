import apiClient from './client.js'

/**
 * Searches/lists videos with pagination and sort.
 * @param {{ q?: string, tags?: string[]|string, sort?: string, page?: number, limit?: number }} params
 *   `tags` requires results to include all of them (comma-separated on the wire).
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function searchVideos({ q, tags, sort, page, limit } = {}) {
  const res = await apiClient.get('/api/v1/search', {
    params: {
      q,
      tags: Array.isArray(tags) ? tags.join(',') : tags,
      sort,
      page,
      limit,
    },
  })
  return res.data
}

/**
 * Fetches a single video's metadata and renditions.
 * @param {string|number} id Numeric video id or its public videoId.
 * @returns {Promise<object>}
 */
export async function getVideo(id) {
  const res = await apiClient.get(`/api/v1/videos/${id}`)
  return res.data
}

/**
 * Lists featured videos the current viewer may see (public, plus their own
 * and any they hold a VIDEO_ACCESS grant for), newest-featured first.
 * @returns {Promise<{items: object[]}>}
 */
export async function getFeaturedVideos() {
  const res = await apiClient.get('/api/v1/videos/featured')
  return res.data
}

/**
 * Lists videos the current viewer may see (public, plus their own and any
 * they hold a VIDEO_ACCESS grant for), newest first.
 * @returns {Promise<{items: object[]}>}
 */
export async function getNewestVideos() {
  const res = await apiClient.get('/api/v1/videos/newest')
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
 * Imports a video from a remote URL via the processing service, creating an
 * ORIGINAL_UPLOADS row the same way uploadVideoFile does.
 * @param {string} url
 * @returns {Promise<{id: number, originalFilename: string, status: string}>}
 */
export async function importVideoUrl(url) {
  const res = await apiClient.post('/api/v1/videos/import', { url })
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

/**
 * Lists every comment (and reply) on a video, oldest first. Note: unlike
 * `getVideo`, this keys on the video's numeric id, not its public `videoId`.
 * @param {number} id Numeric video id.
 * @returns {Promise<{items: object[]}>}
 */
export async function listComments(id) {
  const res = await apiClient.get(`/api/v1/videos/${id}/comments`)
  return res.data
}

/**
 * Posts a comment (or, with `parentCommentId`, a reply) on a video.
 * @param {number} id Numeric video id.
 * @param {{ body: string, parentCommentId?: number, distinguishedMod?: boolean, distinguishedAdmin?: boolean }} comment
 * @returns {Promise<object>}
 */
export async function createComment(id, { body, parentCommentId, distinguishedMod, distinguishedAdmin }) {
  const res = await apiClient.post(`/api/v1/videos/${id}/comments`, {
    body,
    parentCommentId,
    distinguishedMod,
    distinguishedAdmin,
  })
  return res.data
}
