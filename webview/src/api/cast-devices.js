import apiClient from './client.js'

/**
 * Lists Chromecasts the API server can see on its network. Discovery runs
 * server-side, so this works in every browser - including Firefox, which has
 * no casting API of its own.
 * @returns {Promise<{items: object[]}>}
 */
export async function listCastDevices() {
  const res = await apiClient.get('/api/v1/cast-devices')
  return res.data
}

/**
 * Starts playing a video on a device. The device fetches the media itself, so
 * it must be able to reach the API's PUBLIC_API_URL.
 * @param {string} deviceId
 * @param {string} videoId Public video id string.
 * @returns {Promise<object>}
 */
export async function playOnCastDevice(deviceId, videoId) {
  const res = await apiClient.post(
    `/api/v1/cast-devices/${encodeURIComponent(deviceId)}/play`,
    { videoId },
  )
  return res.data
}

/**
 * Sends a transport command to whatever is playing on a device.
 * @param {string} deviceId
 * @param {'play'|'pause'|'stop'} command
 * @returns {Promise<object>}
 */
export async function controlCastDevice(deviceId, command) {
  const res = await apiClient.post(
    `/api/v1/cast-devices/${encodeURIComponent(deviceId)}/control`,
    { command },
  )
  return res.data
}
