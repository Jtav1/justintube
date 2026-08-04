import { emailEnabled, sendNotificationEmail } from "./email/mailer.js";
import { getNotificationTypeDefaults, isNotificationTypeInAppLocked } from "./seed.js";
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
 * type is missing/disabled. The in-app row itself is further gated on the
 * recipient's per-type `enabled` preference, except for types marked
 * `inAppLocked` in `DEFAULT_NOTIFICATION_TYPES` (moderation/account/admin),
 * which always get an in-app row regardless of that preference - only their
 * email copy can be opted out of. Never throws - failures are logged and
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

    const setting = await UserNotificationSetting.findOne({
      where: { userId: recipientUserId, notificationTypeId: type.id },
    });

    if (wantsInAppNotification(type.name, setting)) {
      await Notification.create({
        userId: recipientUserId,
        notificationTypeId: type.id,
        title,
        message,
        target,
      });
    }

    await maybeSendNotificationEmail({
      recipientUserId,
      setting,
      typeName: type.name,
      title,
      message,
      link,
    });
  } catch (err) {
    console.error(`createNotification (${typeName}) failed:`, err);
  }
}

/**
 * Returns whether an in-app Notification row should be created for this
 * recipient/type. Locked types (`inAppLocked` in `DEFAULT_NOTIFICATION_TYPES`
 * - moderation/account/admin) always return true, since their in-app
 * delivery isn't something the user can turn off. Every user is expected to
 * have an explicit USER_NOTIFICATION_SETTINGS row for every active type
 * (seeded at registration and reconciled on every boot by
 * `ensureUserNotificationSettings`), so a present row's `enabled` is read
 * directly; the type's seeded default (`getNotificationTypeDefaults`) is
 * only a fallback for the row somehow being missing.
 *
 * @private
 * @param {string} typeName NOTIFICATION_TYPES.name.
 * @param {import('sequelize').Model|null} setting The recipient's
 *   USER_NOTIFICATION_SETTINGS row for this type, if any.
 * @returns {boolean} True when the in-app notification should be created.
 */
function wantsInAppNotification(typeName, setting) {
  if (isNotificationTypeInAppLocked(typeName)) {
    return true;
  }
  return setting ? setting.enabled === true : getNotificationTypeDefaults(typeName).enabled;
}

/**
 * Emails a notification recipient, gated on the global SMTP switch and the
 * recipient's per-type email preference. Unlike in-app delivery, email is
 * never locked "on" - every type, including moderation/account/admin, can
 * still have its email copy opted out of independently.
 *
 * @private
 * @param {object} params
 * @param {number} params.recipientUserId Id of the user to email.
 * @param {import('sequelize').Model|null} params.setting The recipient's
 *   USER_NOTIFICATION_SETTINGS row for this type, if any (already fetched by
 *   `createNotification`, so this avoids a second query for the same row).
 * @param {string} params.typeName NOTIFICATION_TYPES.name, for the missing-row fallback default.
 * @param {string} params.title Notification title (used as the email subject).
 * @param {string} params.message Notification message body.
 * @param {string|null} params.link Optional URL to include in the email body.
 * @returns {Promise<void>} Resolves once email delivery has been attempted (or skipped).
 */
async function maybeSendNotificationEmail({
  recipientUserId,
  setting,
  typeName,
  title,
  message,
  link,
}) {
  if (!emailEnabled()) {
    return;
  }

  const wantsEmail = setting
    ? setting.emailEnabled === true
    : getNotificationTypeDefaults(typeName).emailEnabled;
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
