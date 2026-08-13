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
 * Fallback link for notifications with no `target` - the all-notifications
 * page, so every notification is clickable somewhere even when it has
 * nothing more specific to point at.
 * @type {string}
 */
const DEFAULT_LINK = '/notifications'

/**
 * Builds the link a notification should navigate to. Falls back to
 * `DEFAULT_LINK` when there's no `target` to build a more specific link
 * from; a `target` whose type has no matching builder still renders
 * without a link (e.g. because the type embeds its own links in `message`
 * instead, like "duplicate_upload").
 * @param {{ notificationType: string, target: string|null }} notification
 * @returns {string|null}
 */
export function buildNotificationLink({ notificationType, target }) {
  if (!target) {
    return DEFAULT_LINK
  }
  const build = TARGET_LINK_BUILDERS[notificationType]
  return build ? build(target) : null
}
