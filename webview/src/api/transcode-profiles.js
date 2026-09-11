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
 * Reports whether the processing service currently has hardware-accelerated
 * transcoding enabled, and which encoders it accepts. Purely advisory - used
 * to shape the create/edit form, not to gate profile CRUD itself.
 * @returns {Promise<{available: boolean, enabled: boolean, encoders: string[]}>}
 */
export async function getTranscodeHardwareStatus() {
  const res = await apiClient.get('/api/v1/admin/transcode-profiles/hardware-status')
  return res.data
}

/**
 * Creates a transcode profile. Admin only.
 * @param {{
 *   description?: string|null, resolutionName: string, mediaType?: string,
 *   outputHeight: number, outputWidth: number,
 *   outputContainer: string, videoCodec: string, audioCodec: string,
 *   hardwareAccelerated?: boolean,
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
