import { Router } from "express";
import {
  generateApiKey,
  maskApiKeyPrefix,
} from "../lib/auth/api-key.js";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { User, UserApiKey } from "../lib/models/index.js";

/**
 * Maximum length for an API key display name.
 *
 * @type {number}
 */
const MAX_NAME_LENGTH = 255;

/**
 * Maximum length for an optional API key description.
 *
 * @type {number}
 */
const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * Default lifetime for newly created API keys when `expiresAt` is omitted.
 *
 * @type {number}
 */
const DEFAULT_TTL_MS = 365 * 24 * 60 * 60 * 1000;

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
 * Parses and validates an optional `expiresAt` value. When omitted, returns a
 * default expiry one year from now. Rejects non-dates and past timestamps.
 *
 * @param {unknown} raw Request body value (string, Date, or undefined).
 * @param {{ required?: boolean }} [options] When `required` is true, missing
 *   values are treated as invalid instead of defaulting.
 * @returns {{ ok: true, expiresAt: Date } | { ok: false, message: string }}
 *   Parsed expiry or a validation error message.
 */
function parseExpiresAt(raw, options = {}) {
  if (raw === undefined || raw === null || raw === "") {
    if (options.required) {
      return { ok: false, message: "expiresAt is required." };
    }
    return { ok: true, expiresAt: new Date(Date.now() + DEFAULT_TTL_MS) };
  }

  const expiresAt = new Date(/** @type {string|number|Date} */ (raw));
  if (Number.isNaN(expiresAt.getTime())) {
    return { ok: false, message: "expiresAt must be a valid date." };
  }
  if (expiresAt.getTime() <= Date.now()) {
    return { ok: false, message: "expiresAt must be in the future." };
  }
  return { ok: true, expiresAt };
}

/**
 * Validates create/update name and description fields.
 *
 * @param {object} body Request body.
 * @param {{ nameRequired?: boolean }} [options] Whether `name` is required.
 * @returns {{
 *   ok: true,
 *   name?: string,
 *   description?: string|null,
 *   hasName: boolean,
 *   hasDescription: boolean
 * } | { ok: false, message: string }} Parsed fields or a validation error.
 */
function parseNameAndDescription(body, options = {}) {
  const nameRequired = options.nameRequired !== false;
  const hasName = Object.prototype.hasOwnProperty.call(body || {}, "name");
  const hasDescription = Object.prototype.hasOwnProperty.call(
    body || {},
    "description",
  );

  /** @type {{ ok: true, name?: string, description?: string|null, hasName: boolean, hasDescription: boolean }} */
  const result = { ok: true, hasName, hasDescription };

  if (nameRequired || hasName) {
    const name = String(body?.name ?? "").trim();
    if (!name) {
      return { ok: false, message: "name is required." };
    }
    if (name.length > MAX_NAME_LENGTH) {
      return {
        ok: false,
        message: `name must be at most ${MAX_NAME_LENGTH} characters.`,
      };
    }
    result.name = name;
  }

  if (hasDescription) {
    if (body.description === null) {
      result.description = null;
    } else {
      const description = String(body.description);
      if (description.length > MAX_DESCRIPTION_LENGTH) {
        return {
          ok: false,
          message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
        };
      }
      result.description = description;
    }
  }

  return result;
}

/**
 * Maps a UserApiKey row to the public JSON shape. Never includes `keyHash` or
 * the plaintext key.
 *
 * @param {import('sequelize').Model} row UserApiKey instance.
 * @param {{ username?: string|null }} [extras] Optional admin-only fields.
 * @returns {{
 *   id: number,
 *   userId: number,
 *   name: string,
 *   description: string|null,
 *   keyDisplay: string,
 *   expiresAt: Date,
 *   revokedAt: Date|null,
 *   createdAt: Date,
 *   updatedAt: Date,
 *   username?: string|null
 * }} Public API key payload.
 */
