import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { Router } from "express";
import multer from "multer";
import { Op } from "sequelize";
import { csrfProtection } from "../lib/auth/csrf.js";
import { optionalAuth, requireAuth } from "../lib/auth/require-auth.js";
import { mimeTypeForImage } from "../lib/media-meta.js";
import { Theme, User, sequelize } from "../lib/models/index.js";
import { HEX_COLOR_PATTERN, PUBLIC_THEME_OWNER } from "../lib/models/theme.js";
import { streamFileWithRangeSupport } from "../lib/range-stream.js";
import { resolveSitedataPath } from "../lib/sitedata-meta.js";
import { isAdmin } from "../lib/video-access.js";

/**
 * Absolute path to the directory where theme background images are stored
 * (`SITEDATA_STORAGE_DIRECTORY/themes`).
 *
 * @type {string}
 */
const themesDir = resolveSitedataPath("themes");

// Ensure the themes directory exists before any upload is attempted.
mkdirSync(themesDir, { recursive: true });

/**
 * Set of allowed lowercase theme image file extensions (without a leading
 * dot), parsed from the THEME_IMAGE_FILETYPES_ALLOWED env var.
 *
 * @type {Set<string>}
 */
const allowedThemeImageExtensions = new Set(
  (process.env.THEME_IMAGE_FILETYPES_ALLOWED || "jpg,jpeg,png,webp")
    .split(",")
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean),
);

/**
 * Maximum accepted theme image upload size in bytes. Defaults to 5 MiB;
 * override with the MAX_THEME_IMAGE_SIZE_BYTES env var.
 *
 * @type {number}
 */
const maxThemeImageSizeBytes =
  Number(process.env.MAX_THEME_IMAGE_SIZE_BYTES) || 5 * 1024 * 1024;

/**
 * Maps each background image slot to its multer field name and the THEMES
 * column that stores its filename.
 *
 * @type {Record<string, {field: string, column: string}>}
 */
const IMAGE_SLOTS = {
  header: { field: "headerBackground", column: "headerBackgroundFilename" },
  sidebar: { field: "sidebarBackground", column: "sidebarBackgroundFilename" },
  view: { field: "viewBackground", column: "viewBackgroundFilename" },
  footer: { field: "footerBackground", column: "footerBackgroundFilename" },
};

/**
 * Normalizes a file's extension to a lowercase value without the leading dot.
 *
 * @private
 * @param {string} filename Original client-provided filename.
 * @returns {string} Lowercase extension without a dot (empty string if none).
 */
function normalizedThemeImageExtension(filename) {
  return extname(filename).toLowerCase().replace(/^\./, "");
}

/**
 * Multer storage engine that writes theme background uploads to `themes/`
 * under the sitedata root using a freshly generated UUID as the filename
 * (preserving the original extension).
 */
const themeImageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, themesDir),
  filename: (_req, file, cb) => {
    const ext = normalizedThemeImageExtension(file.originalname);
    cb(null, ext ? `${randomUUID()}.${ext}` : randomUUID());
  },
});

/**
 * Multer file filter that rejects any file whose extension is not present in
 * THEME_IMAGE_FILETYPES_ALLOWED.
 *
 * @private
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {Express.Multer.File} file File metadata provided by multer.
 * @param {multer.FileFilterCallback} cb Callback signaling acceptance/rejection.
 * @returns {void} Invokes `cb` with the filter decision.
 */
function themeImageFileFilter(_req, file, cb) {
  const ext = normalizedThemeImageExtension(file.originalname);
  if (!allowedThemeImageExtensions.has(ext)) {
    const error = new Error(`File type ".${ext}" is not allowed.`);
    error.code = "UNSUPPORTED_FILE_TYPE";
    cb(error);
    return;
  }
  cb(null, true);
}

const themeImageUpload = multer({
  storage: themeImageStorage,
  fileFilter: themeImageFileFilter,
  limits: { fileSize: maxThemeImageSizeBytes },
});

/**
 * Multer middleware accepting the 4 optional background image slots on
 * create/update requests.
 */
const themeImageFields = themeImageUpload.fields(
  Object.values(IMAGE_SLOTS).map(({ field }) => ({ name: field, maxCount: 1 })),
);

