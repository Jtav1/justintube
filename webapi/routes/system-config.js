import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { SystemConfig } from "../lib/models/index.js";

/**
 * Maximum allowed length for a system config variable name.
 *
 * @type {number}
 */
const MAX_NAME_LENGTH = 128;

/**
 * Serializes a SystemConfig row for JSON API responses.
 *
 * @param {import('sequelize').Model} row Sequelize SystemConfig instance.
 * @returns {{id: number, name: string, value: string, createdAt: Date, updatedAt: Date}}
 *   Public config payload.
 */
function serializeSystemConfig(row) {
  return {
    id: row.id,
    name: row.name,
    value: row.value,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Validates and normalizes a config name from a path parameter.
 *
 * @param {unknown} raw Raw path param value.
 * @returns {{ok: true, name: string}|{ok: false, message: string}} Parsed name or error.
 */
function parseConfigName(raw) {
  const name = String(raw || "").trim();
  if (!name) {
    return { ok: false, message: "name is required." };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return {
      ok: false,
      message: `name must be at most ${MAX_NAME_LENGTH} characters.`,
    };
  }
  return { ok: true, name };
}

/**
 * Validates and normalizes a config value from the request body.
 *
 * @param {unknown} raw Raw body.value.
 * @returns {{ok: true, value: string}|{ok: false, message: string}} Parsed value or error.
 */
function parseConfigValue(raw) {
  if (raw === undefined || raw === null) {
    return { ok: false, message: "value is required." };
  }
  const value = String(raw).trim();
  if (!value) {
    return { ok: false, message: "value must be a non-empty string." };
  }
  return { ok: true, value };
}

/**
 * Builds the admin system-configuration router (list / get / upsert / delete).
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createSystemConfigRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Lists all system configuration variables.
   * GET /api/v1/admin/config — no body.
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/config:
   *   get:
   *     tags: [Admin]
   *     summary: List system configuration variables
   *     operationId: adminListSystemConfig
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Array of config entries
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with config array, or error.
   */
  router.get("/admin/config", requireAuth, requireAdmin, async (_req, res) => {
    try {
      const rows = await SystemConfig.findAll({
        order: [["name", "ASC"]],
      });
      res.status(200).json(rows.map(serializeSystemConfig));
    } catch (err) {
      console.error("adminListSystemConfig failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list system configuration.",
      });
    }
  });

  /**
   * Returns one system configuration variable by name.
   * GET /api/v1/admin/config/:name — no body.
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/config/{name}:
   *   get:
   *     tags: [Admin]
   *     summary: Get a system configuration variable by name
   *     operationId: adminGetSystemConfig
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: name
   *         in: path
   *         required: true
   *         schema: { type: string, maxLength: 128 }
   *     responses:
   *       200:
   *         description: Config entry
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: Config name not found
   *
   * @param {import('express').Request} req Incoming request (`name` path param).
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with config, 404, or error.
   */
  router.get(
    "/admin/config/:name",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const parsed = parseConfigName(req.params.name);
      if (!parsed.ok) {
        res.status(400).json({
          error: "invalid_body",
          message: parsed.message,
        });
        return;
      }

      try {
        const row = await SystemConfig.findOne({
          where: { name: parsed.name },
        });
        if (!row) {
          res.status(404).json({
            error: "not_found",
            message: "System configuration variable not found.",
          });
          return;
        }
        res.status(200).json(serializeSystemConfig(row));
      } catch (err) {
        console.error("adminGetSystemConfig failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to get system configuration.",
        });
      }
    },
  );

  /**
   * Creates or updates a system configuration variable by name.
   * PUT /api/v1/admin/config/:name with `{ value }`.
   * Auth: session cookie or Bearer API key; admin role required; CSRF for sessions.
   *
   * @openapi
   * /api/v1/admin/config/{name}:
   *   put:
   *     tags: [Admin]
   *     summary: Create or update a system configuration variable
   *     operationId: adminUpsertSystemConfig
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: name
   *         in: path
   *         required: true
   *         schema: { type: string, maxLength: 128 }
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [value]
   *             properties:
   *               value: { type: string }
   *     responses:
   *       200:
   *         description: Upserted config entry
   *       400:
   *         description: Invalid name or value
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request (`name` + body.value).
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with config, 400, or error.
   */
  router.put(
    "/admin/config/:name",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const parsedName = parseConfigName(req.params.name);
      if (!parsedName.ok) {
        res.status(400).json({
          error: "invalid_body",
          message: parsedName.message,
        });
        return;
      }

      const parsedValue = parseConfigValue(req.body?.value);
      if (!parsedValue.ok) {
        res.status(400).json({
          error: "invalid_body",
          message: parsedValue.message,
        });
        return;
      }

      try {
        let row = await SystemConfig.findOne({
          where: { name: parsedName.name },
        });
        if (row) {
          row.value = parsedValue.value;
          await row.save();
        } else {
          row = await SystemConfig.create({
            name: parsedName.name,
            value: parsedValue.value,
          });
        }
        res.status(200).json(serializeSystemConfig(row));
      } catch (err) {
        console.error("adminUpsertSystemConfig failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to upsert system configuration.",
        });
      }
    },
  );

  /**
   * Deletes a system configuration variable by name.
   * DELETE /api/v1/admin/config/:name — no body.
   * Auth: session cookie or Bearer API key; admin role required; CSRF for sessions.
   *
   * @openapi
   * /api/v1/admin/config/{name}:
   *   delete:
   *     tags: [Admin]
   *     summary: Delete a system configuration variable
   *     operationId: adminDeleteSystemConfig
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: name
   *         in: path
   *         required: true
   *         schema: { type: string, maxLength: 128 }
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *     responses:
   *       200:
   *         description: Config deleted
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: Config name not found
   *
   * @param {import('express').Request} req Incoming request (`name` path param).
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }`, 404, or error.
   */
  router.delete(
    "/admin/config/:name",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const parsed = parseConfigName(req.params.name);
      if (!parsed.ok) {
        res.status(400).json({
          success: false,
          error: "invalid_body",
          message: parsed.message,
        });
        return;
      }

      try {
        const deleted = await SystemConfig.destroy({
          where: { name: parsed.name },
        });
        if (!deleted) {
          res.status(404).json({
            success: false,
            error: "not_found",
            message: "System configuration variable not found.",
          });
          return;
        }
        res.status(200).json({ success: true });
      } catch (err) {
        console.error("adminDeleteSystemConfig failed:", err);
        res.status(500).json({
          success: false,
          error: "internal_error",
          message: "Failed to delete system configuration.",
        });
      }
    },
  );

  return router;
}