function serializeApiKey(row, extras = {}) {
  const payload = {
    id: row.id,
    userId: row.userId,
    name: row.name,
    description: row.description ?? null,
    keyDisplay: maskApiKeyPrefix(row.keyPrefix),
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (Object.prototype.hasOwnProperty.call(extras, "username")) {
    payload.username = extras.username ?? null;
  }
  return payload;
}

/**
 * Soft-revokes an API key by setting `revokedAt` when not already revoked.
 *
 * @param {import('sequelize').Model} row UserApiKey instance.
 * @returns {Promise<void>} Resolves after the row is updated (or left unchanged).
 */
async function softRevoke(row) {
  if (row.revokedAt) {
    return;
  }
  await row.update({ revokedAt: new Date() });
}

/**
 * Builds the Me + Admin API keys router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured API keys router.
 */
export function createApiKeysRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Lists API keys owned by the authenticated user.
   * GET /api/v1/me/api-keys
   * Auth: session cookie or Bearer API key (`requireAuth`).
   *
   * @openapi
   * /api/v1/me/api-keys:
   *   get:
   *     tags: [Me]
   *     summary: List my API keys
   *     operationId: listMyApiKeys
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: API key metadata (masked keyDisplay only)
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ items }` or an error response.
   */
  router.get("/me/api-keys", requireAuth, async (req, res) => {
    try {
      const rows = await UserApiKey.findAll({
        where: { userId: req.user.id },
        order: [["createdAt", "DESC"]],
      });
      res.json({ items: rows.map((row) => serializeApiKey(row)) });
    } catch (err) {
      console.error("listMyApiKeys failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list API keys.",
      });
    }
  });

  /**
   * Creates a new API key for the authenticated user. The plaintext `key` is
   * returned only in this response.
   * POST /api/v1/me/api-keys with `{ name, description?, expiresAt? }`.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/me/api-keys:
   *   post:
   *     tags: [Me]
   *     summary: Create an API key
   *     operationId: createMyApiKey
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
   *             required: [name]
   *             properties:
   *               name: { type: string, maxLength: 255 }
   *               description: { type: string, maxLength: 2000, nullable: true }
   *               expiresAt: { type: string, format: date-time }
   *     responses:
   *       201:
   *         description: Key created; plaintext key returned once
   *       400:
   *         description: Invalid body
   *       401:
   *         description: Not authenticated
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 201 `{ ...metadata, key }` or an error.
   */
  router.post("/me/api-keys", requireAuth, async (req, res) => {
    try {
      const fields = parseNameAndDescription(req.body, { nameRequired: true });
      if (!fields.ok) {
        res.status(400).json({ error: "invalid_body", message: fields.message });
        return;
      }

      const expiry = parseExpiresAt(req.body?.expiresAt);
      if (!expiry.ok) {
        res.status(400).json({ error: "invalid_body", message: expiry.message });
        return;
      }

      const { rawKey, keyHash, keyPrefix } = generateApiKey();
      const row = await UserApiKey.create({
        userId: req.user.id,
        name: fields.name,
        description: fields.hasDescription ? fields.description : null,
        keyHash,
        keyPrefix,
        expiresAt: expiry.expiresAt,
        revokedAt: null,
      });

      res.status(201).json({
        ...serializeApiKey(row),
        key: rawKey,
      });
    } catch (err) {
      console.error("createMyApiKey failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to create API key.",
      });
    }
  });

  /**
   * Updates metadata on an owned API key.
   * PATCH /api/v1/me/api-keys/:id with `{ name?, description?, expiresAt? }`.
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/me/api-keys/{id}:
   *   patch:
   *     tags: [Me]
   *     summary: Update my API key metadata
   *     operationId: updateMyApiKey
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer }
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
   *               name: { type: string, maxLength: 255 }
   *               description: { type: string, maxLength: 2000, nullable: true }
   *               expiresAt: { type: string, format: date-time }
   *     responses:
   *       200:
   *         description: Updated key metadata
   *       400:
   *         description: Invalid body or id
   *       401:
   *         description: Not authenticated
   *       404:
   *         description: Key not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends updated metadata or an error response.
   */
  router.patch("/me/api-keys/:id", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const fields = parseNameAndDescription(req.body, { nameRequired: false });
      if (!fields.ok) {
        res.status(400).json({ error: "invalid_body", message: fields.message });
        return;
      }

      const hasExpiresAt = Object.prototype.hasOwnProperty.call(
        req.body || {},
        "expiresAt",
      );
      /** @type {Date|undefined} */
      let expiresAt;
      if (hasExpiresAt) {
        const expiry = parseExpiresAt(req.body.expiresAt, { required: true });
        if (!expiry.ok) {
          res
            .status(400)
            .json({ error: "invalid_body", message: expiry.message });
          return;
        }
        expiresAt = expiry.expiresAt;
      }

      if (!fields.hasName && !fields.hasDescription && !hasExpiresAt) {
        res.status(400).json({
          error: "invalid_body",
          message: "Provide at least one of name, description, or expiresAt.",
        });
        return;
      }

      const row = await UserApiKey.findOne({
        where: { id, userId: req.user.id },
      });
      if (!row) {
        res.status(404).json({
          error: "not_found",
          message: "API key not found.",
        });
        return;
      }

      /** @type {Record<string, unknown>} */
      const patch = {};
      if (fields.hasName) {
        patch.name = fields.name;
      }
      if (fields.hasDescription) {
        patch.description = fields.description;
      }
      if (hasExpiresAt) {
        patch.expiresAt = expiresAt;
      }

      await row.update(patch);
      res.json(serializeApiKey(row));
    } catch (err) {
      console.error("updateMyApiKey failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update API key.",
      });
    }
  });

  /**
   * Soft-revokes an API key owned by the authenticated user.
   * DELETE /api/v1/me/api-keys/:id
   * Auth: session cookie or Bearer API key; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/me/api-keys/{id}:
   *   delete:
   *     tags: [Me]
   *     summary: Revoke my API key
   *     operationId: revokeMyApiKey
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Key revoked (or already revoked)
   *       400:
   *         description: Invalid id
   *       401:
   *         description: Not authenticated
   *       404:
   *         description: Key not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }` or an error response.
   */
  router.delete("/me/api-keys/:id", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({
          success: false,
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const row = await UserApiKey.findOne({
        where: { id, userId: req.user.id },
      });
      if (!row) {
        res.status(404).json({
          success: false,
          error: "not_found",
          message: "API key not found.",
        });
        return;
      }

      await softRevoke(row);
      res.status(200).json({ success: true });
    } catch (err) {
      console.error("revokeMyApiKey failed:", err);
      res.status(500).json({
        success: false,
        error: "internal_error",
        message: "Failed to revoke API key.",
      });
    }
  });

  /**
   * Lists all user API keys for administrators (masked keyDisplay only).
   * GET /api/v1/admin/api-keys?userId=
   * Auth: admin role (`requireAuth` + `requireAdmin`).
   *
   * @openapi
   * /api/v1/admin/api-keys:
   *   get:
   *     tags: [Admin]
   *     summary: List all API keys
   *     operationId: adminListApiKeys
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: userId
   *         in: query
   *         required: false
   *         schema: { type: integer }
   *     responses:
   *       200:
   *         description: All keys with masked keyDisplay and username
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends `{ items }` or an error response.
   */
  router.get(
    "/admin/api-keys",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        /** @type {Record<string, unknown>} */
        const where = {};
        if (req.query.userId !== undefined && req.query.userId !== "") {
          const userId = parsePositiveInt(req.query.userId);
          if (userId == null) {
            res.status(400).json({
              error: "invalid_query",
              message: "userId must be a positive integer.",
            });
            return;
          }
          where.userId = userId;
        }

        const rows = await UserApiKey.findAll({
          where,
          include: [{ model: User, required: true, attributes: ["id", "username"] }],
          order: [["createdAt", "DESC"]],
        });

        res.json({
          items: rows.map((row) =>
            serializeApiKey(row, { username: row.User?.username ?? null }),
          ),
        });
      } catch (err) {
        console.error("adminListApiKeys failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to list API keys.",
        });
      }
    },
  );

  /**
   * Soft-revokes any user's API key (admin only).
   * DELETE /api/v1/admin/api-keys/:id
   * Auth: admin role; X-CSRF-Token for sessions.
   *
   * @openapi
   * /api/v1/admin/api-keys/{id}:
   *   delete:
   *     tags: [Admin]
   *     summary: Revoke any API key
   *     operationId: adminRevokeApiKey
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema: { type: integer }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Key revoked (or already revoked)
   *       400:
   *         description: Invalid id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: Key not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }` or an error response.
   */
  router.delete(
    "/admin/api-keys/:id",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const id = parsePositiveInt(req.params.id);
        if (id == null) {
          res.status(400).json({
            success: false,
            error: "invalid_id",
            message: "id must be a positive integer.",
          });
          return;
        }

        const row = await UserApiKey.findByPk(id);
        if (!row) {
          res.status(404).json({
            success: false,
            error: "not_found",
            message: "API key not found.",
          });
          return;
        }

        await softRevoke(row);
        res.status(200).json({ success: true });
      } catch (err) {
        console.error("adminRevokeApiKey failed:", err);
        res.status(500).json({
          success: false,
          error: "internal_error",
          message: "Failed to revoke API key.",
        });
      }
    },
  );

  return router;
}
