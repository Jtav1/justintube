import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import {
  NotificationType,
  UserNotificationSetting,
  sequelize,
} from "../lib/models/index.js";

/**
 * Loads all active notification types, ordered by id.
 *
 * @returns {Promise<import('sequelize').Model[]>} Active NotificationType rows.
 */
async function loadActiveNotificationTypes() {
  return NotificationType.findAll({
    where: { enabled: true },
    order: [["id", "ASC"]],
  });
}

/**
 * Builds the caller's full notification preferences payload: one entry per
 * active notification type, defaulting to `enabled: true` for any type the
 * user has no explicit row for yet.
 *
 * @param {number} userId Id of the authenticated user.
 * @returns {Promise<{preferences: {notificationType: string, enabled: boolean}[]}>}
 *   The preferences payload.
 */
async function buildPreferencesPayload(userId) {
  const types = await loadActiveNotificationTypes();
  const settings = await UserNotificationSetting.findAll({ where: { userId } });
  const enabledByTypeId = new Map(
    settings.map((row) => [row.notificationTypeId, Boolean(row.enabled)]),
  );

  return {
    preferences: types.map((type) => ({
      notificationType: type.name,
      enabled: enabledByTypeId.has(type.id)
        ? enabledByTypeId.get(type.id)
        : true,
    })),
  };
}

/**
 * Validates a PATCH request body's `preferences` array.
 *
 * @param {unknown} body Parsed request body.
 * @param {Map<string, number>} typeIdByName Active notification type name -> id.
 * @returns {{ ok: true, updates: {notificationTypeId: number, enabled: boolean}[] }
 *   | { ok: false, message: string }} Validated updates or a validation error.
 */
function parsePreferencesUpdate(body, typeIdByName) {
  const preferences = body?.preferences;
  if (!Array.isArray(preferences) || preferences.length === 0) {
    return { ok: false, message: "preferences must be a non-empty array." };
  }

  /** @type {{ notificationTypeId: number, enabled: boolean }[]} */
  const updates = [];
  const seen = new Set();

  for (const item of preferences) {
    const notificationType = String(item?.notificationType ?? "").trim();
    if (!notificationType) {
      return { ok: false, message: "notificationType is required." };
    }
    if (typeof item?.enabled !== "boolean") {
      return {
        ok: false,
        message: `enabled must be a boolean for notificationType "${notificationType}".`,
      };
    }
    if (seen.has(notificationType)) {
      return {
        ok: false,
        message: `Duplicate notificationType: "${notificationType}".`,
      };
    }
    seen.add(notificationType);

    const typeId = typeIdByName.get(notificationType);
    if (typeId === undefined) {
      return {
        ok: false,
        message: `Unknown notification type: "${notificationType}".`,
      };
    }

    updates.push({ notificationTypeId: typeId, enabled: item.enabled });
  }

  return { ok: true, updates };
}

/**
 * Builds the notification preferences router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured notification preferences router.
 */
export function createNotificationPreferencesRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Returns the authenticated user's notification preferences.
   * GET /api/v1/me/notification-preferences
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/notification-preferences:
   *   get:
   *     tags: [Me]
   *     summary: Get my notification preferences
   *     operationId: getNotificationPreferences
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Per-type enabled flags (defaults to true for types with no explicit row)
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ preferences }` or an error response.
   */
  router.get("/me/notification-preferences", requireAuth, async (req, res) => {
    try {
      res.json(await buildPreferencesPayload(req.user.id));
    } catch (err) {
      console.error("getNotificationPreferences failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load notification preferences.",
      });
    }
  });

  /**
   * Updates one or more of the authenticated user's notification preferences.
   * PATCH /api/v1/me/notification-preferences with `{ preferences: [{ notificationType, enabled }] }`.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/me/notification-preferences:
   *   patch:
   *     tags: [Me]
   *     summary: Update my notification preferences
   *     operationId: updateNotificationPreferences
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
   *             required: [preferences]
   *             properties:
   *               preferences:
   *                 type: array
   *                 items:
   *                   type: object
   *                   required: [notificationType, enabled]
   *                   properties:
   *                     notificationType: { type: string }
   *                     enabled: { type: boolean }
   *     responses:
   *       200:
   *         description: Updated preferences (full list, same shape as GET)
   *       400:
   *         description: Invalid body
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the updated preferences or an error response.
   */
  router.patch(
    "/me/notification-preferences",
    requireAuth,
    async (req, res) => {
      try {
        const types = await loadActiveNotificationTypes();
        const typeIdByName = new Map(types.map((type) => [type.name, type.id]));

        const parsed = parsePreferencesUpdate(req.body, typeIdByName);
        if (!parsed.ok) {
          res.status(400).json({ error: "invalid_body", message: parsed.message });
          return;
        }

        await sequelize.transaction(async (transaction) => {
          for (const { notificationTypeId, enabled } of parsed.updates) {
            const [row, created] = await UserNotificationSetting.findOrCreate({
              where: { userId: req.user.id, notificationTypeId },
              defaults: { enabled },
              transaction,
            });
            if (!created) {
              await row.update({ enabled }, { transaction });
            }
          }
        });

        res.json(await buildPreferencesPayload(req.user.id));
      } catch (err) {
        console.error("updateNotificationPreferences failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to update notification preferences.",
        });
      }
    },
  );

  return router;
}
