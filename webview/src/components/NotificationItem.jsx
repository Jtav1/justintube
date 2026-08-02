import { useEffect } from 'react'
import { formatRelativeDate } from '../lib/format.js'
import './NotificationItem.css'

/**
 * A single notification row. Reports itself as read (via `onRead`) as soon
 * as it mounts - since the dropdown and the all-notifications page both
 * render their current page in full (no virtualization/infinite scroll),
 * mounting is an accurate proxy for "displayed on screen."
 * @param {{ notification: object, onRead: (id: number) => void }} props
 */
function NotificationItem({ notification, onRead }) {
  const { id, title, message, readAt, createdAt } = notification
  const isUnread = readAt == null

  useEffect(() => {
    if (isUnread) {
      onRead(id)
    }
    // Only ever fire once per mounted notification id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  return (
    <div className={`notification-item${isUnread ? ' notification-item-unread' : ''}`}>
      <span
        className={`notification-item-dot${isUnread ? ' notification-item-dot-unread' : ''}`}
        aria-hidden="true"
      />
      <div className="notification-item-body">
        <p className="notification-item-title">{title}</p>
        <p className="notification-item-message">{message}</p>
        <p className="notification-item-time">{formatRelativeDate(createdAt)}</p>
      </div>
    </div>
  )
}

export default NotificationItem