/**
 * Express error-handling middleware that maps theme-image-upload multer
 * errors to JSON responses, mirroring `avatarUploadErrorHandler` in
 * `routes/me.js`.
 *
 * @param {Error} err Error thrown during theme image upload handling.
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Passes non-upload errors along.
 * @returns {void} Sends an error JSON response or delegates via `next`.
 */
function themeImageUploadErrorHandler(err, _req, res, next) {
  if (err?.code === "UNSUPPORTED_FILE_TYPE") {
    res.status(400).json({
      error: "unsupported_file_type",
      message: err.message,
      allowed: [...allowedThemeImageExtensions],
    });
    return;
  }
  if (err instanceof multer.MulterError) {
    const isTooLarge = err.code === "LIMIT_FILE_SIZE";
    res.status(isTooLarge ? 413 : 400).json({
      error: isTooLarge ? "file_too_large" : "upload_error",
      message: err.message,
    });
    return;
  }
  next(err);
}

/**
 * Deletes every file multer saved for this request (best-effort), used to
 * clean up after a request fails validation/authorization/persistence once
 * files have already landed on disk.
 *
 * @param {import('express').Request} req Incoming request (`req.files` set by multer.fields).
 * @returns {Promise<void>} Resolves once all unlink attempts settle.
 */
async function cleanupUploadedFiles(req) {
  const files = req.files || {};
  const paths = Object.values(files)
    .flat()
    .map((file) => join(themesDir, file.filename));
  await Promise.allSettled(paths.map((path) => unlink(path).catch(() => {})));
}

/**
 * Maximum length for a theme name.
 *
 * @type {number}
 */
const MAX_NAME_LENGTH = 255;

/**
 * Maximum length for a theme description.
 *
 * @type {number}
 */
const MAX_DESCRIPTION_LENGTH = 2000;

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
 * Interprets a multipart/form-data string field as a boolean.
 *
 * @param {unknown} raw Form field value (always a string when present, since
 *   multipart fields are not JSON-typed).
 * @returns {boolean} True for `"true"`/`"1"`, false otherwise.
 */
function parseBooleanish(raw) {
  return raw === true || raw === "true" || raw === "1" || raw === 1;
}

/**
 * Returns whether the caller owns the theme or is an admin. Only an admin
 * may modify a `"public"` theme, since no user owns it.
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user.
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @param {import('sequelize').Model} theme THEMES row.
 * @returns {boolean} Whether the caller may update/delete this theme.
 */
function isThemeOwnerOrAdmin(user, role, theme) {
  if (isAdmin(role)) {
    return true;
  }
  if (!user || theme.themeOwner === PUBLIC_THEME_OWNER) {
    return false;
  }
  return String(user.id) === theme.themeOwner;
}

/**
 * Returns whether the caller may select this theme for their own account.
 * Public themes are selectable by anyone; user-owned themes only by their
 * owner (or an admin).
 *
 * @param {import('sequelize').Model|null|undefined} user Authenticated user.
 * @param {import('sequelize').Model|null|undefined} role Authenticated role.
 * @param {import('sequelize').Model} theme THEMES row.
 * @returns {boolean} Whether the caller may set this as their theme.
 */
function isThemeSelectable(user, role, theme) {
  if (theme.themeOwner === PUBLIC_THEME_OWNER || isAdmin(role)) {
    return true;
  }
  return Boolean(user) && String(user.id) === theme.themeOwner;
}

/**
 * Serializes a Theme row for API responses.
 *
 * @param {import('sequelize').Model} row Theme instance.
 * @returns {{
 *   id: number,
 *   name: string,
 *   description: string|null,
 *   colors: {color1: string, color2: string, color3: string, color4: string, color5: string},
 *   images: {
 *     headerBackgroundUrl: string|null,
 *     sidebarBackgroundUrl: string|null,
 *     viewBackgroundUrl: string|null,
 *     footerBackgroundUrl: string|null
 *   },
 *   themeOwner: string,
 *   isDefault: boolean,
 *   createdAt: Date,
 *   updatedAt: Date
 * }} Public theme payload.
 */
