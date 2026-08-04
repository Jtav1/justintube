import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
const DROPDOWN_WIDTH = 340
const VIEWPORT_MARGIN = 12

/**
 * Computes a fixed-position anchor for the dropdown from the toggle
 * button's current bounding rect, clamped so the dropdown always stays
 * fully within the viewport - flush against the button's right edge on
 * wide screens, but pulled in from the left edge on narrow/mobile ones
 * where the button sits well left of the screen's right edge (there are
 * more icons after it in the topbar).
 *
 * @param {DOMRect} rect Toggle button's `getBoundingClientRect()` result.
 * @returns {{ top: number, right: number, width: number }} Fixed-position styles.
 */
function computeDropdownPosition(rect) {
  const width = Math.min(DROPDOWN_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2)
  const idealRight = window.innerWidth - rect.right
  const maxRight = window.innerWidth - width - VIEWPORT_MARGIN
  return {
    top: rect.bottom + 6,
    right: Math.min(idealRight, maxRight),
    width,
  }
}

/**
 * Bell icon + dropdown showing the user's most recent notifications
 * (filtered to types they haven't disabled), with links to the full
 * notifications page and notification settings.
 */
function NotificationBell() {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [dropdownPosition, setDropdownPosition] = useState(null)
  const menuRef = useRef(null)
  const toggleRef = useRef(null)
  const dropdownRef = useRef(null)
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
      const clickedToggle = menuRef.current?.contains(event.target)
      const clickedDropdown = dropdownRef.current?.contains(event.target)
      if (!clickedToggle && !clickedDropdown) {
        setOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [open])

  useEffect(() => {
    if (!open) {
      return undefined
    }

    // The dropdown is portaled to <body> with a fixed position computed from
    // the toggle button's rect, so it won't track the button on its own -
    // recompute on resize (e.g. rotating a phone, or resizing the window)
    // so it stays fully within the viewport instead of drifting off-screen.
    function handleResize() {
      if (toggleRef.current) {
        setDropdownPosition(computeDropdownPosition(toggleRef.current.getBoundingClientRect()))
      }
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [open])

  function handleToggle() {
    if (open) {
      setOpen(false)
      return
    }
    loadRef.current?.()
    if (toggleRef.current) {
      setDropdownPosition(computeDropdownPosition(toggleRef.current.getBoundingClientRect()))
    }
    setOpen(true)
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
        ref={toggleRef}
      >
        <Bell size={20} />
        {hasUnread && <span className="notification-bell-badge" aria-hidden="true" />}
      </button>
      {open && dropdownPosition && createPortal(
        <div
          className="notification-bell-menu"
          role="menu"
          ref={dropdownRef}
          style={{
            position: 'fixed',
            top: dropdownPosition.top,
            right: dropdownPosition.right,
            width: dropdownPosition.width,
          }}
        >
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
        </div>,
        document.body,
      )}
    </div>
  )
}

export default NotificationBell
