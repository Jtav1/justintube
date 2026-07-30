import apiClient from './client.js'

/**
 * Lists playlists the current viewer may see: public playlists (any owner),
 * the viewer's own playlists (any visibility), and private playlists the
 * viewer holds a PLAYLIST_ACCESS grant on. Unlisted/hidden playlists owned by
 * other users are not included (they remain reachable only by direct id).
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function listPlaylists({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/playlists', { params: { page, limit } })
  return res.data
}

/**
 * Lists playlists owned by the current user, newest first. Requires
 * authentication. Note the API-facing field is `title`, not `name`.
 * @param {{ limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function listMyPlaylists({ limit } = {}) {
  const res = await apiClient.get('/api/v1/me/playlists', { params: { limit } })
  return res.data
}

/**
 * Creates a new playlist owned by the current user. Requires authentication.
 * @param {{ name: string, description?: string|null, visibility?: string }} playlist
 * @returns {Promise<object>}
 */
export async function createPlaylist({ name, description, visibility }) {
  const res = await apiClient.post('/api/v1/playlists', { name, description, visibility })
  return res.data
}

/**
 * Gets a single playlist and every video item within it (newest-added-first),
 * filtered to what the current viewer may see.
 * @param {number|string} id
 * @returns {Promise<object>}
 */
export async function getPlaylist(id) {
  const res = await apiClient.get(`/api/v1/playlists/${id}`)
  return res.data
}

/**
 * Updates a playlist's metadata. Owner or admin only.
 * @param {number|string} id
 * @param {{ name?: string, description?: string|null, visibility?: string }} updates
 * @returns {Promise<object>}
 */
export async function updatePlaylist(id, { name, description, visibility }) {
  const res = await apiClient.patch(`/api/v1/playlists/${id}`, { name, description, visibility })
  return res.data
}

/**
 * Deletes a playlist. Owner or admin only. Cascades to the playlist's items
 * and access grants server-side.
 * @param {number|string} id
 * @returns {Promise<{success: boolean}>}
 */
export async function deletePlaylist(id) {
  const res = await apiClient.delete(`/api/v1/playlists/${id}`)
  return res.data
}

/**
 * Removes a video from a playlist. Owner or admin only. Idempotent.
 * @param {number|string} playlistId
 * @param {number} videoId Numeric OriginalUpload id (not the public videoId).
 * @returns {Promise<{itemCount: number}>}
 */
export async function removePlaylistItem(playlistId, videoId) {
  const res = await apiClient.delete(`/api/v1/playlists/${playlistId}/items/${videoId}`)
  return res.data
}

/**
 * Adds a video to a playlist. Usable by the playlist owner or a moderator/admin.
 * @param {number} playlistId
 * @param {number} videoId Numeric OriginalUpload id (not the public videoId).
 * @returns {Promise<{itemCount: number}>}
 */
export async function addVideoToPlaylist(playlistId, videoId) {
  const res = await apiClient.post(`/api/v1/playlists/${playlistId}/items`, { videoId })
  return res.data
}

/**
 * Lists a user's playlists visible to the current viewer: their public
 * playlists always, plus (when authenticated) private playlists the viewer
 * holds a PLAYLIST_ACCESS grant on, plus every visibility when viewing your
 * own playlists. Unlisted/hidden playlists of another user are not included.
 * @param {string} username
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function listUserPlaylists(username, { page, limit } = {}) {
  const res = await apiClient.get(`/api/v1/users/${username}/playlists`, { params: { page, limit } })
  return res.data
}
