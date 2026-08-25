import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Settings } from 'lucide-react'
import {
  listNotifications,
  markNotificationsRead,
  markAllNotificationsRead,
  deleteNotification,
  getNotificationPreferences,
} from '../api/notifications.js'
import { useToast } from '../context/useToast.js'
import NotificationItem from '../components/NotificationItem.jsx'
import './NotificationsPage.css'

const PAGE_LIMIT = 20

function NotificationsPage() {
  const { error: toastError } = useToast()
  const [items, setItems] = useState([])
  const [page, setPage] = useState(1)
  const [totalPages, setTotalPages] = useState(0)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
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
          toastError('Failed to load notifications.')
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
  }, [page, toastError])

  function handleRead(id) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item)),
    )
    markNotificationsRead([id]).catch(() => toastError('Failed to mark notification as read.'))
  }

  async function handleDelete(id) {
    try {
      await deleteNotification(id)
      setItems((prev) => prev.filter((item) => item.id !== id))
    } catch {
      toastError('Failed to delete notification.')
    }
  }

  async function handleMarkAllRead() {
    const now = new Date().toISOString()
    setItems((prev) => prev.map((item) => (item.readAt == null ? { ...item, readAt: now } : item)))
    try {
      await markAllNotificationsRead()
    } catch {
      toastError('Failed to mark all notifications as read.')
    }
  }

  const hasUnread = items.some((item) => item.readAt == null)

  return (
    <section className="notifications-page">
      <div className="notifications-page-header">
        <h1>Notifications</h1>
        <div className="notifications-page-header-actions">
          {hasUnread && (
            <button type="button" className="notifications-page-mark-all" onClick={handleMarkAllRead}>
              Mark all read
            </button>
          )}
          <Link to="/settings#notification-settings" className="notifications-page-settings-link">
            <Settings size={16} />
            Notification settings
          </Link>
        </div>
      </div>

      {!loading && items.length === 0 && (
        <p className="notifications-page-empty">No notifications yet.</p>
      )}

      <div className="notifications-page-list">
        {items.map((item) => (
          <NotificationItem
            key={item.id}
            notification={item}
            onRead={handleRead}
            onDelete={handleDelete}
            titleOnly
          />
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
