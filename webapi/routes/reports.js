import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { requireModerator } from "../lib/auth/require-moderator.js";
import { Report, Role, User } from "../lib/models/index.js";
import { REPORT_TYPE_VALUES } from "../lib/models/constants.js";
import { createNotification } from "../lib/notifications.js";
import { parsePagination } from "../lib/pagination.js";
import { serializeUserRef } from "../lib/serialize-user-ref.js";

/**
 * Maximum length for report description and moderator comment fields.
 *
 * @type {number}
 */
const MAX_TEXT_LENGTH = 1000;

/**
 * Maximum length for the client-supplied report link.
 *
 * @type {number}
 */
const MAX_LINK_LENGTH = 2048;

/**
 * Parses a route `:id` param as a positive integer primary key.
 *
 * @param {unknown} raw Route parameter value.
 * @returns {number|null} Parsed id, or null when invalid.
 */
function parsePositiveInt(raw) {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return null;
  }
  return n;
}

/**
 * Serializes a Report row for JSON responses.
 *
 * @param {import('sequelize').Model} row Report instance.
 * @returns {object} Public report payload.
 */
function serializeReport(row) {
  return {
    id: row.id,
    reportType: row.reportType,
    link: row.link,
    description: row.description,
    resolved: row.resolved,
    comment: row.comment ?? null,
    videoId: row.videoId ?? null,
    playlistId: row.playlistId ?? null,
    reporter: serializeUserRef(row.reporterUserId, row.Reporter?.username, row.Reporter?.displayName),
    reportedUser: serializeUserRef(
      row.reportedUserId,
      row.ReportedUser?.username,
      row.ReportedUser?.displayName,
    ),
    commenter: serializeUserRef(
      row.commenterUserId,
      row.Commenter?.username,
      row.Commenter?.displayName,
    ),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Standard include set for loading user references on a report.
 *
 * @type {object[]}
 */
const REPORT_USER_INCLUDES = [
  { model: User, as: "Reporter", required: false },
  { model: User, as: "ReportedUser", required: false },
  { model: User, as: "Commenter", required: false },
];

/**
 * Parses a required reportType field against REPORT_TYPE_VALUES.
 *
 * @param {unknown} raw Body reportType value.
 * @returns {{ok: true, value: string}|{ok: false, message: string}} Parsed value or error.
 */
function parseReportType(raw) {
  const value = String(raw ?? "").trim();
  if (!REPORT_TYPE_VALUES.includes(value)) {
    return {
      ok: false,
      message: `reportType must be one of: ${REPORT_TYPE_VALUES.join(", ")}.`,
    };
  }
  return { ok: true, value };
}

/**
 * Parses a required non-empty string field with a max length.
 *
 * @param {unknown} raw Body field value.
 * @param {string} fieldName Field name for error messages.
 * @param {number} maxLength Maximum allowed length.
 * @returns {{ok: true, value: string}|{ok: false, message: string}} Parsed value or error.
 */
function parseRequiredText(raw, fieldName, maxLength) {
  const value = String(raw ?? "").trim();
  if (!value) {
    return { ok: false, message: `${fieldName} is required.` };
  }
  if (value.length > maxLength) {
    return {
      ok: false,
      message: `${fieldName} must be at most ${maxLength} characters.`,
    };
  }
  return { ok: true, value };
}

/**
 * Parses an optional nullable string field with a max length. Missing,
 * null, or blank input is treated as "not provided" (null), not an error.
 *
 * @param {unknown} raw Body field value.
 * @param {string} fieldName Field name for error messages.
 * @param {number} maxLength Maximum allowed length.
 * @returns {{ok: true, value: string|null}|{ok: false, message: string}} Parsed value or error.
 */
function parseOptionalText(raw, fieldName, maxLength) {
  if (raw === undefined || raw === null) {
    return { ok: true, value: null };
  }
  const value = String(raw).trim();
  if (!value) {
    return { ok: true, value: null };
  }
  if (value.length > maxLength) {
    return {
      ok: false,
      message: `${fieldName} must be at most ${maxLength} characters.`,
    };
  }
  return { ok: true, value };
}

/**
 * Parses an optional nullable positive integer target id field.
 *
 * @param {unknown} raw Body field value.
 * @param {string} fieldName Field name for error messages.
 * @returns {{ok: true, value?: number}|{ok: false, message: string}} Parsed value or error.
 */
function parseOptionalTargetId(raw, fieldName) {
  if (raw === undefined || raw === null) {
    return { ok: true };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, message: `${fieldName} must be a positive integer.` };
  }
  return { ok: true, value: n };
}

/**
 * Parses and validates the body of a report creation request.
 *
 * @param {Record<string, unknown>} body Request body.
 * @returns {{ok: true, patch: Record<string, unknown>}|{ok: false, message: string}}
 *   Parsed fields or a validation error.
 */
function parseCreateReportBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const reportType = parseReportType(body.reportType);
  if (!reportType.ok) {
    return reportType;
  }

  const link = parseOptionalText(body.link, "link", MAX_LINK_LENGTH);
  if (!link.ok) {
    return link;
  }

  const description = parseRequiredText(body.description, "description", MAX_TEXT_LENGTH);
  if (!description.ok) {
    return description;
  }

  const videoId = parseOptionalTargetId(body.videoId, "videoId");
  if (!videoId.ok) {
    return videoId;
  }

  const reportedUserId = parseOptionalTargetId(body.reportedUserId, "reportedUserId");
  if (!reportedUserId.ok) {
    return reportedUserId;
  }

  const playlistId = parseOptionalTargetId(body.playlistId, "playlistId");
  if (!playlistId.ok) {
    return playlistId;
  }

  return {
    ok: true,
    patch: {
      reportType: reportType.value,
      link: link.value,
      description: description.value,
      videoId: videoId.value ?? null,
      reportedUserId: reportedUserId.value ?? null,
      playlistId: playlistId.value ?? null,
    },
  };
}