function serializeTheme(row) {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    colors: {
      color1: row.color1,
      color2: row.color2,
      color3: row.color3,
      color4: row.color4,
      color5: row.color5,
    },
    images: {
      headerBackgroundUrl: row.headerBackgroundFilename
        ? `/api/v1/themes/${row.id}/images/header`
        : null,
      sidebarBackgroundUrl: row.sidebarBackgroundFilename
        ? `/api/v1/themes/${row.id}/images/sidebar`
        : null,
      viewBackgroundUrl: row.viewBackgroundFilename
        ? `/api/v1/themes/${row.id}/images/view`
        : null,
      footerBackgroundUrl: row.footerBackgroundFilename
        ? `/api/v1/themes/${row.id}/images/footer`
        : null,
    },
    themeOwner: row.themeOwner,
    isDefault: Boolean(row.isDefault),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Parses an optional/required theme name field.
 *
 * @param {unknown} raw Body name value.
 * @param {boolean} required Whether the field is required when present.
 * @returns {{ok: true, value?: string}|{ok: false, message: string}} Parsed or error.
 */
function parseName(raw, required) {
  if (raw === undefined) {
    if (required) {
      return { ok: false, message: "name is required." };
    }
    return { ok: true };
  }
  const name = String(raw ?? "").trim();
  if (!name) {
    return { ok: false, message: "name must be a non-empty string." };
  }
  if (name.length > MAX_NAME_LENGTH) {
    return { ok: false, message: `name must be at most ${MAX_NAME_LENGTH} characters.` };
  }
  return { ok: true, value: name };
}

/**
 * Parses an optional description field (null/empty clears).
 *
 * @param {unknown} raw Body description value.
 * @returns {{ok: true, value?: string|null}|{ok: false, message: string}} Parsed or error.
 */
function parseDescription(raw) {
  if (raw === undefined || raw === null || raw === "") {
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
 * Parses a required/optional 6-character hex color (no leading `#`).
 *
 * @param {unknown} raw Body color field value.
 * @param {string} fieldName Field name for error messages.
 * @param {boolean} required Whether the field is required.
 * @returns {{ok: true, value?: string}|{ok: false, message: string}} Parsed or error.
 */
function parseHexColor(raw, fieldName, required) {
  if (raw === undefined) {
    if (required) {
      return { ok: false, message: `${fieldName} is required.` };
    }
    return { ok: true };
  }
  const value = String(raw ?? "").trim();
  if (!HEX_COLOR_PATTERN.test(value)) {
    return {
      ok: false,
      message: `${fieldName} must be a 6-character hex color (e.g. "FFFFFF").`,
    };
  }
  return { ok: true, value: value.toUpperCase() };
}

/**
 * Builds create or partial-update fields for a theme from multipart form
 * fields (`name`, `description`, `color1`..`color5`). Ownership/default
 * flags (`system`, `isDefault`) are authorization-dependent and handled by
 * the route handlers directly, not here.
 *
 * @param {Record<string, unknown>} body Request body (multipart text fields).
 * @param {{required: boolean}} options Create requires all core fields; update is partial.
 * @returns {{ok: true, patch: Record<string, unknown>}|{ok: false, message: string}}
 *   Parsed fields or a validation error.
 */
function parseThemeBody(body, options) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, message: "Request body must be an object." };
  }

  const required = options.required;
  /** @type {Record<string, unknown>} */
  const patch = {};

  const name = parseName(body.name, required);
  if (!name.ok) {
    return name;
  }
  if (name.value !== undefined) {
    patch.name = name.value;
  }

  if (required || Object.prototype.hasOwnProperty.call(body, "description")) {
    const description = parseDescription(body.description);
    if (!description.ok) {
      return description;
    }
    patch.description = description.value;
  }

  for (const fieldName of ["color1", "color2", "color3", "color4", "color5"]) {
    const color = parseHexColor(body[fieldName], fieldName, required);
    if (!color.ok) {
      return color;
    }
    if (color.value !== undefined) {
      patch[fieldName] = color.value;
    }
  }

  return { ok: true, patch };
}

