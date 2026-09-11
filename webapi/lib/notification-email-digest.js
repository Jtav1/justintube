import { buildPublicLink, emailEnabled, sendNotificationDigestEmail } from "./email/mailer.js";
import { Notification, User } from "./models/index.js";
import { logger } from "./logger.js";

/**
 * Default cron expression: once an hour, on the hour.
 *
 * @type {string}
 */
const DEFAULT_CRON = "0 * * * *";

/**
 * Maximum number of notifications listed in a single digest email. A
 * recipient with more than this many outstanding notifications gets the
 * oldest `MAX_NOTIFICATIONS_PER_EMAIL` now; the rest stay `emailStatus:
 * "pending"` and go out in a future run.
 *
 * @type {number}
 */
const MAX_NOTIFICATIONS_PER_EMAIL = 20;

/**
 * Reads periodic notification-email-digest configuration from the environment.
 *
 * @returns {{ cron: string, enabled: boolean }} Scheduler settings.
 */
export function getNotificationEmailDigestConfig() {
  const cron = (process.env.NOTIFICATION_EMAIL_DIGEST_CRON || DEFAULT_CRON).trim();
  const disabled = ["0", "false", "off", "no"].includes(
    String(process.env.NOTIFICATION_EMAIL_DIGEST_ENABLED || "true")
      .trim()
      .toLowerCase(),
  );
  return { cron, enabled: !disabled };
}

/**
 * Emails one recipient a digest of their outstanding batched notifications
 * (see `BATCHED_EMAIL_NOTIFICATION_TYPES` in `lib/notifications.js`), capped
 * at `MAX_NOTIFICATIONS_PER_EMAIL`, with a link to the notifications page.
 * Rows beyond the cap are left `emailStatus: "pending"` for a future run.
 * A recipient with no email on file can never receive this, so their rows
 * are marked `"sent"` anyway rather than retried by every future run.
 *
 * @private
 * @param {number} userId USERS id to email.
 * @param {import('sequelize').Model[]} rows This user's `emailStatus:
 *   "pending"` NOTIFICATIONS rows, oldest first.
 * @returns {Promise<void>} Resolves once this recipient's digest has been
 *   sent (or their rows resolved as undeliverable).
 */
async function sendDigestForUser(userId, rows) {
  const user = await User.findByPk(userId, { attributes: ["id", "email"] });
  if (!user?.email) {
    await Notification.update(
      { emailStatus: "sent" },
      { where: { id: rows.map((row) => row.id) } },
    );
    return;
  }

  const included = rows.slice(0, MAX_NOTIFICATIONS_PER_EMAIL);
  await sendNotificationDigestEmail({
    to: user.email,
    notifications: included.map((row) => ({ title: row.title, message: row.message })),
    totalCount: rows.length,
    link: buildPublicLink("/notifications"),
  });

  await Notification.update(
    { emailStatus: "sent" },
    { where: { id: included.map((row) => row.id) } },
  );
}

/**
 * Runs one digest pass: every NOTIFICATIONS row still `emailStatus:
 * "pending"` (queued by `createNotification` for a batched-email type) is
 * grouped by recipient and emailed as a single digest, capped at
 * `MAX_NOTIFICATIONS_PER_EMAIL` per recipient per run. A no-op when SMTP
 * isn't configured. Per-recipient failures are logged and isolated - one
 * bad send doesn't block the rest of the run (matches `search-reindex.js`/
 * `hash-reconcile.js`'s per-item error isolation).
 *
 * @returns {Promise<void>} Resolves once every recipient with pending
 *   notifications has been attempted.
 */
export async function runNotificationEmailDigest() {
  if (!emailEnabled()) {
    logger.info("[notification-email-digest] email is not configured; nothing to do.");
    return;
  }

  const pending = await Notification.findAll({
    where: { emailStatus: "pending", deleted: false },
    order: [["createdAt", "ASC"]],
  });
  if (pending.length === 0) {
    logger.info("[notification-email-digest] no pending notifications to email.");
    return;
  }

  const rowsByUserId = new Map();
  for (const row of pending) {
    if (!rowsByUserId.has(row.userId)) {
      rowsByUserId.set(row.userId, []);
    }
    rowsByUserId.get(row.userId).push(row);
  }

  logger.info(
    `[notification-email-digest] emailing ${rowsByUserId.size} recipient(s) (${pending.length} pending notification(s))...`,
  );
  for (const [userId, rows] of rowsByUserId) {
    try {
      await sendDigestForUser(userId, rows);
    } catch (err) {
      logger.error({ err }, `[notification-email-digest] failed to email user ${userId}`);
    }
  }
}

/**
 * Starts the node-cron scheduler for the periodic notification-email digest.
 *
 * @returns {Promise<import('node-cron').ScheduledTask | null>} Started task, or
 *   null when disabled or the cron expression is invalid.
 */
export async function startNotificationEmailDigestCron() {
  const config = getNotificationEmailDigestConfig();
  if (!config.enabled) {
    logger.info("[notification-email-digest] disabled via NOTIFICATION_EMAIL_DIGEST_ENABLED");
    return null;
  }

  const cron = await import("node-cron");
  if (!cron.validate(config.cron)) {
    logger.error(`[notification-email-digest] invalid NOTIFICATION_EMAIL_DIGEST_CRON: ${config.cron}`);
    return null;
  }

  const task = cron.schedule(config.cron, () => {
    void runNotificationEmailDigest().catch((err) => {
      logger.error({ err }, "[notification-email-digest] run failed");
    });
  });

  logger.info(`[notification-email-digest] scheduled (${config.cron})`);
  return task;
}
