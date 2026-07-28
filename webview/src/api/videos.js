import apiClient from './client.js'

/**
 * Searches/lists videos with pagination and sort.
 * @param {{ q?: string, sort?: string, page?: number, limit?: number }} params
 * @returns {Promise<{items: object[], page: number, limit: number, totalHits: number, totalPages: number}>}
 */
export async function searchVideos({ q, sort, page, limit } = {}) {
  const res = await apiClient.get('/api/v1/search', {
    params: { q, sort, page, limit },
  })
  return res.data
}