/**
 * Applies any uploaded background image files from `req.files` onto a
 * patch object, keyed by THEMES column name.
 *
 * @param {import('express').Request} req Incoming request (`req.files` set by multer.fields).
 * @param {Record<string, unknown>} patch Patch object to mutate in place.
 * @returns {void}
 */
function applyUploadedImages(req, patch) {
  for (const { field, column } of Object.values(IMAGE_SLOTS)) {
    const file = req.files?.[field]?.[0];
    if (file) {
      patch[column] = file.filename;
    }
  }
}

/**
 * Builds the theme browsing/CRUD router, plus the user theme-selection
 * routes (`PUT /me/theme`, `GET /users/:id/theme`).
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createThemesRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * GET /themes — listThemes
   * Auth: optional. Anonymous callers see public themes only. Authenticated
   * non-admins additionally see their own themes. Admins see every theme.
   * Authenticated callers also get `selectedThemeId`: their own `themeId`,
   * or (when unset) the id of the theme marked `isDefault`.
   *
   * @openapi
   * /api/v1/themes:
   *   get:
   *     tags: [Themes]
   *     summary: List themes
   *     operationId: listThemes
   *     responses:
   *       "200":
   *         description: Theme list
   */
  router.get("/themes", optionalAuth, async (req, res) => {
    try {
      let where = { themeOwner: PUBLIC_THEME_OWNER };
      if (req.user && isAdmin(req.authRole)) {
        where = undefined;
      } else if (req.user) {
        where = {
          [Op.or]: [{ themeOwner: PUBLIC_THEME_OWNER }, { themeOwner: String(req.user.id) }],
        };
      }

      const rows = await Theme.findAll({ where, order: [["id", "ASC"]] });
      const response = { items: rows.map(serializeTheme) };

      if (req.user) {
        let selectedThemeId = req.user.themeId ?? null;
        if (selectedThemeId == null) {
          const defaultTheme = await Theme.findOne({ where: { isDefault: true } });
          selectedThemeId = defaultTheme ? defaultTheme.id : null;
        }
        response.selectedThemeId = selectedThemeId;
      }

      res.status(200).json(response);
    } catch (err) {
      console.error("listThemes failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to list themes.",
      });
    }
  });

  /**
   * POST /themes — createTheme
   * Auth: required. Any authenticated user may create a theme they own;
   * only an admin may set `system` (making it `"public"`) and/or
   * `isDefault` (only valid on a `"public"` theme).
   *
   * @openapi
   * /api/v1/themes:
   *   post:
   *     tags: [Themes]
   *     summary: Create a theme
   *     operationId: createTheme
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             required: [name, color1, color2, color3, color4, color5]
   *             properties:
   *               name: { type: string }
   *               description: { type: string, nullable: true }
   *               color1: { type: string }
   *               color2: { type: string }
   *               color3: { type: string }
   *               color4: { type: string }
   *               color5: { type: string }
   *               system: { type: string, description: "Admin-only: creates a public/system-wide theme." }
   *               isDefault: { type: string, description: "Admin-only: marks this public theme as the sitewide default." }
   *               headerBackground: { type: string, format: binary }
   *               sidebarBackground: { type: string, format: binary }
   *               viewBackground: { type: string, format: binary }
   *               footerBackground: { type: string, format: binary }
   *     responses:
   *       "201":
   *         description: Created theme
   *       "400":
   *         description: Invalid body
   *       "401":
   *         description: Unauthorized
   *       "403":
   *         description: Forbidden (non-admin attempted `system`/`isDefault`)
   */
  router.post("/themes", requireAuth, themeImageFields, async (req, res) => {
    try {
      const parsed = parseThemeBody(req.body || {}, { required: true });
      if (!parsed.ok) {
        await cleanupUploadedFiles(req);
        res.status(400).json({ error: "invalid_body", message: parsed.message });
        return;
      }

      const wantsSystem = parseBooleanish(req.body?.system);
      if (wantsSystem && !isAdmin(req.authRole)) {
        await cleanupUploadedFiles(req);
        res.status(403).json({
          error: "forbidden",
          message: "Only an admin can create a public theme.",
        });
        return;
      }

      const wantsDefault = parseBooleanish(req.body?.isDefault);
      if (wantsDefault && !isAdmin(req.authRole)) {
        await cleanupUploadedFiles(req);
        res.status(403).json({
          error: "forbidden",
          message: "Only an admin can set isDefault.",
        });
        return;
      }
      if (wantsDefault && !wantsSystem) {
        await cleanupUploadedFiles(req);
        res.status(400).json({
          error: "invalid_body",
          message: "isDefault can only be set on a public theme (system=true).",
        });
        return;
      }

      const patch = parsed.patch;
      patch.themeOwner = wantsSystem ? PUBLIC_THEME_OWNER : String(req.user.id);
      applyUploadedImages(req, patch);

      let created;
      if (wantsDefault) {
        created = await sequelize.transaction(async (transaction) => {
          await Theme.update(
            { isDefault: false },
            { where: { isDefault: true }, transaction },
          );
          return Theme.create({ ...patch, isDefault: true }, { transaction });
        });
      } else {
        created = await Theme.create(patch);
      }

      res.status(201).json(serializeTheme(created));
    } catch (err) {
      await cleanupUploadedFiles(req);
      console.error("createTheme failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to create theme.",
      });
    }
  });

  /**
   * PATCH /themes/:id — updateTheme
   * Auth: required. Owner or admin. `"public"` themes may only be updated
   * by an admin. `system: true` (admin-only) converts the theme to
   * `"public"`; there is no reverse conversion. `isDefault: true`
   * (admin-only) requires the theme to be (or become, via `system`)
   * `"public"`, and clears any prior default.
   *
   * @openapi
   * /api/v1/themes/{id}:
   *   patch:
   *     tags: [Themes]
   *     summary: Update a theme
   *     operationId: updateTheme
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     requestBody:
   *       required: true
   *       content:
   *         multipart/form-data:
   *           schema:
   *             type: object
   *             properties:
   *               name: { type: string }
   *               description: { type: string, nullable: true }
   *               color1: { type: string }
   *               color2: { type: string }
   *               color3: { type: string }
   *               color4: { type: string }
   *               color5: { type: string }
   *               system: { type: string }
   *               isDefault: { type: string }
   *               headerBackground: { type: string, format: binary }
   *               sidebarBackground: { type: string, format: binary }
   *               viewBackground: { type: string, format: binary }
   *               footerBackground: { type: string, format: binary }
   *     responses:
   *       "200":
   *         description: Updated theme
   *       "400":
   *         description: Invalid body or id
   *       "401":
   *         description: Unauthorized
   *       "403":
   *         description: Forbidden
   *       "404":
   *         description: Not found
   */
  router.patch("/themes/:id", requireAuth, themeImageFields, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        await cleanupUploadedFiles(req);
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      const row = await Theme.findByPk(id);
      if (!row) {
        await cleanupUploadedFiles(req);
        res.status(404).json({ error: "not_found", message: "Theme not found." });
        return;
      }

      if (!isThemeOwnerOrAdmin(req.user, req.authRole, row)) {
        await cleanupUploadedFiles(req);
        res.status(403).json({
          error: "forbidden",
          message: "Only the owner or an admin can update this theme.",
        });
        return;
      }

      const parsed = parseThemeBody(req.body || {}, { required: false });
      if (!parsed.ok) {
        await cleanupUploadedFiles(req);
        res.status(400).json({ error: "invalid_body", message: parsed.message });
        return;
      }
      const patch = parsed.patch;

      if (Object.prototype.hasOwnProperty.call(req.body || {}, "system")) {
        const wantsSystem = parseBooleanish(req.body.system);
        if (wantsSystem) {
          if (!isAdmin(req.authRole)) {
            await cleanupUploadedFiles(req);
            res.status(403).json({
              error: "forbidden",
              message: "Only an admin can convert a theme to public.",
            });
            return;
          }
          patch.themeOwner = PUBLIC_THEME_OWNER;
        }
      }

      if (Object.prototype.hasOwnProperty.call(req.body || {}, "isDefault")) {
        const wantsDefault = parseBooleanish(req.body.isDefault);
        if (wantsDefault) {
          if (!isAdmin(req.authRole)) {
            await cleanupUploadedFiles(req);
            res.status(403).json({
              error: "forbidden",
              message: "Only an admin can set isDefault.",
            });
            return;
          }
          const resultingOwner = patch.themeOwner ?? row.themeOwner;
          if (resultingOwner !== PUBLIC_THEME_OWNER) {
            await cleanupUploadedFiles(req);
            res.status(400).json({
              error: "invalid_body",
              message: "isDefault can only be set on a public theme.",
            });
            return;
          }
          patch.isDefault = true;
        } else {
          patch.isDefault = false;
        }
      }

      const previousFilenames = {};
      for (const { column } of Object.values(IMAGE_SLOTS)) {
        previousFilenames[column] = row[column];
      }
      applyUploadedImages(req, patch);

      if (Object.keys(patch).length === 0) {
        await cleanupUploadedFiles(req);
        res.status(400).json({
          error: "invalid_body",
          message:
            "At least one of name, description, color1-color5, system, isDefault, or a background image is required.",
        });
        return;
      }

      if (patch.isDefault === true) {
        await sequelize.transaction(async (transaction) => {
          await Theme.update(
            { isDefault: false },
            { where: { isDefault: true }, transaction },
          );
          await row.update(patch, { transaction });
        });
      } else {
        await row.update(patch);
      }
      await row.reload();

      await Promise.allSettled(
        Object.values(IMAGE_SLOTS).map(async ({ column }) => {
          const previous = previousFilenames[column];
          const current = row[column];
          if (previous && previous !== current) {
            await unlink(join(themesDir, previous)).catch(() => {});
          }
        }),
      );

      res.status(200).json(serializeTheme(row));
    } catch (err) {
      await cleanupUploadedFiles(req);
      console.error("updateTheme failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to update theme.",
      });
    }
  });
  router.use(themeImageUploadErrorHandler);

  /**
   * DELETE /themes/:id — deleteTheme
   * Auth: required. Owner or admin. Deletes the theme's background image
   * files from disk (best-effort). Users whose `themeId` pointed at this
   * theme fall back to `null` via the FK's `SET NULL` cascade.
   *
   * @openapi
   * /api/v1/themes/{id}:
   *   delete:
   *     tags: [Themes]
   *     summary: Delete a theme
   *     operationId: deleteTheme
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Deleted
   *       "403":
   *         description: Forbidden
   *       "404":
   *         description: Not found
   */
  router.delete("/themes/:id", requireAuth, async (req, res) => {
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

      const row = await Theme.findByPk(id);
      if (!row) {
        res.status(404).json({
          success: false,
          error: "not_found",
          message: "Theme not found.",
        });
        return;
      }

      if (!isThemeOwnerOrAdmin(req.user, req.authRole, row)) {
        res.status(403).json({
          success: false,
          error: "forbidden",
          message: "Only the owner or an admin can delete this theme.",
        });
        return;
      }

      const filenames = Object.values(IMAGE_SLOTS)
        .map(({ column }) => row[column])
        .filter(Boolean);

      await row.destroy();
      await Promise.allSettled(
        filenames.map((filename) => unlink(join(themesDir, filename)).catch(() => {})),
      );

      res.status(200).json({ success: true });
    } catch (err) {
      console.error("deleteTheme failed:", err);
      res.status(500).json({
        success: false,
        error: "internal_error",
        message: "Failed to delete theme.",
      });
    }
  });

  /**
   * GET /themes/:id/images/:slot — getThemeImage
   * Auth: none (public), mirrors `getUserAvatar`.
   *
   * @openapi
   * /api/v1/themes/{id}/images/{slot}:
   *   get:
   *     tags: [Themes]
   *     summary: Get a theme's background image
   *     operationId: getThemeImage
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *       - in: path
   *         name: slot
   *         required: true
   *         schema:
   *           type: string
   *           enum: [header, sidebar, view, footer]
   *     responses:
   *       "200":
   *         description: Background image
   *       "404":
   *         description: Not found, unknown slot, or no image set
   */
  router.get("/themes/:id/images/:slot", async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      const slot = IMAGE_SLOTS[req.params.slot];
      if (id == null || !slot) {
        res.status(404).json({ error: "not_found", message: "Theme image not found." });
        return;
      }

      const row = await Theme.findByPk(id);
      const filename = row?.[slot.column];
      if (!row || !filename) {
        res.status(404).json({ error: "not_found", message: "Theme image not found." });
        return;
      }

      const absolutePath = resolveSitedataPath(join("themes", filename));
      const contentType = mimeTypeForImage(filename);
      await streamFileWithRangeSupport(req, res, absolutePath, contentType);
    } catch (err) {
      console.error("getThemeImage failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: "Failed to load theme image.",
        });
      }
    }
  });

  /**
   * PUT /me/theme — selectMyTheme
   * Auth: required. Body `{ themeId }` (null clears the selection). The
   * theme must be public, owned by the caller, or the caller must be admin.
   *
   * @openapi
   * /api/v1/me/theme:
   *   put:
   *     tags: [Themes]
   *     summary: Select my theme
   *     operationId: selectMyTheme
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - $ref: "#/components/parameters/CsrfTokenHeader"
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               themeId: { type: integer, nullable: true }
   *     responses:
   *       "200":
   *         description: Updated selection
   *       "400":
   *         description: Invalid body, or themeId does not reference an existing theme
   *       "401":
   *         description: Unauthorized
   *       "403":
   *         description: Forbidden (theme not selectable by this caller)
   */
  router.put("/me/theme", requireAuth, async (req, res) => {
    try {
      const body = req.body || {};
      if (!Object.prototype.hasOwnProperty.call(body, "themeId")) {
        res.status(400).json({ error: "invalid_body", message: "themeId is required." });
        return;
      }

      let themeId = null;
      if (body.themeId !== null && body.themeId !== undefined) {
        themeId = parsePositiveInt(body.themeId);
        if (themeId == null) {
          res.status(400).json({
            error: "invalid_body",
            message: "themeId must be a positive integer or null.",
          });
          return;
        }

        const theme = await Theme.findByPk(themeId);
        if (!theme) {
          res.status(400).json({
            error: "invalid_body",
            message: "themeId does not reference an existing theme.",
          });
          return;
        }
        if (!isThemeSelectable(req.user, req.authRole, theme)) {
          res.status(403).json({
            error: "forbidden",
            message: "You cannot select this theme.",
          });
          return;
        }
      }

      await req.user.update({ themeId });

      const theme = themeId != null ? await Theme.findByPk(themeId) : null;
      res.status(200).json({
        themeId,
        theme: theme ? serializeTheme(theme) : null,
      });
    } catch (err) {
      console.error("selectMyTheme failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to select theme.",
      });
    }
  });

  /**
   * GET /users/:id/theme — getUserTheme
   * Auth: required. Self or admin only.
   *
   * @openapi
   * /api/v1/users/{id}/theme:
   *   get:
   *     tags: [Themes]
   *     summary: Get a user's theme selection
   *     operationId: getUserTheme
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       "200":
   *         description: Theme selection
   *       "403":
   *         description: Forbidden (not self or admin)
   *       "404":
   *         description: User not found
   */
  router.get("/users/:id/theme", requireAuth, async (req, res) => {
    try {
      const id = parsePositiveInt(req.params.id);
      if (id == null) {
        res.status(400).json({ error: "invalid_id", message: "id must be a positive integer." });
        return;
      }

      if (!isAdmin(req.authRole) && Number(req.user.id) !== id) {
        res.status(403).json({
          error: "forbidden",
          message: "Only the user or an admin can view this theme selection.",
        });
        return;
      }

      const targetUser = await User.findByPk(id);
      if (!targetUser) {
        res.status(404).json({ error: "not_found", message: "User not found." });
        return;
      }

      const theme = targetUser.themeId != null ? await Theme.findByPk(targetUser.themeId) : null;
      res.status(200).json({
        themeId: targetUser.themeId ?? null,
        theme: theme ? serializeTheme(theme) : null,
      });
    } catch (err) {
      console.error("getUserTheme failed:", err);
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load theme selection.",
      });
    }
  });

  return router;
}
