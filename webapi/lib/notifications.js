import { emailEnabled, sendNotificationEmail } from "./email/mailer.js";
import { Notification, NotificationType, User, UserNotificationSetting } from "./models/index.js";

/**
 * Creates an in-app notification for a user, and best-effort emails them
 * too when their preferences call for it. The single delivery primitive
 * every notification-triggering event (likes, comments, subscriptions,
 * moderation actions, admin broadcasts, ...) should call rather than
 * hand-rolling its own `Notification.create` + email logic.
 *
 * A no-op when `recipientUserId` is falsy, `actorUserId` is given and
 * equals `recipientUserId` (no self-notifications), or the notification
 * type is missing/disabled. Never throws - failures are logged and
 * swallowed so the triggering request never fails because of notification
 * delivery.
 *
 * @param {object} params
 * @param {number} params.recipientUserId Id of the user to notify.
 * @param {number} [params.actorUserId] Id of the user who caused this
 *   notification, if any. When given and equal to `recipientUserId`, the
 *   call is a no-op (skip self-notifications). Omit for actor-less
 *   notifications (system/admin/account events).
 * @param {string} params.typeName NOTIFICATION_TYPES.name (e.g. "like",
 *   "comment", "subscriber", "admin").
 * @param {string} params.title Notification title.
 * @param {string} params.message Notification message body.
 * @param {string|null} [params.target] Linkable data stored on the
 *   notification for the frontend to build a link from (e.g. a video's
 *   public `videoId`). Omit/null for notifications with nothing to link to.
 * @param {string|null} [params.link] Fully-built URL to include in the
 *   notification email, if this type supports email and has somewhere to
 *   link. Independent of `target` - callers that email a link generally
 *   build it from the same data as `target`, but the mapping from "target"
 *   to "URL" is type-specific and not this function's concern.
 * @param {boolean} [params.requireExplicitEmailOptIn] When true, only email
 *   if the recipient has an explicit `UserNotificationSetting` row with
 *   `emailEnabled: true` for this type - no row, or `emailEnabled: false`,
 *   both mean "don't email". When false (default), mirrors the sitewide
 *   preferences default (no row = email enabled), matching what
 *   `buildPreferencesPayload()` shows in the settings UI.
 * @returns {Promise<void>} Resolves once delivery has been attempted.
 */
export async function createNotification({
  recipientUserId,
  actorUserId,
  typeName,
  title,
  message,
  target = null,
  link = null,
  requireExplicitEmailOptIn = false,
}) {
  try {
    if (!recipientUserId) {
      return;
    }
    if (actorUserId != null && actorUserId === recipientUserId) {
      return;
    }

    const type = await NotificationType.findOne({ where: { name: typeName, enabled: true } });
    if (!type) {
      return;
    }

    await Notification.create({
      userId: recipientUserId,
      notificationTypeId: type.id,
      title,
      message,
      target,
    });

    await maybeSendNotificationEmail({
      recipientUserId,
      notificationTypeId: type.id,
      title,
      message,
      link,
      requireExplicitEmailOptIn,
    });
  } catch (err) {
    console.error(`createNotification (${typeName}) failed:`, err);
  }
}

/**
 * Emails a notification recipient, gated on the global SMTP switch and the
 * recipient's per-type email preference. See `createNotification`'s
 * `requireExplicitEmailOptIn` doc for the two gating modes.
 *
 * @private
 * @param {object} params
 * @param {number} params.recipientUserId Id of the user to email.
 * @param {number} params.notificationTypeId NOTIFICATION_TYPES id for this event.
 * @param {string} params.title Notification title (used as the email subject).
 * @param {string} params.message Notification message body.
 * @param {string|null} params.link Optional URL to include in the email body.
 * @param {boolean} params.requireExplicitEmailOptIn Gating mode, see `createNotification`.
 * @returns {Promise<void>} Resolves once email delivery has been attempted (or skipped).
 */
async function maybeSendNotificationEmail({
  recipientUserId,
  notificationTypeId,
  title,
  message,
  link,
  requireExplicitEmailOptIn,
}) {
  if (!emailEnabled()) {
    return;
  }

  const setting = await UserNotificationSetting.findOne({
    where: { userId: recipientUserId, notificationTypeId },
  });
  const wantsEmail = requireExplicitEmailOptIn
    ? setting?.emailEnabled === true
    : setting?.emailEnabled !== false;
  if (!wantsEmail) {
    return;
  }

  const recipient = await User.findByPk(recipientUserId, { attributes: ["email"] });
  if (!recipient?.email) {
    return;
  }

  try {
    await sendNotificationEmail({ to: recipient.email, title, message, link });
  } catch (err) {
    console.error("sendNotificationEmail failed:", err);
  }
}
