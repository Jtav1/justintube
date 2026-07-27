import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { RESOLUTION_VALUES } from "../lib/models/constants.js";
import { TranscodeProfile, User } from "../lib/models/index.js";
import { serializeUserRef } from "../lib/serialize-user-ref.js";

/**
 * Maximum length for transcode profile description.
 *
 * @type {number}
 */
const MAX_DESCRIPTION_LENGTH = 250;

/**
 * Maximum length for container/codec token fields.
 *
 * @type {number}
 */
const MAX_TOKEN_LENGTH = 32;

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
 * Serializes a TranscodeProfile row for admin JSON responses.
 *
 * @param {import('sequelize').Model} row TranscodeProfile instance.
 * @returns {{
 *   id: number,
 *   description: string|null,
 *   resolutionName: string,
 *   outputHeight: number,
 *   outputWidth: number,
 *   outputContainer: string,
 *   videoCodec: string,
 *   audioCodec: string,
 *   creator: {userId: number|null, username: string|null, displayName: string|null},
 *   createdAt: Date,
 *   updatedAt: Date
 * }} Public profile payload.
 */
function serializeTranscodeProfile(row) {
  return {
    id: row.id,
    description: row.description ?? null,
    resolutionName: row.resolutionName,
    outputHeight: row.outputHeight,
    outputWidth: row.outputWidth,
    outputContainer: row.outputContainer,
    videoCodec: row.videoCodec,
    audioCodec: row.audioCodec,
    creator: serializeUserRef(row.creatorUserId, row.Creator?.username, row.Creator?.displayName),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Parses an optional description field.
 *
 * @param {unknown} raw Body description value.
 * @returns {{ok: true, value: string|null}|{ok: false, message: string}}
 *   Parsed description or error.
 */
function parseDescription(raw) {
  if (raw === null) {
    return { ok: true, value: null };
  }
  const description = String(raw);
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    return {
      ok: false,
      message: `description must be at most ${MAX_DESCRIPTION_LENGTH} characters.`,
    };
  }
  return { ok: true, value: description };
}

/**
 * Parses resolutionName against RESOLUTION_VALUES.
 *
 * @param {unknown} raw Body resolutionName value.
 * @param {boolean} required Whether the field is required.
 * @returns {{ok: true, value?: string}|{ok: false, message: string}}
 *   Parsed value or error.
 */
function parseResolutionName(raw, required) {
  if (raw === undefined) {
    if (required) {
      return { ok: false, message: "resolutionName is required." };
    }
    return { ok: true };
  }
  const resolutionName = String(raw ?? "").trim();
  if (!RESOLUTION_VALUES.includes(resolutionName)) {
    return {
      ok: false,
      message: `resolutionName must be one of: ${RESOLUTION_VALUES.join(", ")}.`,
    };
  }
  return { ok: true, value: resolutionName };
}

/**
 * Parses a required/optional positive integer dimension or user id.
 *
 * @param {unknown} raw Body field value.
 * @param {string} fieldName Field name for error messages.
 * @param {boolean} required Whether the field is required.
 * @param {{allowNull?: boolean}} [options] Allow null when not required.
 * @returns {{ok: true, value?: number|null}|{ok: false, message: string}}
 *   Parsed value or error.
 */
function parseOptionalPositiveInt(raw, fieldName, required, options = {}) {
  if (raw === undefined) {
    if (required) {
      return { ok: false, message: `${fieldName} is required.` };
    }
    return { ok: true };
  }
  if (options.allowNull && raw === null) {
    return { ok: true, value: null };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    return {
      ok: false,
      message: `${fieldName} must be a positive integer.`,
    };
  }
  return { ok: true, value: n };
}

/**
 * Parses a non-empty codec/container token string.
 *
 * @param {unknown} raw Body field value.
 * @param {string} fieldName Field name for error messages.
 * @param {boolean} required Whether the field is required.
 * @returns {{ok: true, value?: string}|{ok: false, message: string}}
 *   Parsed value or error.
 */
function parseToken(raw, fieldName, required) {
  if (raw === undefined) {
    if (required) {
      return { ok: false, message: `${fieldName} is required.` };
    }
    return { ok: true };
  }
  const value = String(raw ?? "").trim();
  if (!value) {
    return {
      ok: false,
      message: `${fieldName} must be a non-empty string.`,
    };
  }
  if (value.length > MAX_TOKEN_LENGTH) {
    return {
      ok: false,
      message: `${fieldName} must be at most ${MAX_TOKEN_LENGTH} characters.`,
    };
  }
  return { ok: true, value };
}

/**
 * Builds create or partial-update fields for a transcode profile.
 *
 * @param {Record<string, unknown>} body Request body.
 * @param {{required: boolean, defaultCreatorUserId?: number|null}} options
 *   Create mode requires all core fields; update is partial.
 * @returns {{ok: true, patch: Record<string, unknown>}|{ok: false, message: string}}
 *   Parsed fields or a validation error.
 */
function parseTranscodeProfileBody(body, options) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be a JSON object." };
  }

  const required = options.required;
  /** @type {Record<string, unknown>} */
  const patch = {};

  if (required || Object.prototype.hasOwnProperty.call(body, "description")) {
    if (Object.prototype.hasOwnProperty.call(body, "description")) {
      const description = parseDescription(body.description);
      if (!description.ok) {
        return description;
      }
      patch.description = description.value;
    } else if (required) {
      patch.description = null;
    }
  }

  const resolution = parseResolutionName(
    Object.prototype.hasOwnProperty.call(body, "resolutionName")
      ? body.resolutionName
      : undefined,
    required,
  );
  if (!resolution.ok) {
    return resolution;
  }
  if (resolution.value !== undefined) {
    patch.resolutionName = resolution.value;
  }

  const height = parseOptionalPositiveInt(
    Object.prototype.hasOwnProperty.call(body, "outputHeight")
      ? body.outputHeight
      : undefined,
    "outputHeight",
    required,
  );
  if (!height.ok) {
    return height;
  }
  if (height.value !== undefined) {
    patch.outputHeight = height.value;
  }

  const width = parseOptionalPositiveInt(
    Object.prototype.hasOwnProperty.call(body, "outputWidth")
      ? body.outputWidth
      : undefined,
    "outputWidth",
    required,
  );
  if (!width.ok) {
    return width;
  }
  if (width.value !== undefined) {
    patch.outputWidth = width.value;
  }

  const container = parseToken(
    Object.prototype.hasOwnProperty.call(body, "outputContainer")
      ? body.outputContainer
      : undefined,
    "outputContainer",
    required,
  );
  if (!container.ok) {
    return container;
  }
  if (container.value !== undefined) {
    patch.outputContainer = container.value;
  }

  const videoCodec = parseToken(
    Object.prototype.hasOwnProperty.call(body, "videoCodec")
      ? body.videoCodec
      : undefined,
    "videoCodec",
    required,
  );
  if (!videoCodec.ok) {
    return videoCodec;
  }
  if (videoCodec.value !== undefined) {
    patch.videoCodec = videoCodec.value;
  }

  const audioCodec = parseToken(
    Object.prototype.hasOwnProperty.call(body, "audioCodec")
      ? body.audioCodec
      : undefined,
    "audioCodec",
    required,
  );
  if (!audioCodec.ok) {
    return audioCodec;
  }
  if (audioCodec.value !== undefined) {
    patch.audioCodec = audioCodec.value;
  }

  if (Object.prototype.hasOwnProperty.call(body, "creatorUserId")) {
    const creator = parseOptionalPositiveInt(
      body.creatorUserId,
      "creatorUserId",
      false,
      { allowNull: true },
    );
    if (!creator.ok) {
      return creator;
    }
    patch.creatorUserId = creator.value ?? null;
  } else if (required) {
    patch.creatorUserId =
      options.defaultCreatorUserId === undefined
        ? null
        : options.defaultCreatorUserId;
  }

  if (!required && Object.keys(patch).length === 0) {
    return {
      ok: false,
      message:
        "At least one of description, resolutionName, outputHeight, outputWidth, outputContainer, videoCodec, audioCodec, or creatorUserId is required.",
    };
  }

  return { ok: true, patch };
}

