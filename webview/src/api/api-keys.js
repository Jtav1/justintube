import apiClient from './client.js'

/**
 * Lists API keys owned by the current user (masked `keyDisplay` only, never
 * the plaintext key). Requires authentication.
 * @returns {Promise<{items: object[]}>}
 */
export async function listMyApiKeys() {
  const res = await apiClient.get('/api/v1/me/api-keys')
  return res.data
}

/**
 * Creates a new API key for the current user. The plaintext `key` is present
 * only in this response - it cannot be retrieved again afterward. Requires
 * uploader access and a verified email.
 * @param {{ name: string, scopes: string[], description?: string|null, expiresAt?: string }} fields
 * @returns {Promise<object>} Key metadata plus the one-time plaintext `key`.
 */
export async function createMyApiKey({ name, scopes, description, expiresAt }) {
  const res = await apiClient.post('/api/v1/me/api-keys', { name, scopes, description, expiresAt })
  return res.data
}

/**
 * Updates metadata (and/or replaces the scope grants) on an owned API key.
 * @param {number|string} id
 * @param {{ name?: string, scopes?: string[], description?: string|null, expiresAt?: string }} updates
 * @returns {Promise<object>}
 */
export async function updateMyApiKey(id, updates) {
  const res = await apiClient.patch(`/api/v1/me/api-keys/${id}`, updates)
  return res.data
}

/**
 * Soft-revokes an owned API key. Idempotent.
 * @param {number|string} id
 * @returns {Promise<{success: boolean}>}
 */
export async function revokeMyApiKey(id) {
  const res = await apiClient.delete(`/api/v1/me/api-keys/${id}`)
  return res.data
}
