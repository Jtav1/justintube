const LINK_PATTERN = /\[([^\]]+)\]\(([^)]+)\)/g

/**
 * Splits a notification message on `[label](/relative/path)` markdown-style
 * links into alternating text/link segments, so `NotificationItem` can
 * render the links as clickable `<Link>`s instead of literal text.
 * @param {string} message
 * @returns {Array<{type: 'text', value: string} | {type: 'link', label: string, href: string}>}
 */
export function parseNotificationMessage(message) {
  const segments = []
  let lastIndex = 0
  LINK_PATTERN.lastIndex = 0
  let match
  while ((match = LINK_PATTERN.exec(message)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: message.slice(lastIndex, match.index) })
    }
    segments.push({ type: 'link', label: match[1], href: match[2] })
    lastIndex = LINK_PATTERN.lastIndex
  }
  if (lastIndex < message.length) {
    segments.push({ type: 'text', value: message.slice(lastIndex) })
  }
  return segments
}
