import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { useTheme } from '../context/useTheme.js'
import { adminBroadcastNotification } from '../api/admin.js'
import { deleteTheme } from '../api/themes.js'
import './AdminPanel.css'
import './AdminThemes.css'

function AdminPanel() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()
  const { themes, loading: themesLoading, refreshThemes } = useTheme()

  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

  const [deletingThemeId, setDeletingThemeId] = useState(null)

  if (authLoading) {
    return (
      <section className="settings-page">
        <p className="settings-status">Loading...</p>
      </section>
    )
  }

  if (!user || user.role !== 'admin') {
    return (
      <section className="settings-page">
        <p className="settings-status settings-status-error">
          You are not authorized to view this page.
        </p>
      </section>
    )
  }

  async function handleDeleteTheme(item) {
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

  async function handleSubmit(event) {
    event.preventDefault()
    if (sending) {
      return
    }
    if (!window.confirm('Send this notification to every user? This cannot be undone.')) {
      return
    }

    setSending(true)
    try {
      const result = await adminBroadcastNotification(title.trim(), message.trim())
      setTitle('')
      setMessage('')
      success(`Notification sent to ${result.notifiedCount} user(s).`)
    } catch (err) {
      const code = err.response?.data?.error
      toastError(code === 'invalid_body' ? err.response.data.message : 'Failed to send notification.')
    } finally {
      setSending(false)
    }
  }

  return (
    <section className="settings-page">
      <div className="settings-columns">
        <div className="settings-card">
          <h1>Admin Panel</h1>
          <h2>Broadcast a notification</h2>

          <form className="settings-form" onSubmit={handleSubmit}>
            <label htmlFor="admin-broadcast-title">Title</label>
            <input
              id="admin-broadcast-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={255}
              required
              disabled={sending}
            />

            <label htmlFor="admin-broadcast-message">Content</label>
            <textarea
              id="admin-broadcast-message"
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              maxLength={5000}
              rows={5}
              required
              disabled={sending}
            />

            <button type="submit" className="settings-submit" disabled={sending}>
              {sending ? 'Sending...' : 'Send to all users'}
            </button>
          </form>
        </div>

        <div className="settings-card">
          <h2>Manage Themes</h2>
          <Link to="/control-panel/themes/new" className="settings-submit admin-themes-create-link">
            Create Theme
          </Link>
          <div className="admin-themes-list">
            {themesLoading && <p className="settings-status">Loading themes...</p>}
            {!themesLoading && themes.map((item) => (
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
                {item.isDefault && <span className="admin-themes-badge">Default</span>}
                <div className="admin-themes-actions">
                  <Link to={`/control-panel/themes/${item.id}/edit`}>Edit</Link>
                  <button
                    type="button"
                    onClick={() => handleDeleteTheme(item)}
                    disabled={deletingThemeId === item.id}
                  >
                    {deletingThemeId === item.id ? 'Deleting...' : 'Delete'}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

export default AdminPanel
