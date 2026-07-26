import { Router } from "express";
import { Op } from "sequelize";
import { hashPassword } from "../lib/auth/password.js";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { serializeUser } from "../lib/auth/serialize-user.js";
import { OriginalUpload, Role, User } from "../lib/models/index.js";
import { syncVideoIndex } from "../lib/search.js";

/**
 * Minimum accepted password length for admin password resets.
 *
 * @type {number}
 */
const MIN_PASSWORD_LENGTH = 8;

/**
 * Maximum page size for adminListUsers.
 *
 * @type {number}
 */
const MAX_LIST_LIMIT = 100;

/**
 * Body keys that must never be accepted on adminUpdateUser (use password reset).
 *
 * @type {string[]}
 */
const PASSWORD_BODY_KEYS = ["password", "passwordHash", "newPassword"];

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
 * Parses pagination query params for adminListUsers.
 *
 * @param {unknown} rawLimit Query `limit` value.
 * @param {unknown} rawOffset Query `offset` value.
 * @returns {{ok: true, limit: number, offset: number}|{ok: false, message: string}}
 *   Parsed pagination or a validation error.
 */
function parsePagination(rawLimit, rawOffset) {
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return { ok: false, message: "limit is required." };
  }
  const limit = Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, message: "limit must be a positive integer." };
  }
  if (limit > MAX_LIST_LIMIT) {
    return {
      ok: false,
      message: `limit must be at most ${MAX_LIST_LIMIT}.`,
    };
  }

  const offsetRaw =
    rawOffset === undefined || rawOffset === null || rawOffset === ""
      ? 0
      : Number(rawOffset);
  if (!Number.isInteger(offsetRaw) || offsetRaw < 0) {
    return { ok: false, message: "offset must be a non-negative integer." };
  }

  return { ok: true, limit, offset: offsetRaw };
}

/**
 * Serializes a user for admin responses: public profile plus timestamps.
 * Never includes passwordHash.
 *
 * @param {import('sequelize').Model} user User instance (preferably with Role).
 * @returns {ReturnType<typeof serializeUser> & {createdAt: Date, updatedAt: Date}}
 *   Admin user payload.
 */
