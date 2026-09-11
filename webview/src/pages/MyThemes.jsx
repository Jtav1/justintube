import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { useTheme } from '../context/useTheme.js'
import { deleteTheme } from '../api/themes.js'
import './AdminThemes.css'

/**
 * Personal theme management: lists the signed-in user's own (private)
 * themes, with links to create/edit and a delete action. Site-wide themes
 * aren't shown here — this page is for the themes the viewer actually owns.
 * Routed at `/settings/themes`.
 */
function MyThemes() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()
  const { themes, loading: themesLoading, refreshThemes } = useTheme()
  const [deletingThemeId, setDeletingThemeId] = useState(null)

  if (authLoading) {
    return (
      <section className="settings-page">
        <p className="settings-status">Loading...</p>
      </section>
    )
  }

  if (!user) {
    return (
      <section className="settings-page">
        <p className="settings-status settings-status-error">
          You are not authorized to view this page.
        </p>
      </section>
    )
  }

  const myThemes = themes.filter((item) => item.themeOwner === String(user.id))

  async function handleDelete(item) {
    if (deletingThemeId) {
      return
    }
    if (!window.confirm(`Delete the theme "${item.name}"? This cannot be undone.`)) {
      return
    }
    setDeletingThemeId(item.id)
    try {
      await deleteTheme(item.id)
      await refreshThemes()
      success('Theme deleted.')
    } catch (err) {
      toastError(err.response?.data?.message || 'Failed to delete theme.')
    } finally {
      setDeletingThemeId(null)
    }
  }

  return (
    <section className="settings-page">
      <div className="settings-card">
        <h1>My Themes</h1>
        <p className="settings-status">
          Themes you create here are private — only you can see or select them.
        </p>
        <Link to="/settings/themes/new" className="settings-submit admin-themes-create-link">
          Create Theme
        </Link>
        <div className="admin-themes-list">
          {themesLoading && <p className="settings-status">Loading themes...</p>}
          {!themesLoading && myThemes.length === 0 && (
            <p className="settings-status">You haven&apos;t created any themes yet.</p>
          )}
          {!themesLoading && myThemes.map((item) => (
            <div className="admin-themes-row" key={item.id}>
              <div className="admin-themes-swatches">
                {['color2', 'color3', 'color4', 'color5'].map((key) => (
                  <span
                    key={key}
                    className="admin-themes-swatch"
                    style={{ backgroundColor: `#${item.colors[key]}` }}
                  />
                ))}
              </div>
              <span className="admin-themes-name">{item.name}</span>
              <div className="admin-themes-actions">
                <Link to={`/settings/themes/${item.id}/edit`}>Edit</Link>
                <button
                  type="button"
                  onClick={() => handleDelete(item)}
                  disabled={deletingThemeId === item.id}
                >
                  {deletingThemeId === item.id ? 'Deleting...' : 'Delete'}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

export default MyThemes
