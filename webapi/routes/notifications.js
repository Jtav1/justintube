import { Router } from "express";
import { Op } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { Notification, NotificationType } from "../lib/models/index.js";
import { parsePagination } from "../lib/pagination.js";
import { logger } from "../lib/logger.js";
import { parsePositiveInt } from "./videos.js";

/**
 * Serializes a Notification row (with its joined NotificationType) for API
 * responses.
 *
 * @param {import('sequelize').Model} notification Notification row, with
 *   `NotificationType` eagerly loaded.
 * @returns {{id: number, notificationType: string, title: string, message: string,
 *   target: string|null, readAt: string|null, createdAt: string}} Serialized notification.
 */
function serializeNotification(notification) {
  return {
    id: notification.id,
    notificationType: notification.NotificationType?.name ?? null,
    title: notification.title,
    message: notification.message,
    target: notification.target,
    readAt: notification.readAt,
    createdAt: notification.createdAt,
  };
}

/**
 * Validates a `POST /notifications/read` request body.
 *
 * @param {unknown} body Parsed request body.
 * @returns {{ok: true, notificationIds: number[]}|{ok: false, message: string}}
 *   Validated, deduped notification IDs, or a validation error.
 */
function parseMarkReadBody(body) {
  const notificationIds = body?.notificationIds;
  if (!Array.isArray(notificationIds) || notificationIds.length === 0) {
    return { ok: false, message: "notificationIds must be a non-empty array." };
  }

  const ids = [];
  const seen = new Set();
  for (const item of notificationIds) {
    const id = Number(item);
    if (!Number.isInteger(id) || id < 1) {
      return { ok: false, message: "notificationIds entries must be positive integers." };
    }
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    ids.push(id);
  }

  return { ok: true, notificationIds: ids };
}

/**
 * Builds the notifications router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured notifications router.
 */
export function createNotificationsRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Returns the authenticated user's notifications, newest first, paginated.
   * GET /api/v1/notifications
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/notifications:
   *   get:
   *     tags: [Notifications]
   *     summary: List my notifications
   *     operationId: listNotifications
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: page
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           default: 1
   *       - name: limit
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 99
   *           default: 20
   *     responses:
   *       200:
   *         description: Paginated list of my notifications
   *       400:
   *         description: Invalid page/limit
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the paginated notification list or an error response.
   */
  router.get("/notifications", requireAuth, async (req, res) => {
    try {
      const pagination = parsePagination(req.query);
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }
      const { page, limit } = pagination;

      const { rows, count } = await Notification.findAndCountAll({
        where: { userId: req.user.id, deleted: false },
        include: [{ model: NotificationType, attributes: ["name"] }],
        order: [["createdAt", "DESC"]],
        limit,
        offset: (page - 1) * limit,
      });

      res.status(200).json({
        items: rows.map(serializeNotification),
        page,
        limit,
        totalHits: count,
        totalPages: count === 0 ? 0 : Math.ceil(count / limit),
      });
    } catch (err) {
      logger.error({ err }, "listNotifications failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list notifications.",
      });
    }
  });

  /**
   * Marks one or more of the authenticated user's notifications as read.
   * POST /api/v1/notifications/read with `{ notificationIds: number[] }`.
   * IDs that don't exist or don't belong to the caller are silently ignored.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/notifications/read:
   *   post:
   *     tags: [Notifications]
   *     summary: Mark my notifications as read
   *     operationId: markNotificationsRead
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
   *             required: [notificationIds]
   *             properties:
   *               notificationIds:
   *                 type: array
   *                 items:
   *                   type: integer
   *     responses:
   *       200:
   *         description: Notifications marked read
   *       400:
   *         description: Invalid body
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }` or an error response.
   */
  router.post("/notifications/read", requireAuth, requireApiKeyScope("profile_edit"), async (req, res) => {
    try {
      const parsed = parseMarkReadBody(req.body);
      if (!parsed.ok) {
        res.status(400).json({ success: false, error: "invalid_body", message: parsed.message });
        return;
      }

      await Notification.update(
        { readAt: new Date() },
        {
          where: {
            id: { [Op.in]: parsed.notificationIds },
            userId: req.user.id,
          },
        },
      );

      res.status(200).json({ success: true });
    } catch (err) {
      logger.error({ err }, "markNotificationsRead failed");
      res.status(500).json({
        success: false,
        error: "internal_error",
        message: "Failed to mark notifications as read.",
      });
    }
  });

  /**
   * Marks all of the authenticated user's unread, non-deleted notifications
   * as read with the current time.
   * POST /api/v1/notifications/read-all
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/notifications/read-all:
   *   post:
   *     tags: [Notifications]
   *     summary: Mark all of my notifications as read
   *     operationId: markAllNotificationsRead
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Notifications marked read
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }` or an error response.
   */
  router.post("/notifications/read-all", requireAuth, requireApiKeyScope("profile_edit"), async (req, res) => {
    try {
      await Notification.update(
        { readAt: new Date() },
        {
          where: {
            userId: req.user.id,
            deleted: false,
            readAt: null,
          },
        },
      );

      res.status(200).json({ success: true });
    } catch (err) {
      logger.error({ err }, "markAllNotificationsRead failed");
      res.status(500).json({
        success: false,
        error: "internal_error",
        message: "Failed to mark all notifications as read.",
      });
    }
  });

  /**
   * Soft-deletes a single notification owned by the authenticated user. The
   * row is kept (its `deleted` flag is set) rather than removed, and is
   * excluded from `GET /notifications` afterward. 404s if the notification
   * doesn't exist or belongs to another user.
   * DELETE /api/v1/notifications/:id
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/notifications/{id}:
   *   delete:
   *     tags: [Notifications]
   *     summary: Delete one of my notifications
   *     operationId: deleteNotification
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: integer
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       204:
   *         description: Notification deleted
   *       400:
   *         description: Invalid id
   *       401:
   *         description: Not authenticated
   *       404:
   *         description: Notification not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 empty or an error response.
   */
  router.delete("/notifications/:id", requireAuth, requireApiKeyScope("profile_edit"), async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const notification = await Notification.findOne({
        where: { id, userId: req.user.id, deleted: false },
      });
      if (!notification) {
        res.status(404).json({ error: "not_found", message: "Notification not found." });
        return;
      }

      notification.deleted = true;
      await notification.save();

      res.status(204).send();
    } catch (err) {
      logger.error({ err }, "deleteNotification failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to delete notification.",
      });
    }
  });

  return router;
}