/**
 * Builds the admin transcode-profile CRUD router.
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createTranscodeProfilesRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Lists all transcode profiles.
   * GET /api/v1/admin/transcode-profiles
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/transcode-profiles:
   *   get:
   *     tags: [Admin]
   *     summary: List transcode profiles
   *     operationId: adminListTranscodeProfiles
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Transcode profile list
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with `{ items }`, or error.
   */
  router.get(
    "/admin/transcode-profiles",
    requireAuth,
    requireAdmin,
    async (_req, res) => {
      try {
        const rows = await TranscodeProfile.findAll({
          include: [{ model: User, as: "Creator", required: false }],
          order: [["id", "ASC"]],
        });
        res.status(200).json({
          items: rows.map(serializeTranscodeProfile),
        });
      } catch (err) {
        console.error("adminListTranscodeProfiles failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to list transcode profiles.",
        });
      }
    },
  );

  /**
   * Creates a new transcode profile.
   * POST /api/v1/admin/transcode-profiles
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/transcode-profiles:
   *   post:
   *     tags: [Admin]
   *     summary: Create a transcode profile
   *     operationId: adminCreateTranscodeProfile
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
   *             required:
   *               - resolutionName
   *               - outputHeight
   *               - outputWidth
   *               - outputContainer
   *               - videoCodec
   *               - audioCodec
   *             properties:
   *               description: { type: string, nullable: true, maxLength: 250 }
   *               resolutionName:
   *                 type: string
   *                 enum: [240p, 360p, 480p, 720p, 1080p, 2kHD, 4kHD]
   *               outputHeight: { type: integer, minimum: 1 }
   *               outputWidth: { type: integer, minimum: 1 }
   *               outputContainer: { type: string }
   *               videoCodec: { type: string }
   *               audioCodec: { type: string }
   *               creatorUserId: { type: integer, nullable: true, minimum: 1 }
   *     responses:
   *       201:
   *         description: Created profile
   *       400:
   *         description: Invalid body
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 201 with created profile, or error.
   */
  router.post(
    "/admin/transcode-profiles",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const parsed = parseTranscodeProfileBody(req.body || {}, {
        required: true,
        defaultCreatorUserId: req.user?.id ?? null,
      });
      if (!parsed.ok) {
        res.status(400).json({
          error: "invalid_body",
          message: parsed.message,
        });
        return;
      }

      try {
        const created = await TranscodeProfile.create(parsed.patch);
        const row = await TranscodeProfile.findByPk(created.id, {
          include: [{ model: User, as: "Creator", required: false }],
        });
        res.status(201).json(serializeTranscodeProfile(row));
      } catch (err) {
        console.error("adminCreateTranscodeProfile failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to create transcode profile.",
        });
      }
    },
  );

  /**
   * Partially updates a transcode profile.
   * PATCH /api/v1/admin/transcode-profiles/:id
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/transcode-profiles/{id}:
   *   patch:
   *     tags: [Admin]
   *     summary: Update a transcode profile
   *     operationId: adminUpdateTranscodeProfile
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
   *               description: { type: string, nullable: true, maxLength: 250 }
   *               resolutionName:
   *                 type: string
   *                 enum: [240p, 360p, 480p, 720p, 1080p, 2kHD, 4kHD]
   *               outputHeight: { type: integer, minimum: 1 }
   *               outputWidth: { type: integer, minimum: 1 }
   *               outputContainer: { type: string }
   *               videoCodec: { type: string }
   *               audioCodec: { type: string }
   *               creatorUserId: { type: integer, nullable: true, minimum: 1 }
   *     responses:
   *       200:
   *         description: Updated profile
   *       400:
   *         description: Invalid body or id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: Profile not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with updated profile, or error.
   */
  router.patch(
    "/admin/transcode-profiles/:id",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === null) {
        res.status(400).json({
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      const parsed = parseTranscodeProfileBody(req.body || {}, {
        required: false,
      });
      if (!parsed.ok) {
        res.status(400).json({
          error: "invalid_body",
          message: parsed.message,
        });
        return;
      }

      try {
        const row = await TranscodeProfile.findByPk(id, {
          include: [{ model: User, as: "Creator", required: false }],
        });
        if (!row) {
          res.status(404).json({
            error: "not_found",
            message: "Transcode profile not found.",
          });
          return;
        }

        await row.update(parsed.patch);
        await row.reload();
        res.status(200).json(serializeTranscodeProfile(row));
      } catch (err) {
        console.error("adminUpdateTranscodeProfile failed:", err);
        res.status(500).json({
          error: "internal_error",
          message: "Failed to update transcode profile.",
        });
      }
    },
  );

  /**
   * Deletes a transcode profile by id.
   * DELETE /api/v1/admin/transcode-profiles/:id
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/transcode-profiles/{id}:
   *   delete:
   *     tags: [Admin]
   *     summary: Delete a transcode profile
   *     operationId: adminDeleteTranscodeProfile
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
   *     responses:
   *       200:
   *         description: Profile deleted
   *       400:
   *         description: Invalid id
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: Profile not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 `{ success: true }`, or error.
   */
  router.delete(
    "/admin/transcode-profiles/:id",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const id = parsePositiveInt(req.params.id);
      if (id === null) {
        res.status(400).json({
          success: false,
          error: "invalid_id",
          message: "id must be a positive integer.",
        });
        return;
      }

      try {
        const row = await TranscodeProfile.findByPk(id);
        if (!row) {
          res.status(404).json({
            success: false,
            error: "not_found",
            message: "Transcode profile not found.",
          });
          return;
        }

        await row.destroy();
        res.status(200).json({ success: true });
      } catch (err) {
        console.error("adminDeleteTranscodeProfile failed:", err);
        res.status(500).json({
          success: false,
          error: "internal_error",
          message: "Failed to delete transcode profile.",
        });
      }
    },
  );

  return router;
}
