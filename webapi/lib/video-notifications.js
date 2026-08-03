import { emailEnabled, sendNotificationEmail } from "./email/mailer.js";
import { Notification, NotificationType, UserNotificationSetting } from "./models/index.js";

/**
 * Creates an in-app notification for a video's owner in response to a like
 * or comment, and best-effort emails them too when they've opted in. A
 * no-op when the video has no owner, the actor is the owner (no
 * self-notifications), or the notification type is missing/disabled.
 * Never throws - failures are logged and swallowed so a like/comment
 * request never fails because of notification delivery.
 *
 * @param {object} params
 * @param {import('sequelize').Model} params.upload ORIGINAL_UPLOADS row
 *   (with its `User` association eager-loaded) that was liked/commented on.
 * @param {number} params.actorUserId Id of the user who liked/commented.
 * @param {string} params.typeName NOTIFICATION_TYPES.name ("like" or "comment").
 * @param {string} params.title Notification title.
 * @param {string} params.message Notification message body.
 * @returns {Promise<void>} Resolves once notification delivery has been attempted.
 */
export async function notifyVideoInteraction({ upload, actorUserId, typeName, title, message }) {
  try {
    if (!upload.userId || upload.userId === actorUserId) {
      return;
    }

    const type = await NotificationType.findOne({ where: { name: typeName, enabled: true } });
    if (!type) {
      return;
    }

    await Notification.create({
      userId: upload.userId,
      notificationTypeId: type.id,
      title,
      message,
      target: upload.videoId,
    });

    await maybeSendInteractionEmail({
      upload,
      notificationTypeId: type.id,
      title,
      message,
    });
  } catch (err) {
    console.error("notifyVideoInteraction failed:", err);
  }
}

/**
 * Emails the video owner about a like/comment, but only when SMTP is
 * configured and the owner has an *explicit* `emailEnabled: true` row for
 * this notification type. Unlike `buildPreferencesPayload()` (which treats
 * "no row" as enabled-by-default for display purposes), a missing row here
 * means "don't email" - a deliberate, request-specific exception so a user
 * who has never touched their settings doesn't get emailed for likes/comments
 * until they explicitly opt in.
 *
 * @private
 * @param {object} params
 * @param {import('sequelize').Model} params.upload ORIGINAL_UPLOADS row with `User` eager-loaded.
 * @param {number} params.notificationTypeId NOTIFICATION_TYPES id for this event.
 * @param {string} params.title Notification title (used as the email subject).
 * @param {string} params.message Notification message body.
 * @returns {Promise<void>} Resolves once email delivery has been attempted (or skipped).
 */
async function maybeSendInteractionEmail({ upload, notificationTypeId, title, message }) {
  if (!emailEnabled()) {
    return;
  }

  const setting = await UserNotificationSetting.findOne({
    where: { userId: upload.userId, notificationTypeId },
  });
  if (setting?.emailEnabled !== true) {
    return;
  }

  const owner = upload.User;
  if (!owner?.email) {
    return;
  }

  try {
    await sendNotificationEmail({ to: owner.email, title, message, videoId: upload.videoId });
  } catch (err) {
    console.error("sendNotificationEmail failed:", err);
  }
}