function serializeAdminUser(user) {
  return {
    ...serializeUser(user),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Re-syncs search documents for all of a user's videos after a
 * username/displayName change, since eligible documents embed those fields.
 * Fire-and-forget: `syncVideoIndex` never throws, so callers don't need to
 * await or catch this.
 *
 * @param {number} userId Owning USERS id whose videos need re-indexing.
 * @returns {Promise<void>} Resolves once every video has been (re)synced.
 */
async function resyncUserVideoIndex(userId) {
  const uploads = await OriginalUpload.findAll({
    where: { userId },
    attributes: ["id"],
  });
  for (const upload of uploads) {
    syncVideoIndex(upload.id);
  }
}

/**
 * Coerces a body value to a boolean, or returns null when invalid.
 *
 * @param {unknown} raw Body field value.
 * @returns {boolean|null} Parsed boolean, or null when not a boolean.
 */
function parseBoolean(raw) {
  if (typeof raw === "boolean") {
    return raw;
  }
  return null;
}

/**
 * Builds a partial User update from an admin PATCH body.
 *
 * @param {Record<string, unknown>} body Request body.
 * @returns {Promise<
 *   | {ok: true, patch: Record<string, unknown>, role?: import('sequelize').Model}
 *   | {ok: false, error: string, message: string}
 * >} Parsed patch, or a validation error.
 */
async function parseAdminUserUpdate(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return {
      ok: false,
      error: "invalid_body",
      message: "Request body must be a JSON object.",
    };
  }

  for (const key of PASSWORD_BODY_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      return {
        ok: false,
        error: "invalid_body",
        message:
          "Password cannot be changed via this endpoint; use POST /admin/users/:id/password.",
      };
    }
  }

  /** @type {Record<string, unknown>} */
  const patch = {};
  /** @type {import('sequelize').Model|undefined} */
  let role;

  if (Object.prototype.hasOwnProperty.call(body, "username")) {
    const username = String(body.username ?? "").trim();
    if (!username) {
      return {
        ok: false,
        error: "invalid_body",
        message: "username must be a non-empty string.",
      };
    }
    if (username.length > 255) {
      return {
        ok: false,
        error: "invalid_body",
        message: "username must be at most 255 characters.",
      };
    }
    patch.username = username;
  }

  if (Object.prototype.hasOwnProperty.call(body, "email")) {
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!email) {
      return {
        ok: false,
        error: "invalid_body",
        message: "email must be a non-empty string.",
      };
    }
    if (email.length > 255) {
      return {
        ok: false,
        error: "invalid_body",
        message: "email must be at most 255 characters.",
      };
    }
    patch.email = email;
  }

  if (Object.prototype.hasOwnProperty.call(body, "displayName")) {
    if (body.displayName === null) {
      patch.displayName = null;
    } else {
      const displayName = String(body.displayName).trim() || null;
      if (displayName && displayName.length > 255) {
        return {
          ok: false,
          error: "invalid_body",
          message: "displayName must be at most 255 characters.",
        };
      }
      patch.displayName = displayName;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "bio")) {
    if (body.bio === null) {
      patch.bio = null;
    } else {
      const bio = String(body.bio);
      if (bio.length > 5000) {
        return {
          ok: false,
          error: "invalid_body",
          message: "bio must be at most 5000 characters.",
        };
      }
      patch.bio = bio;
    }
  }

  if (Object.prototype.hasOwnProperty.call(body, "emailVerified")) {
    const emailVerified = parseBoolean(body.emailVerified);
    if (emailVerified === null) {
      return {
        ok: false,
        error: "invalid_body",
        message: "emailVerified must be a boolean.",
      };
    }
    patch.emailVerified = emailVerified;
    patch.emailVerifiedAt = emailVerified ? new Date() : null;
  }

  if (Object.prototype.hasOwnProperty.call(body, "passwordExpired")) {
    const passwordExpired = parseBoolean(body.passwordExpired);
    if (passwordExpired === null) {
      return {
        ok: false,
        error: "invalid_body",
        message: "passwordExpired must be a boolean.",
      };
    }
    patch.passwordExpired = passwordExpired;
  }

  if (Object.prototype.hasOwnProperty.call(body, "uploader")) {
    const uploader = parseBoolean(body.uploader);
    if (uploader === null) {
      return {
        ok: false,
        error: "invalid_body",
        message: "uploader must be a boolean.",
      };
    }
    patch.uploader = uploader;
  }

  if (Object.prototype.hasOwnProperty.call(body, "role")) {
    if (body.role === null) {
      patch.roleId = null;
    } else {
      const roleName = String(body.role ?? "").trim();
      if (!roleName) {
        return {
          ok: false,
          error: "invalid_body",
          message: "role must be a non-empty role name or null.",
        };
      }
      role = await Role.findOne({ where: { name: roleName } });
      if (!role) {
        return {
          ok: false,
          error: "invalid_body",
          message: `Unknown role "${roleName}".`,
        };
      }
      patch.roleId = role.id;
    }
  }

  if (Object.keys(patch).length === 0) {
    return {
      ok: false,
      error: "invalid_body",
      message:
        "At least one of username, email, displayName, bio, emailVerified, passwordExpired, uploader, or role is required.",
    };
  }

  return { ok: true, patch, role };
}

