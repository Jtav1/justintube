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

const THEME_COLOR_KEYS = ['color1', 'color2', 'color3', 'color4', 'color5']
const THEME_IMAGE_FIELDS = ['headerBackground', 'sidebarBackground', 'viewBackground']

/**
 * Builds multipart form data for a theme create/update request. Text fields
 * are only appended when present in `fields` (so partial updates work);
 * image fields are only appended when given as a `File`.
 * @param {object} fields
 * @returns {FormData}
 */
function buildThemeFormData(fields) {
  const formData = new FormData()
  if (fields.name !== undefined) {
    formData.append('name', fields.name)
  }
  if (fields.description !== undefined) {
    formData.append('description', fields.description)
  }
  for (const key of THEME_COLOR_KEYS) {
    if (fields[key] !== undefined) {
      formData.append(key, fields[key])
    }
  }
  if (fields.system !== undefined) {
    formData.append('system', String(fields.system))
  }
  if (fields.isDefault !== undefined) {
    formData.append('isDefault', String(fields.isDefault))
  }
  for (const field of THEME_IMAGE_FIELDS) {
    if (fields[field] instanceof File) {
      formData.append(field, fields[field])
      continue
    }
    const removeField = `remove${field[0].toUpperCase()}${field.slice(1)}`
    if (fields[removeField]) {
      formData.append(removeField, 'true')
    }
  }
  return formData
}

/**
 * Creates a theme. `system`/`isDefault` are admin-only server-side; only
 * pass them when the caller is managing sitewide themes.
 * @param {{
 *   name: string, description?: string,
 *   color1: string, color2: string, color3: string, color4: string, color5: string,
 *   system?: boolean, isDefault?: boolean,
 *   headerBackground?: File, sidebarBackground?: File, viewBackground?: File,
 * }} fields
 * @returns {Promise<object>}
 */
export async function createTheme(fields) {
  const res = await apiClient.post('/api/v1/themes', buildThemeFormData(fields))
  return res.data
}

/**
 * Partially updates an existing theme. Only include the keys that changed.
 * To remove a previously-saved image without replacing it, set
 * `removeHeaderBackground`/`removeSidebarBackground`/`removeViewBackground`
 * to `true` (ignored for a slot that also has a new file in the same call).
 * @param {number} themeId
 * @param {object} fields Same shape as createTheme's `fields`, all optional,
 *   plus the `remove*Background` flags above.
 * @returns {Promise<object>}
 */
export async function updateTheme(themeId, fields) {
  const res = await apiClient.patch(`/api/v1/themes/${themeId}`, buildThemeFormData(fields))
  return res.data
}

/**
 * Deletes a theme and its background images.
 * @param {number} themeId
 * @returns {Promise<{success: boolean}>}
 */
export async function deleteTheme(themeId) {
  const res = await apiClient.delete(`/api/v1/themes/${themeId}`)
  return res.data
}
