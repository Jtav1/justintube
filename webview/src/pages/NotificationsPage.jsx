import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Settings } from 'lucide-react'
import {
  listNotifications,
  markNotificationsRead,
  getNotificationPreferences,
} from '../api/notifications.js'
import NotificationItem from '../components/NotificationItem.jsx'
import './NotificationsPage.css'

const PAGE_LIMIT = 20

function NotificationsPage() {
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError(null)
      try {
        const [prefs, data] = await Promise.all([
          getNotificationPreferences(),
          listNotifications({ page, limit: PAGE_LIMIT }),
        ])
        if (cancelled) {
          return
        }
        const disabledTypes = new Set(
          prefs.preferences.filter((p) => !p.enabled).map((p) => p.notificationType),
        )
        setItems(data.items.filter((item) => !disabledTypes.has(item.notificationType)))
        setTotalPages(data.totalPages)
      } catch {
        if (!cancelled) {
          setError('Failed to load notifications.')
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    load()

    return () => {
      cancelled = true
    }
  }, [page])

  function handleRead(id) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item)),
    )
    markNotificationsRead([id]).catch(() => {})
  }

  return (
    <section className="notifications-page">
      <div className="notifications-page-header">
        <h1>Notifications</h1>
        <Link to="/settings#notification-settings" className="notifications-page-settings-link">
          <Settings size={16} />
          Notification settings
        </Link>
      </div>

      {error && <p className="notifications-page-error">{error}</p>}
      {!loading && items.length === 0 && !error && (
        <p className="notifications-page-empty">No notifications yet.</p>
      )}

      <div className="notifications-page-list">
        {items.map((item) => (
          <NotificationItem key={item.id} notification={item} onRead={handleRead} titleOnly />
        ))}
      </div>

      {totalPages > 1 && (
        <div className="notifications-page-nav">
          <button
            type="button"
            disabled={page <= 1 || loading}
            onClick={() => setPage((prev) => prev - 1)}
          >
            Previous
          </button>
          <span className="notifications-page-nav-label">
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((prev) => prev + 1)}
          >
            Next
          </button>
        </div>
      )}
    </section>
  )
}

export default NotificationsPage