/**
 * Builds the admin user-management router (list, update, password reset).
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createAdminUsersRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Lists all users with roles, paginated by limit/offset.
   * GET /api/v1/admin/users?limit=&offset=
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/users:
   *   get:
   *     tags: [Admin]
   *     summary: List users (paginated)
   *     operationId: adminListUsers
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - name: limit
   *         in: query
   *         required: true
   *         schema:
   *           type: integer
   *           minimum: 1
   *           maximum: 100
   *       - name: offset
   *         in: query
   *         required: false
   *         schema:
   *           type: integer
   *           minimum: 0
   *           default: 0
   *     responses:
   *       200:
   *         description: Paginated user list
   *       400:
   *         description: Invalid pagination query
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with items/total/limit/offset, or error.
   */
  router.get("/admin/users", requireAuth, requireAdmin, async (req, res) => {
    const pagination = parsePagination(req.query.limit, req.query.offset);
    if (!pagination.ok) {
      res.status(400).json({
        error: "invalid_query",
        message: pagination.message,
      });
      return;
    }

    try {
      const { rows, count } = await User.findAndCountAll({
        include: [{ model: Role, required: false }],
        order: [["id", "ASC"]],
        limit: pagination.limit,
        offset: pagination.offset,
      });

      res.status(200).json({
        items: rows.map(serializeAdminUser),
        total: count,
        limit: pagination.limit,
        offset: pagination.offset,
      });
    } catch (err) {
      console.error("adminListUsers failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list users.",
      });
    }
  });

  /**
   * Updates a user's profile fields and/or role. Does not change passwords.
   * PATCH /api/v1/admin/users/:id
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/users/{id}:
   *   patch:
   *     tags: [Admin]
   *     summary: Update a user's profile or role
   *     operationId: adminUpdateUser
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: integer
   *           minimum: 1
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
   *               username: { type: string }
   *               email: { type: string }
   *               displayName: { type: string, nullable: true }
   *               bio: { type: string, nullable: true }
   *               emailVerified: { type: boolean }
   *               passwordExpired: { type: boolean }
   *               uploader: { type: boolean }
   *               role: { type: string, nullable: true }
   *     responses:
   *       200:
   *         description: Updated user profile
   *       400:
   *         description: Invalid body or id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: User not found
   *       409:
   *         description: Username or email conflict
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with updated user, or error.
   */
  router.patch(
    "/admin/users/:id",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const userId = parsePositiveInt(req.params.id);
      if (userId === null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const parsed = await parseAdminUserUpdate(req.body || {});
      if (!parsed.ok) {
        res.status(400).json({
          error: parsed.error,
          message: parsed.message,
        });
        return;
      }

      try {
        const user = await User.findByPk(userId, {
          include: [{ model: Role, required: false }],
        });
        if (!user) {
          res.status(404).json({
            error: "not_found",
            message: "User not found.",
          });
          return;
        }

        const conflictClauses = [];
        if (parsed.patch.username !== undefined) {
          conflictClauses.push({ username: parsed.patch.username });
        }
        if (parsed.patch.email !== undefined) {
          conflictClauses.push({ email: parsed.patch.email });
        }
        if (conflictClauses.length > 0) {
          const duplicate = await User.findOne({
            where: {
              id: { [Op.ne]: userId },
              [Op.or]: conflictClauses,
            },
          });
          if (duplicate) {
            res.status(409).json({
              error: "conflict",
              message: "Username or email is already registered.",
            });
            return;
          }
        }

        await user.update(parsed.patch);

        if (
          Object.prototype.hasOwnProperty.call(parsed.patch, "username") ||
          Object.prototype.hasOwnProperty.call(parsed.patch, "displayName")
        ) {
          resyncUserVideoIndex(userId);
        }

        if (parsed.role) {
          user.Role = parsed.role;
        } else if (Object.prototype.hasOwnProperty.call(parsed.patch, "roleId")) {
          if (parsed.patch.roleId === null) {
            user.Role = null;
          } else {
            const loaded = await Role.findByPk(parsed.patch.roleId);
            user.Role = loaded;
          }
        } else {
          await user.reload({
            include: [{ model: Role, required: false }],
          });
        }

        res.status(200).json(serializeAdminUser(user));
      } catch (err) {
        console.error("adminUpdateUser failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to update user.",
        });
      }
    },
  );

  /**
   * Resets a user's password and marks it expired so they must change it.
   * POST /api/v1/admin/users/:id/password with { newPassword }.
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/users/{id}/password:
   *   post:
   *     tags: [Admin]
   *     summary: Reset a user's password
   *     operationId: adminResetUserPassword
   *     parameters:
   *       - $ref: '#/components/parameters/CsrfTokenHeader'
   *       - name: id
   *         in: path
   *         required: true
   *         schema:
   *           type: integer
   *           minimum: 1
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             required: [newPassword]
   *             properties:
   *               newPassword: { type: string, minLength: 8 }
   *     responses:
   *       204:
   *         description: Password reset; user must change it on next use
   *       400:
   *         description: Invalid body or id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: User not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 204 or an error response.
   */
  router.post(
    "/admin/users/:id/password",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        const userId = parsePositiveInt(req.params.id);
        if (userId === null) {
          res.status(400).json({
            error: "invalid_id",
            message: "id must be a positive integer.",
          });
          return;
        }

        const newPassword = String(req.body?.newPassword || "");
        if (!newPassword) {
          res.status(400).json({
            error: "invalid_body",
            message: "newPassword is required.",
          });
          return;
        }

        if (newPassword.length < MIN_PASSWORD_LENGTH) {
          res.status(400).json({
            error: "invalid_password",
            message: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
          });
          return;
        }

        const user = await User.findByPk(userId);
        if (!user) {
          res.status(404).json({
            error: "not_found",
            message: "User not found.",
          });
          return;
        }

        const passwordHash = await hashPassword(newPassword);
        await user.update({
          passwordHash,
          passwordExpired: true,
        });
        res.status(204).end();
      } catch (err) {
        console.error("adminResetUserPassword failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to reset user password.",
        });
      }
    },
  );

  return router;
}
