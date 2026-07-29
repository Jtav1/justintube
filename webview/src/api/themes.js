import apiClient from './client.js'

/**
 * Lists available themes, plus the caller's selected theme id if authenticated.
 * @returns {Promise<{items: object[], selectedThemeId?: number|null}>}
 */
export async function getThemes() {
  const res = await apiClient.get('/api/v1/themes')
  return res.data
}

/**
 * Sets (or clears) the authenticated user's selected theme.
 * @param {number|null} themeId
 * @returns {Promise<{themeId: number|null, theme: object|null}>}
 */
export async function selectMyTheme(themeId) {
  const res = await apiClient.put('/api/v1/me/theme', { themeId })
  return res.data
}
