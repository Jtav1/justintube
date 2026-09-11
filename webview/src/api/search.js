import apiClient from './client.js'

/**
 * Fetches lightweight typeahead suggestions (video-only) for the search box.
 * @param {string} q
 * @param {{ limit?: number }} [options]
 * @returns {Promise<{items: Array<{id: number, title: string, uploader: object}>}>}
 */
export async function suggestSearch(q, { limit } = {}) {
  const res = await apiClient.get('/api/v1/search/suggest', { params: { q, limit } })
  return res.data
}

/**
 * Runs the combined, fuzzy ("close match") search across public videos,
 * public playlists (including their contained videos), and non-locked users.
 * Powers the search-results page.
 * @param {string} q
 * @param {{ videoLimit?: number, playlistLimit?: number, userLimit?: number }} [options]
 * @returns {Promise<{videos: object[], playlists: object[], users: object[]}>}
 */
export async function searchAdvanced(q, { videoLimit, playlistLimit, userLimit } = {}) {
  const res = await apiClient.get('/api/v1/search/advanced', {
    params: { q, videoLimit, playlistLimit, userLimit },
  })
  return res.data
}
