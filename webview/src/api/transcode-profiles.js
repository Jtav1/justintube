import apiClient from './client.js'

/**
 * Lists all transcode profiles. Admin only.
 * @returns {Promise<{items: object[]}>}
 */
export async function getTranscodeProfiles() {
  const res = await apiClient.get('/api/v1/admin/transcode-profiles')
  return res.data
}

/**
 * Creates a transcode profile. Admin only.
 * @param {{
 *   description?: string|null, resolutionName: string, mediaType?: string,
 *   outputHeight: number, outputWidth: number,
 *   outputContainer: string, videoCodec: string, audioCodec: string,
 * }} fields
 * @returns {Promise<object>}
 */
export async function createTranscodeProfile(fields) {
  const res = await apiClient.post('/api/v1/admin/transcode-profiles', fields)
  return res.data
}

/**
 * Partially updates a transcode profile. Admin only. Only include changed keys.
 * @param {number} profileId
 * @param {object} fields Same shape as createTranscodeProfile's `fields`, all optional.
 * @returns {Promise<object>}
 */
export async function updateTranscodeProfile(profileId, fields) {
  const res = await apiClient.patch(`/api/v1/admin/transcode-profiles/${profileId}`, fields)
  return res.data
}

/**
 * Deletes a transcode profile. Admin only.
 * @param {number} profileId
 * @returns {Promise<{success: boolean}>}
 */
export async function deleteTranscodeProfile(profileId) {
  const res = await apiClient.delete(`/api/v1/admin/transcode-profiles/${profileId}`)
  return res.data
}
