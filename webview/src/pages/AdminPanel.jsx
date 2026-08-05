import { useState } from 'react'
import { useAuth } from '../context/useAuth.js'
import { useToast } from '../context/useToast.js'
import { adminBroadcastNotification } from '../api/admin.js'
import './AdminPanel.css'

function AdminPanel() {
  const { user, loading: authLoading } = useAuth()
  const { success, error: toastError } = useToast()

  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)

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
    </section>
  )
}

export default AdminPanel
