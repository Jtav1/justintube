import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { User } from "../lib/models/index.js";
import { createNotification } from "../lib/notifications.js";

/**
 * Maximum accepted length for a broadcast notification's title, matching
 * the `NOTIFICATIONS.title` column (`VARCHAR(255)`).
 *
 * @type {number}
 */
const MAX_TITLE_LENGTH = 255;

/**
 * Maximum accepted length for a broadcast notification's message, mirroring
 * the `bio` field cap used elsewhere in admin routes.
 *
 * @type {number}
 */
const MAX_MESSAGE_LENGTH = 5000;

/**
 * Validates a `POST /admin/notifications/broadcast` request body.
 *
 * @param {unknown} body Parsed request body.
 * @returns {{ok: true, title: string, message: string}|{ok: false, message: string}}
 *   Validated title/message, or a validation error.
 */
function parseBroadcastBody(body) {
  const title = String(body?.title ?? "").trim();
  if (!title) {
    return { ok: false, message: "title must be a non-empty string." };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { ok: false, message: `title must be at most ${MAX_TITLE_LENGTH} characters.` };
  }

  const message = String(body?.message ?? "").trim();
  if (!message) {
    return { ok: false, message: "message must be a non-empty string." };
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { ok: false, message: `message must be at most ${MAX_MESSAGE_LENGTH} characters.` };
  }

  return { ok: true, title, message };
}

/**
 * Maximum number of recipients accepted by a single targeted-notification
 * request, mirroring the recipient caps used by other multi-user admin
 * actions in this codebase.
 *
 * @type {number}
 */
const MAX_RECIPIENTS = 100;

/**
 * Validates a `POST /admin/notifications/moderation` request body.
 *
 * @param {unknown} body Parsed request body.
 * @returns {{ok: true, title: string, message: string, userIds: number[]}|{ok: false, message: string}}
 *   Validated title/message/userIds, or a validation error.
 */
function parseModerationBody(body) {
  const parsedBroadcast = parseBroadcastBody(body);
  if (!parsedBroadcast.ok) {
    return parsedBroadcast;
  }

  const rawUserIds = Array.isArray(body?.userIds) ? body.userIds : null;
  if (!rawUserIds || rawUserIds.length === 0) {
    return { ok: false, message: "userIds must be a non-empty array." };
  }
  if (rawUserIds.length > MAX_RECIPIENTS) {
    return { ok: false, message: `userIds must contain at most ${MAX_RECIPIENTS} entries.` };
  }

  const userIds = [...new Set(rawUserIds.map((id) => Number(id)))];
  if (userIds.some((id) => !Number.isInteger(id) || id <= 0)) {
    return { ok: false, message: "userIds must contain only positive integers." };
  }

  return { ok: true, title: parsedBroadcast.title, message: parsedBroadcast.message, userIds };
}

/**
 * Builds the admin broadcast router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured admin broadcast router.
 */
export function createAdminBroadcastRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Sends a sitewide notification (type "admin") to every user, including
   * the sending admin. Best-effort per recipient - `createNotification`
   * never throws, so one bad row doesn't stop the rest of the broadcast.
   * POST /api/v1/admin/notifications/broadcast
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/notifications/broadcast:
   *   post:
   *     tags: [Admin]
   *     summary: Broadcast a notification to every user
   *     operationId: adminBroadcastNotification
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [title, message]
   *             properties:
   *               title: { type: string }
   *               message: { type: string }
   *     responses:
   *       200:
   *         description: Broadcast sent
   *       400:
   *         description: Invalid body
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ success: true, notifiedCount }` or an error response.
   */
  router.post(
    "/admin/notifications/broadcast",
    requireAuth,
    requireAdmin,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      const parsed = parseBroadcastBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: "invalid_body", message: parsed.message });
        return;
      }

      try {
        const users = await User.findAll({ attributes: ["id"] });

        await Promise.all(
          users.map((recipient) =>
            createNotification({
              recipientUserId: recipient.id,
              typeName: "admin",
              title: parsed.title,
              message: parsed.message,
            }),
          ),
        );

        res.status(200).json({ success: true, notifiedCount: users.length });
      } catch (err) {
        console.error("adminBroadcastNotification failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to send broadcast notification.",
        });
      }
    },
  );

  /**
   * Sends a moderation notification (type "moderation") to a specific set
   * of users. Best-effort per recipient - `createNotification` never
   * throws, so one bad row doesn't stop the rest. Recipients that don't
   * exist are silently skipped rather than failing the whole request.
   * POST /api/v1/admin/notifications/moderation
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/notifications/moderation:
   *   post:
   *     tags: [Admin]
   *     summary: Send a moderation notification to specific users
   *     operationId: adminModerationNotification
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [title, message, userIds]
   *             properties:
   *               title: { type: string }
   *               message: { type: string }
   *               userIds:
   *                 type: array
   *                 items: { type: integer }
   *     responses:
   *       200:
   *         description: Notification sent
   *       400:
   *         description: Invalid body
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ success: true, notifiedCount }` or an error response.
   */
  router.post(
    "/admin/notifications/moderation",
    requireAuth,
    requireAdmin,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      const parsed = parseModerationBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ error: "invalid_body", message: parsed.message });
        return;
      }

      try {
        const recipients = await User.findAll({
          where: { id: parsed.userIds },
          attributes: ["id"],
        });

        await Promise.all(
          recipients.map((recipient) =>
            createNotification({
              recipientUserId: recipient.id,
              typeName: "moderation",
              title: parsed.title,
              message: parsed.message,
            }),
          ),
        );

        res.status(200).json({ success: true, notifiedCount: recipients.length });
      } catch (err) {
        console.error("adminModerationNotification failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to send moderation notification.",
        });
      }
    },
  );

  return router;
}
