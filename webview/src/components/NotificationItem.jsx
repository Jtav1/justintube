import { useEffect } from 'react'
import { Link } from 'react-router-dom'
import { formatRelativeDate } from '../lib/format.js'
import { buildNotificationLink } from '../lib/notification-links.js'
import { parseNotificationMessage } from '../lib/notification-message.js'
import './NotificationItem.css'

/**
 * Renders a notification message, turning any `[label](/path)`
 * markdown-style links it contains into clickable `<Link>`s. Plain-text
 * messages (the common case) are returned as-is.
 *
 * @param {string} message
 * @param {() => void} [onNavigate]
 * @returns {import('react').ReactNode}
 */
function renderMessage(message, onNavigate) {
  const segments = parseNotificationMessage(message)
  if (segments.length === 1 && segments[0].type === 'text') {
    return message
  }
  return segments.map((segment, index) =>
    segment.type === 'link' ? (
      <Link
        key={index}
        to={segment.href}
        className="notification-item-message-link"
        onClick={onNavigate}
      >
        {segment.label}
      </Link>
    ) : (
      <span key={index}>{segment.value}</span>
    ),
  )
}

/**
 * A single notification row. Reports itself as read (via `onRead`) as soon
 * as it mounts - since the dropdown and the all-notifications page both
 * render their current page in full (no virtualization/infinite scroll),
 * mounting is an accurate proxy for "displayed on screen."
 *
 * When the notification's type+target resolve to a link (see
 * `lib/notification-links.js`), it's clickable. By default the whole row is
 * the link (tray dropdown); pass `titleOnly` to link just the title instead
 * (all notifications page). Whenever the row itself isn't already a link,
 * the message is scanned for its own markdown-style links (see
 * `renderMessage` above) and those are rendered as `<Link>`s instead -
 * skipped when the row is a link so an `<a>` never ends up nested inside
 * another `<a>`.
 *
 * @param {{ notification: object, onRead: (id: number) => void,
 *   titleOnly?: boolean, onNavigate?: () => void }} props
 */
function NotificationItem({ notification, onRead, titleOnly = false, onNavigate }) {
  const { id, title, message, readAt, createdAt } = notification
  const isUnread = readAt == null
  const href = buildNotificationLink(notification)
  const isRowLink = Boolean(href) && !titleOnly

  useEffect(() => {
    if (isUnread) {
      onRead(id)
    }
    // Only ever fire once per mounted notification id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  const titleEl =
    href && titleOnly ? (
      <Link to={href} className="notification-item-title notification-item-title-link" onClick={onNavigate}>
        {title}
      </Link>
    ) : (
      <p className="notification-item-title">{title}</p>
    )

  const content = (
    <>
      <span
        className={`notification-item-dot${isUnread ? ' notification-item-dot-unread' : ''}`}
        aria-hidden="true"
      />
      <div className="notification-item-body">
        {titleEl}
        <p className="notification-item-message">
          {isRowLink ? message : renderMessage(message, onNavigate)}
        </p>
        <p className="notification-item-time">{formatRelativeDate(createdAt)}</p>
      </div>
    </>
  )

  const className = `notification-item${isUnread ? ' notification-item-unread' : ''}${
    isRowLink ? ' notification-item-clickable' : ''
  }`

  if (isRowLink) {
    return (
      <Link to={href} className={className} onClick={onNavigate}>
        {content}
      </Link>
    )
  }

  return <div className={className}>{content}</div>
}

export default NotificationItem
