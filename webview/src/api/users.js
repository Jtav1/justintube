import apiClient from './client.js'

/**
 * Fetches every non-locked user, alphabetically by username. `emailVerified`
 * and `uploader` are only present in each item for an admin caller.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function listUsers({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/users', { params: { page, limit } })
  return res.data
}

/**
 * Fetches a user's public channel profile plus a paginated, sortable page of
 * their videos.
 * @param {string} username
 * @param {{ page?: number, limit?: number, sort?: string }} [params]
 * @returns {Promise<{user: object, videos: {items: object[], page: number, limit: number, totalHits: number, totalPages: number}}>}
 */
export async function getUserChannel(username, { page, limit, sort } = {}) {
  const res = await apiClient.get(`/api/v1/users/${encodeURIComponent(username)}`, {
    params: { page, limit, sort },
  })
  return res.data
}

/**
 * Updates a user's display-facing profile fields (displayName/bio). Usable
 * by the profile owner or a moderator/admin.
 * @param {number} userId
 * @param {{ displayName?: string, bio?: string }} updates
 * @returns {Promise<{id: number, username: string, displayName: string|null, bio: string|null}>}
 */
export async function updateUserProfile(userId, updates) {
  const res = await apiClient.patch(`/api/v1/users/${userId}/profile`, updates)
  return res.data
}

/**
 * Uploads (or replaces) a user's banner image. Usable by the profile owner
 * or a moderator/admin.
 * @param {number} userId
 * @param {File} file
 * @returns {Promise<{bannerFilename: string}>}
 */
export async function updateUserBanner(userId, file) {
  const formData = new FormData()
  formData.append('file', file)
  const res = await apiClient.post(`/api/v1/users/${userId}/banner`, formData)
  return res.data
}

/**
 * Removes a user's banner image. Usable by the profile owner or a
 * moderator/admin.
 * @param {number} userId
 * @returns {Promise<{success: boolean}>}
 */
export async function deleteUserBanner(userId) {
  const res = await apiClient.delete(`/api/v1/users/${userId}/banner`)
  return res.data
}

/**
 * Uploads (or replaces) a user's avatar image. Usable by the profile owner
 * or a moderator/admin.
 * @param {number} userId
 * @param {File} file
 * @returns {Promise<{avatarFilename: string}>}
 */
export async function updateUserAvatar(userId, file) {
  const formData = new FormData()
  formData.append('file', file)
  const res = await apiClient.post(`/api/v1/users/${userId}/avatar`, formData)
  return res.data
}

/**
 * Removes a user's avatar image. Usable by the profile owner or a
 * moderator/admin.
 * @param {number} userId
 * @returns {Promise<{success: boolean}>}
 */
export async function deleteUserAvatar(userId) {
  const res = await apiClient.delete(`/api/v1/users/${userId}/avatar`)
  return res.data
}

/**
 * Resends the email verification message for an arbitrary user, on an
 * admin's behalf.
 * @param {number} userId
 * @returns {Promise<{success: boolean}>}
 */
export async function adminResendUserVerification(userId) {
  const res = await apiClient.post(`/api/v1/admin/users/${userId}/resend-verification`)
  return res.data
}

/**
 * Grants an arbitrary user uploader access, on an admin's behalf.
 * @param {number} userId
 * @returns {Promise<object>} The updated user record.
 */
export async function adminGrantUploader(userId) {
  const res = await apiClient.patch(`/api/v1/admin/users/${userId}`, { uploader: true })
  return res.data
}

/**
 * Updates an arbitrary user's role, on an admin's behalf.
 * @param {number} userId
 * @param {string} role One of USER_ROLES (see ../lib/roles.js).
 * @returns {Promise<object>} The updated user record.
 */
export async function adminUpdateUserRole(userId, role) {
  const res = await apiClient.patch(`/api/v1/admin/users/${userId}`, { role })
  return res.data
}

/**
 * Fetches whether the current user is subscribed to another user.
 * @param {number} userId
 * @returns {Promise<{subscribed: boolean}>}
 */
export async function getSubscriptionState(userId) {
  const res = await apiClient.get(`/api/v1/users/${userId}/subscription`)
  return res.data
}

/**
 * Subscribes the current user to another user.
 * @param {number} userId
 * @returns {Promise<{subscribed: boolean}>}
 */
export async function subscribeToUser(userId) {
  const res = await apiClient.post(`/api/v1/users/${userId}/subscribe`)
  return res.data
}

/**
 * Unsubscribes the current user from another user.
 * @param {number} userId
 * @returns {Promise<{subscribed: boolean}>}
 */
export async function unsubscribeFromUser(userId) {
  const res = await apiClient.delete(`/api/v1/users/${userId}/subscribe`)
  return res.data
}

/**
 * Fetches the users the current user is subscribed to, newest subscription
 * first.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function listMySubscriptions({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/me/subscriptions', { params: { page, limit } })
  return res.data
}

/**
 * Fetches the users subscribed to the current user, newest subscription
 * first.
 * @param {{ page?: number, limit?: number }} [params]
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function listMySubscribers({ page, limit } = {}) {
  const res = await apiClient.get('/api/v1/me/subscribers', { params: { page, limit } })
  return res.data
}

/**
 * Searches users by username/display-name prefix (used by recipient pickers,
 * e.g. sharing a private video with specific users).
 * @param {string} query
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{items: Array<{userId: number, username: string, displayName: string|null}>}>}
 */
export async function searchUsers(query, { limit } = {}) {
  const res = await apiClient.get('/api/v1/search/users', {
    params: { q: query, limit },
  })
  return res.data
}
