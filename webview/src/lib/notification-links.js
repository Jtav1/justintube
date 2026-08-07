/**
 * Maps a notification's `notificationType` to a function building a link
 * from its `target`. Add an entry here whenever a new notification type
 * carries a `target` the UI should link to - types with no entry (or no
 * `target`) simply render without a link.
 * @type {Record<string, (target: string) => string>}
 */
const TARGET_LINK_BUILDERS = {
  like: (target) => `/video?v=${encodeURIComponent(target)}`,
  comment: (target) => `/video?v=${encodeURIComponent(target)}`,
  moderation: (target) => `/video?v=${encodeURIComponent(target)}`,
  subscription: (target) => `/video?v=${encodeURIComponent(target)}`,
  subscriber: () => `/subscribers`,
  report: (target) => `/reports/${encodeURIComponent(target)}`,
}

/**
 * Builds the link a notification should navigate to, if any.
 * @param {{ notificationType: string, target: string|null }} notification
 * @returns {string|null}
 */
export function buildNotificationLink({ notificationType, target }) {
  if (!target) {
    return null
  }
  const build = TARGET_LINK_BUILDERS[notificationType]
  return build ? build(target) : null
}
