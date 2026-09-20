import apiClient from './client.js'

/**
 * Fetches public runtime feature flags.
 * @returns {Promise<{livestreamEnabled: boolean, transcodingEnabled: boolean, castEnabled: boolean, deviceCastEnabled: boolean}>}
 */
export async function getPublicConfig() {
  const res = await apiClient.get('/api/v1/config')
  return res.data
}