/**
 * Parses and validates the body of an owner self-service report update.
 * Only `description` and a one-way `resolved: true` close are permitted.
 *
 * @param {Record<string, unknown>} body Request body.
 * @returns {{ok: true, patch: Record<string, unknown>}|{ok: false, message: string}}
 *   Parsed fields or a validation error.
 */
function parseOwnerUpdateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const patch = {};

  if (Object.prototype.hasOwnProperty.call(body, "description")) {
    const description = parseRequiredText(body.description, "description", MAX_TEXT_LENGTH);
    if (!description.ok) {
      return description;
    }
    patch.description = description.value;
  }

  if (Object.prototype.hasOwnProperty.call(body, "resolved")) {
    if (body.resolved !== true) {
      return {
        ok: false,
        message: "resolved may only be set to true (closing a report); reopening requires a moderator.",
      };
    }
    patch.resolved = true;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, message: "At least one of description or resolved is required." };
  }

  return { ok: true, patch };
}

/**
 * Parses and validates the body of a moderator report update.
 *
 * @param {Record<string, unknown>} body Request body.
 * @returns {{ok: true, patch: Record<string, unknown>}|{ok: false, message: string}}
 *   Parsed fields or a validation error.
 */
function parseModerateBody(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const patch = {};

  if (Object.prototype.hasOwnProperty.call(body, "resolved")) {
    if (typeof body.resolved !== "boolean") {
      return { ok: false, message: "resolved must be a boolean." };
    }
    patch.resolved = body.resolved;
  }

  if (Object.prototype.hasOwnProperty.call(body, "comment")) {
    const comment = parseRequiredText(body.comment, "comment", MAX_TEXT_LENGTH);
    if (!comment.ok) {
      return comment;
    }
    patch.comment = comment.value;
  }

  if (Object.keys(patch).length === 0) {
    return { ok: false, message: "At least one of resolved or comment is required." };
  }

  return { ok: true, patch };
}

/**
 * Notifies the reporter that their report was submitted, and every
 * admin/moderator that a new report needs triage. Never throws -
 * `createNotification` swallows its own delivery failures.
 *
 * @param {import('sequelize').Model} report Newly created Report row.
 * @param {number} actorUserId Id of the user who filed the report.
 * @returns {Promise<void>} Resolves once delivery has been attempted.
 */
async function notifyReportCreated(report, actorUserId) {
  const moderators = await User.findAll({
    attributes: ["id"],
    include: [{ model: Role, where: { name: ["admin", "moderator"] }, attributes: [] }],
  });

  await Promise.all([
    createNotification({
      recipientUserId: report.reporterUserId,
      typeName: "report",
      title: "Report submitted",
      message: "Your report has been submitted and will be reviewed by a moderator.",
      target: String(report.id),
    }),
    ...moderators.map((moderator) =>
      createNotification({
        recipientUserId: moderator.id,
        actorUserId,
        typeName: "report",
        title: "New report filed",
        message: `A new ${report.reportType} report was filed and needs review.`,
        target: String(report.id),
      }),
    ),
  ]);
}

