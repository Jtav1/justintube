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
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function getFeaturedVideos({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/videos/featured', { params: { page, limit } })
  return res.data
}

/**
 * Lists videos the current viewer may see (public, plus their own and any
 * they hold a VIDEO_ACCESS grant for), newest first.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function getNewestVideos({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/videos/newest', { params: { page, limit } })
  return res.data
}

/**
 * Lists videos the current user has liked (that they can still view), newest
 * like first. Requires authentication.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function getMyLikes({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/me/likes', { params: { page, limit } })
  return res.data
}

/**
 * Lists videos the current user has watched, most-recently-viewed first.
 * Repeat views of the same video appear as separate entries (distinct
 * `historyId`s). Requires authentication.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function getMyHistory({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/me/history', { params: { page, limit } })
  return res.data
}

/**
 * Removes a single entry from the current user's watch history, by the
 * history entry's own id (not the video's id - the same video can have
 * multiple history entries from repeat views).
 * @param {number} historyId
 * @returns {Promise<void>}
 */
export async function removeHistoryEntry(historyId) {
  await apiClient.delete(`/api/v1/me/history/${historyId}`)
}

/**
 * Clears the current user's entire watch history.
 * @returns {Promise<void>}
 */
export async function clearMyHistory() {
  await apiClient.delete('/api/v1/me/history')
}

/**
 * Uploads a video file, creating an ORIGINAL_UPLOADS row (private by
 * default, with a default title derived from the filename). Callers should
 * follow up with updateVideo to set the real title/description/visibility/tags.
 * @param {File} file
 * @param {{ skipThumbnail?: boolean, onUploadProgress?: (event: ProgressEvent) => void }} [options]
 *   `skipThumbnail` skips the processing service's auto-generated thumbnail
 *   — pass this when the caller is about to upload a custom one via
 *   updateVideoThumbnail, so it can't be overwritten by a later-arriving
 *   auto-generated thumbnail. `onUploadProgress` is forwarded to axios for
 *   real byte-level upload progress (`event.loaded`/`event.total`).
 * @returns {Promise<{id: number, originalFilename: string, status: string}>}
 */
export async function uploadVideoFile(file, { skipThumbnail = false, onUploadProgress } = {}) {
  const formData = new FormData()
  formData.append('file', file)
  if (skipThumbnail) {
    formData.append('skipThumbnail', 'true')
  }
  const res = await apiClient.post('/api/v1/videos/upload', formData, { onUploadProgress })
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
 * Replaces the editor list for a video. Unlike viewers, editors are
 * meaningful (and settable) regardless of the video's visibility.
 * Usable by the video owner or a moderator/admin.
 * @param {number} id
 * @param {string[]} usernames
 * @returns {Promise<{items: Array<{userId: number, username: string, displayName: string|null, permission: string}>}>}
 */
export async function setVideoEditors(id, usernames) {
  const res = await apiClient.put(`/api/v1/videos/${id}/editors`, { usernames })
  return res.data
}

/**
 * Replaces the private-viewer list for a video. The video's visibility must
 * currently be "private". Usable by the video owner or a moderator/admin.
 * @param {number} id
 * @param {string[]} usernames
 * @returns {Promise<{items: Array<{userId: number, username: string, displayName: string|null, permission: string}>}>}
 */
export async function setVideoViewers(id, usernames) {
  const res = await apiClient.put(`/api/v1/videos/${id}/viewers`, { usernames })
  return res.data
}

/**
 * Lists the private-access grants for a video. Owner or admin only.
 * @param {number} id
 * @returns {Promise<{items: Array<{userId: number, username: string, displayName: string|null, permission: string}>}>}
 */
export async function getVideoAccess(id) {
  const res = await apiClient.get(`/api/v1/videos/${id}/access`)
  return res.data
}

/**
 * Sets or clears a video's featured status. Admin only.
 * @param {number} id
 * @param {boolean} featured
 * @returns {Promise<{featured: boolean}>}
 */
export async function setVideoFeatured(id, featured) {
  const res = await apiClient.put(`/api/v1/videos/${id}/featured`, { featured })
  return res.data
}

/**
 * Delists a video, setting its visibility to "unlisted". Moderator/admin only.
 * @param {number} id
 * @returns {Promise<object>}
 */
export async function delistVideo(id) {
  const res = await apiClient.post(`/api/v1/videos/${id}/delist`)
  return res.data
}

/**
 * Permanently deletes a video. Usable by the video owner or an admin.
 * @param {number} id
 * @returns {Promise<void>}
 */
export async function deleteVideo(id) {
  await apiClient.delete(`/api/v1/videos/${id}`)
}

/**
 * Imports a video from a remote URL via the processing service, creating an
 * ORIGINAL_UPLOADS row the same way uploadVideoFile does.
 * @param {string} url
 * @param {{ skipThumbnail?: boolean }} [options] `skipThumbnail` skips the
 *   processing service's auto-generated thumbnail — pass this when the
 *   caller is about to upload a custom one via updateVideoThumbnail, so it
 *   can't be overwritten by a later-arriving auto-generated thumbnail.
 * @returns {Promise<{id: number, originalFilename: string, status: string}>}
 */
export async function importVideoUrl(url, { skipThumbnail = false } = {}) {
  const res = await apiClient.post('/api/v1/videos/import', { url, skipThumbnail })
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
 * Polls an upload's download/transcode progress. Owner or admin only. Used
 * by the upload page to drive its progress bar after creation.
 * @param {number} id
 * @returns {Promise<{status: string, statusMessage: string|null, fileVersions: Array<{id: number, resolution: string|null, status: string}>}>}
 */
export async function getVideoProcessingStatus(id) {
  const res = await apiClient.get(`/api/v1/videos/${id}/processing-status`)
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
 * Likes a video, toggling the reaction off if already liked (replaces any
 * existing dislike).
 * @param {number} id Numeric video id.
 * @returns {Promise<{liked: boolean, disliked: boolean}>}
 */
export async function likeVideo(id) {
  const res = await apiClient.post(`/api/v1/videos/${id}/like`)
  return res.data
}

/**
 * Dislikes a video, toggling the reaction off if already disliked (replaces
 * any existing like).
 * @param {number} id Numeric video id.
 * @returns {Promise<{liked: boolean, disliked: boolean}>}
 */
export async function dislikeVideo(id) {
  const res = await apiClient.post(`/api/v1/videos/${id}/dislike`)
  return res.data
}

/**
 * Hides a video from the caller's own listings/feeds going forward.
 * Idempotent. Cannot be used on the caller's own uploaded video.
 * @param {number} id Numeric video id.
 * @returns {Promise<{hidden: boolean}>}
 */
export async function hideVideo(id) {
  const res = await apiClient.post(`/api/v1/videos/${id}/hide`)
  return res.data
}

/**
 * Unhides a previously-hidden video. Idempotent.
 * @param {number} id Numeric video id.
 * @returns {Promise<{hidden: boolean}>}
 */
export async function unhideVideo(id) {
  const res = await apiClient.delete(`/api/v1/videos/${id}/hide`)
  return res.data
}

/**
 * Records a view: increments the video's view count (all viewers), and, when
 * the caller is authenticated, adds a row to their watch history.
 * @param {number} id Numeric video id.
 * @returns {Promise<{viewCount: number}>}
 */
export async function recordView(id) {
  const res = await apiClient.post(`/api/v1/videos/${id}/view`)
  return res.data
}

/**
 * Lists public videos from channels the current user is subscribed to,
 * excluding already-watched videos, newest first. Requires authentication.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function getSubscriptionFeed({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/feed/subscriptions', { params: { page, limit } })
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
