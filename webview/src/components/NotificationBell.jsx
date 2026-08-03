import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, Settings } from 'lucide-react'
import {
  listNotifications,
  markNotificationsRead,
  getNotificationPreferences,
} from '../api/notifications.js'
import NotificationItem from './NotificationItem.jsx'
import './NotificationBell.css'

const DROPDOWN_LIMIT = 10

/**
 * Bell icon + dropdown showing the user's most recent notifications
 * (filtered to types they haven't disabled), with links to the full
 * notifications page and notification settings.
 */
function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const menuRef = useRef(null)
  const loadRef = useRef(null)

  useEffect(() => {
    async function load() {
      setLoading(true)
      try {
        const [prefs, page] = await Promise.all([
          getNotificationPreferences(),
          listNotifications({ page: 1, limit: DROPDOWN_LIMIT }),
        ])
        const disabledTypes = new Set(
          prefs.preferences.filter((p) => !p.enabled).map((p) => p.notificationType),
        )
        setItems(page.items.filter((item) => !disabledTypes.has(item.notificationType)))
      } catch {
        // Leave the previous items in place on a failed refresh.
      } finally {
        setLoading(false)
      }
    }

    loadRef.current = load
    load()
  }, [])

  useEffect(() => {
    if (!open) {
      return undefined
    }

    function handleClickOutside(event) {
      if (menuRef.current && !menuRef.current.contains(event.target)) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  function handleToggle() {
    setOpen((prev) => {
      const next = !prev
      if (next) {
        loadRef.current?.()
      }
      return next
    })
  }

  function handleRead(id) {
    setItems((prev) =>
      prev.map((item) => (item.id === id ? { ...item, readAt: new Date().toISOString() } : item)),
    )
    markNotificationsRead([id]).catch(() => {})
  }

  const hasUnread = items.some((item) => item.readAt == null)

  return (
    <div className="notification-bell" ref={menuRef}>
      <button
        type="button"
        className="notification-bell-toggle"
        onClick={handleToggle}
        aria-label="Notifications"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <Bell size={20} />
        {hasUnread && <span className="notification-bell-badge" aria-hidden="true" />}
      </button>
      {open && (
        <div className="notification-bell-menu" role="menu">
          <div className="notification-bell-list">
            {!loading && items.length === 0 && (
              <p className="notification-bell-empty">No notifications</p>
            )}
            {items.map((item) => (
              <NotificationItem
                key={item.id}
                notification={item}
                onRead={handleRead}
                onNavigate={() => setOpen(false)}
              />
            ))}
          </div>
          <div className="notification-bell-footer">
            <Link to="/notifications" className="notification-bell-view-all" onClick={() => setOpen(false)}>
              View all
            </Link>
            <Link
              to="/settings#notification-settings"
              className="notification-bell-settings"
              aria-label="Notification settings"
              onClick={() => setOpen(false)}
            >
              <Settings size={16} />
            </Link>
          </div>
        </div>
      )}
    </div>
  )
}

export default NotificationBell