/**
 * Builds the reports router: create, self-service update/close, moderator
 * triage, and admin deletion.
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createReportsRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Creates a new report.
   * POST /api/v1/reports
   * Auth: session cookie or Bearer API key; any authenticated user.
   *
   * @openapi
   * /api/v1/reports:
   *   post:
   *     tags: [Reports]
   *     summary: Create a report
   *     operationId: createReport
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
   *             required: [reportType, description]
   *             properties:
   *               reportType:
   *                 type: string
   *                 enum: [video, user, playlist, website, system]
   *               link: { type: string, maxLength: 2048, nullable: true }
   *               description: { type: string, maxLength: 1000 }
   *               videoId: { type: integer, minimum: 1 }
   *               reportedUserId: { type: integer, minimum: 1 }
   *               playlistId: { type: integer, minimum: 1 }
   *     responses:
   *       201:
   *         description: Created report
   *       400:
   *         description: Invalid body
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 201 with created report, or error.
   */
  router.post("/reports", requireAuth, async (req, res) => {
    const parsed = parseCreateReportBody(req.body || {});
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid_body", message: parsed.message });
      return;
    }

    try {
      const created = await Report.create({
        ...parsed.patch,
        reporterUserId: req.user.id,
      });
      const row = await Report.findByPk(created.id, { include: REPORT_USER_INCLUDES });
      await notifyReportCreated(row, req.user.id);
      res.status(201).json(serializeReport(row));
    } catch (err) {
      console.error("createReport failed:", err);
      res.status(500).json({ error: "internal_error", message: "Failed to create report." });
    }
  });

  /**
   * Lists reports filed by the current user.
   * GET /api/v1/reports/mine
   * Auth: session cookie or Bearer API key; any authenticated user.
   *
   * @openapi
   * /api/v1/reports/mine:
   *   get:
   *     tags: [Reports]
   *     summary: List my reports
   *     operationId: listMyReports
   *     parameters:
   *       - name: page
   *         in: query
   *         schema: { type: integer, minimum: 1 }
   *       - name: limit
   *         in: query
   *         schema: { type: integer, minimum: 1, maximum: 99 }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: My report list
   *       400:
   *         description: Invalid pagination
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with `{ items, page, limit, total }`, or error.
   */
  router.get("/reports/mine", requireAuth, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination.ok) {
      res.status(400).json({ error: "invalid_query", message: pagination.message });
      return;
    }

    try {
      const { rows, count } = await Report.findAndCountAll({
        where: { reporterUserId: req.user.id },
        include: REPORT_USER_INCLUDES,
        order: [["createdAt", "DESC"]],
        limit: pagination.limit,
        offset: (pagination.page - 1) * pagination.limit,
      });
      res.status(200).json({
        items: rows.map(serializeReport),
        page: pagination.page,
        limit: pagination.limit,
        total: count,
      });
    } catch (err) {
      console.error("listMyReports failed:", err);
      res.status(500).json({ error: "internal_error", message: "Failed to list reports." });
    }
  });

  /**
   * Lists all reports, optionally filtered by resolved state.
   * GET /api/v1/reports
   * Auth: session cookie or Bearer API key; moderator or admin role required.
   *
   * @openapi
   * /api/v1/reports:
   *   get:
   *     tags: [Reports]
   *     summary: List all reports
   *     operationId: listReports
   *     parameters:
   *       - name: resolved
   *         in: query
   *         schema: { type: boolean }
   *       - name: page
   *         in: query
   *         schema: { type: integer, minimum: 1 }
   *       - name: limit
   *         in: query
   *         schema: { type: integer, minimum: 1, maximum: 99 }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Report list
   *       400:
   *         description: Invalid query
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not a moderator or admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with `{ items, page, limit, total }`, or error.
   */
  router.get("/reports", requireAuth, requireModerator, async (req, res) => {
    const pagination = parsePagination(req.query);
    if (!pagination.ok) {
      res.status(400).json({ error: "invalid_query", message: pagination.message });
      return;
    }

    const where = {};
    if (req.query.resolved !== undefined) {
      if (req.query.resolved !== "true" && req.query.resolved !== "false") {
        res.status(400).json({ error: "invalid_query", message: "resolved must be true or false." });
        return;
      }
      where.resolved = req.query.resolved === "true";
    }

    try {
      const { rows, count } = await Report.findAndCountAll({
        where,
        include: REPORT_USER_INCLUDES,
        order: [["createdAt", "DESC"]],
        limit: pagination.limit,
        offset: (pagination.page - 1) * pagination.limit,
      });
      res.status(200).json({
        items: rows.map(serializeReport),
        page: pagination.page,
        limit: pagination.limit,
        total: count,
      });
    } catch (err) {
      console.error("listReports failed:", err);
      res.status(500).json({ error: "internal_error", message: "Failed to list reports." });
    }
  });

  /**
   * Gets a single report record.
   * GET /api/v1/reports/:id
   * Auth: session cookie or Bearer API key; moderator or admin role required.
   *
   * @openapi
   * /api/v1/reports/{id}:
   *   get:
   *     tags: [Reports]
   *     summary: Get a report
   *     operationId: getReport
   *     parameters:
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer, minimum: 1 }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Report record
   *       400:
   *         description: Invalid id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not a moderator or admin
   *       404:
   *         description: Report not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with report record, or error.
   */
  router.get("/reports/:id", requireAuth, requireModerator, async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
      return;
    }

    try {
      const row = await Report.findByPk(id, { include: REPORT_USER_INCLUDES });
      if (!row) {
        res.status(404).json({ error: "not_found", message: "Report not found." });
        return;
      }
      res.status(200).json(serializeReport(row));
    } catch (err) {
      console.error("getReport failed:", err);
      res.status(500).json({ error: "internal_error", message: "Failed to fetch report." });
    }
  });

  /**
   * Updates a report's description and/or closes it. Only the reporting user
   * may call this route, and reopening (`resolved: false`) is not permitted.
   * PATCH /api/v1/reports/:id
   * Auth: session cookie or Bearer API key; must be the report's creator.
   *
   * @openapi
   * /api/v1/reports/{id}:
   *   patch:
   *     tags: [Reports]
   *     summary: Update or close my report
   *     operationId: updateReport
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer, minimum: 1 }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               description: { type: string, maxLength: 1000 }
   *               resolved: { type: boolean, enum: [true] }
   *     responses:
   *       200:
   *         description: Updated report
   *       400:
   *         description: Invalid body or id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not the report's creator
   *       404:
   *         description: Report not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with updated report, or error.
   */
  router.patch("/reports/:id", requireAuth, async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
      return;
    }

    const parsed = parseOwnerUpdateBody(req.body || {});
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid_body", message: parsed.message });
      return;
    }

    try {
      const row = await Report.findByPk(id);
      if (!row) {
        res.status(404).json({ error: "not_found", message: "Report not found." });
        return;
      }
      if (row.reporterUserId !== req.user.id) {
        res.status(403).json({ error: "forbidden", message: "You may only update reports you created." });
        return;
      }

      await row.update(parsed.patch);
      const reloaded = await Report.findByPk(id, { include: REPORT_USER_INCLUDES });
      res.status(200).json(serializeReport(reloaded));
    } catch (err) {
      console.error("updateReport failed:", err);
      res.status(500).json({ error: "internal_error", message: "Failed to update report." });
    }
  });

  /**
   * Updates a report's resolved state and/or moderator comment.
   * PATCH /api/v1/reports/:id/moderate
   * Auth: session cookie or Bearer API key; moderator or admin role required.
   *
   * @openapi
   * /api/v1/reports/{id}/moderate:
   *   patch:
   *     tags: [Reports]
   *     summary: Moderate a report
   *     operationId: moderateReport
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer, minimum: 1 }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               resolved: { type: boolean }
   *               comment: { type: string, maxLength: 1000 }
   *     responses:
   *       200:
   *         description: Updated report
   *       400:
   *         description: Invalid body or id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not a moderator or admin
   *       404:
   *         description: Report not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with updated report, or error.
   */
  router.patch("/reports/:id/moderate", requireAuth, requireModerator, async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (id === null) {
      res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
      return;
    }

    const parsed = parseModerateBody(req.body || {});
    if (!parsed.ok) {
      res.status(400).json({ error: "invalid_body", message: parsed.message });
      return;
    }

    try {
      const row = await Report.findByPk(id);
      if (!row) {
        res.status(404).json({ error: "not_found", message: "Report not found." });
        return;
      }

      if (Object.prototype.hasOwnProperty.call(parsed.patch, "comment")) {
        parsed.patch.commenterUserId = req.user.id;
      }

      await row.update(parsed.patch);
      const reloaded = await Report.findByPk(id, { include: REPORT_USER_INCLUDES });
      res.status(200).json(serializeReport(reloaded));
    } catch (err) {
      console.error("moderateReport failed:", err);
      res.status(500).json({ error: "internal_error", message: "Failed to moderate report." });
    }
  });

  /**
   * Deletes a report entirely.
   * DELETE /api/v1/reports/:id
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/reports/{id}:
   *   delete:
   *     tags: [Reports]
   *     summary: Delete a report
   *     operationId: deleteReport
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer, minimum: 1 }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Report deleted
   *       400:
   *         description: Invalid id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: Report not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }`, or error.
   */
  router.delete("/reports/:id", requireAuth, requireAdmin, async (req, res) => {
    const id = parsePositiveInt(req.params.id);
    if (id === null) {
      res.status(400).json({ success: false, error: "invalid_id", message: "id must be a positive integer." });
      return;
    }

    try {
      const row = await Report.findByPk(id);
      if (!row) {
        res.status(404).json({ success: false, error: "not_found", message: "Report not found." });
        return;
      }

      await row.destroy();
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("deleteReport failed:", err);
      res.status(500).json({ success: false, error: "internal_error", message: "Failed to delete report." });
    }
  });

  return router;
}
