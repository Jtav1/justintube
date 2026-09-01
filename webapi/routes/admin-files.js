import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { resolveMediaPath } from "../lib/media-meta.js";
import { FileVersion, OriginalUpload, VideoThumbnail } from "../lib/models/index.js";
import { logger } from "../lib/logger.js";

/**
 * Subfolder name (under `mediaDir`) holding video thumbnails, mirroring the
 * `THUMBNAILS_SUBDIR` convention in `routes/videos.js`.
 *
 * @type {string}
 */
const THUMBNAILS_SUBDIR = "thumbnails";

/**
 * Maps the three top-level media directory categories to their absolute
 * paths, mirroring `originalDir`/`transcodedDir`/`thumbnailsDir` in
 * `processing/lib/media-paths.js`.
 *
 * @type {Record<string, string>}
 */
const CATEGORY_DIRS = {
  original: resolveMediaPath("original"),
  transcoded: resolveMediaPath("transcoded"),
  thumbnails: resolveMediaPath(THUMBNAILS_SUBDIR),
};

/**
 * Maximum recursion depth for `walkDirectory`, guarding against runaway
 * traversal (e.g. a symlink cycle) since the media layout is only ever two
 * levels deep (`<category>/<userId|_unowned>/<file>`) by convention.
 *
 * @type {number}
 */
const MAX_TREE_DEPTH = 8;

/**
 * Parses a route `:id`-style param as a positive integer primary key.
 *
 * @private
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
 * Resolves a relative storage path against the media root and reports
 * whether the file actually exists on disk, alongside its real size — lets
 * admin tooling spot drift between the database and the filesystem.
 *
 * @private
 * @param {string} relativePath Path relative to `mediaDir` (e.g. `"original/3/<uuid>.mp4"`).
 * @returns {Promise<{relativePath: string, absolutePath: string, existsOnDisk: boolean, sizeBytesOnDisk: number|null}>}
 *   Filesystem-verified description of the stored file.
 */
async function describeStoredFile(relativePath) {
  const absolutePath = resolveMediaPath(relativePath);
  try {
    const stats = await stat(absolutePath);
    return {
      relativePath,
      absolutePath,
      existsOnDisk: true,
      sizeBytesOnDisk: stats.size,
    };
  } catch {
    return {
      relativePath,
      absolutePath,
      existsOnDisk: false,
      sizeBytesOnDisk: null,
    };
  }
}

/**
 * Resolves an OriginalUpload by numeric primary key, internal storage uuid,
 * or public videoId, trying each in that order.
 *
 * @private
 * @param {unknown} raw Route parameter value (pkid, uuid, or videoId).
 * @returns {Promise<import('sequelize').Model|null>} Matching upload, or null.
 */
async function resolveUploadByIdentifier(raw) {
  const asString = String(raw ?? "").trim();
  if (!asString) {
    return null;
  }

  const pkid = parsePositiveInt(asString);
  if (pkid !== null) {
    const byId = await OriginalUpload.findByPk(pkid);
    if (byId) {
      return byId;
    }
  }

  const byUuid = await OriginalUpload.findOne({ where: { uuid: asString } });
  if (byUuid) {
    return byUuid;
  }

  return OriginalUpload.findOne({ where: { videoId: asString } });
}

/**
 * Resolves the owning OriginalUpload for a file-level uuid, checking both
 * uuid-bearing tables (an original upload's own `uuid`, or a transcoded
 * FILE_VERSIONS row's `uuidName`). Thumbnails have no uuid column, so they
 * cannot be looked up this way.
 *
 * @private
 * @param {string} uuid File uuid to resolve.
 * @returns {Promise<{upload: import('sequelize').Model, matchedAs: "original"|"transcoded", matchedFileVersionId: number|null}|null>}
 *   The owning upload and how the uuid matched, or null when not found.
 */
async function resolveUploadByFileUuid(uuid) {
  const byOriginal = await OriginalUpload.findOne({ where: { uuid } });
  if (byOriginal) {
    return { upload: byOriginal, matchedAs: "original", matchedFileVersionId: null };
  }

  const fileVersion = await FileVersion.findOne({ where: { uuidName: uuid } });
  if (fileVersion) {
    const upload = await OriginalUpload.findByPk(fileVersion.originalUploadId);
    if (upload) {
      return { upload, matchedAs: "transcoded", matchedFileVersionId: fileVersion.id };
    }
  }

  return null;
}

/**
 * Builds the full filesystem-verified file tree for an upload: its original
 * source file, optional embed video, optional thumbnail, and every
 * transcoded FILE_VERSIONS variant.
 *
 * @private
 * @param {import('sequelize').Model} upload Loaded OriginalUpload instance.
 * @returns {Promise<object>} `{ upload, files }` payload for JSON responses.
 */
async function buildUploadFileTree(upload) {
  const [fileVersions, thumbnail] = await Promise.all([
    FileVersion.findAll({ where: { originalUploadId: upload.id }, order: [["id", "ASC"]] }),
    VideoThumbnail.findOne({ where: { originalUploadId: upload.id } }),
  ]);

  const original = {
    kind: "original",
    fileExtension: upload.fileExtension,
    mimeType: upload.mimeType,
    fileSizeBytes: upload.fileSizeBytes,
    ...(await describeStoredFile(upload.storagePath)),
  };

  const embedVideo = upload.embedVideoStoragePath
    ? {
        kind: "embed_video",
        isDefault: upload.embedVideoIsDefault,
        ...(await describeStoredFile(upload.embedVideoStoragePath)),
      }
    : null;

  const thumbnailEntry = thumbnail
    ? {
        id: thumbnail.id,
        kind: "thumbnail",
        ...(await describeStoredFile(join(THUMBNAILS_SUBDIR, thumbnail.thumbnailFilename))),
      }
    : null;

  const transcoded = await Promise.all(
    fileVersions.map(async (fileVersion) => ({
      id: fileVersion.id,
      kind: "transcoded",
      uuidName: fileVersion.uuidName,
      status: fileVersion.status,
      resolution: fileVersion.resolution,
      transcodeProfileId: fileVersion.transcodeProfileId,
      fileExtension: fileVersion.fileExtension,
      mimeType: fileVersion.mimeType,
      fileSizeBytes: fileVersion.fileSizeBytes,
      ...(await describeStoredFile(fileVersion.storagePath)),
    })),
  );

  return {
    upload: {
      id: upload.id,
      videoId: upload.videoId,
      uuid: upload.uuid,
      mediaType: upload.mediaType,
      status: upload.status,
      userId: upload.userId,
    },
    files: {
      original,
      embedVideo,
      thumbnail: thumbnailEntry,
      transcoded,
    },
  };
}

/**
 * Recursively lists a media directory's contents as a nested tree of
 * directory/file entries with absolute + relative paths. Missing directories
 * (e.g. `thumbnails/` before the first thumbnail is ever written) yield an
 * empty children list rather than an error.
 *
 * @private
 * @param {string} absoluteDir Absolute directory to list.
 * @param {string} relativeDir Path of `absoluteDir` relative to the category root (`""` at the root).
 * @param {number} depth Current recursion depth, guarded by `MAX_TREE_DEPTH`.
 * @returns {Promise<Array<object>>} Child directory/file entries.
 */
async function walkDirectory(absoluteDir, relativeDir, depth) {
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      return [];
    }
    throw err;
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));

  const children = [];
  for (const entry of entries) {
    const entryRelative = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const entryAbsolute = join(absoluteDir, entry.name);

    if (entry.isDirectory()) {
      const truncated = depth >= MAX_TREE_DEPTH;
      children.push({
        name: entry.name,
        type: "directory",
        relativePath: entryRelative,
        absolutePath: entryAbsolute,
        truncated,
        children: truncated ? [] : await walkDirectory(entryAbsolute, entryRelative, depth + 1),
      });
    } else if (entry.isFile()) {
      const stats = await stat(entryAbsolute);
      children.push({
        name: entry.name,
        type: "file",
        relativePath: entryRelative,
        absolutePath: entryAbsolute,
        sizeBytes: stats.size,
      });
    }
  }

  return children;
}

/**
 * Builds the admin router exposing filesystem-tracing tools for media
 * storage: an upload's full associated-file list, reverse lookup from a
 * file's uuid back to its owning upload, and a raw directory listing of each
 * top-level media category. Read-only today; intended as the foundation for
 * future admin storage-management functionality (e.g. orphan cleanup).
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createAdminFilesRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Lists every file associated with an upload (original, embed video,
   * thumbnail, transcoded variants), verified against the filesystem.
   * GET /api/v1/admin/files/uploads/:identifier
   * `:identifier` may be the upload's numeric pkid, its internal storage
   * uuid, or its public videoId — tried in that order.
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/files/uploads/{identifier}:
   *   get:
   *     tags: [Admin]
   *     summary: List all files associated with an upload
   *     operationId: getUploadFileTree
   *     parameters:
   *       - name: identifier
   *         in: path
   *         required: true
   *         description: Upload pkid, internal uuid, or public videoId
   *         schema: { type: string }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Upload's full associated-file list
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: Upload not found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with `{ upload, files }`, or error.
   */
  router.get(
    "/admin/files/uploads/:identifier",
    requireAuth,
    requireAdmin,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      try {
        const upload = await resolveUploadByIdentifier(req.params.identifier);
        if (!upload) {
          res.status(404).json({ error: "not_found", message: "Upload not found." });
          return;
        }
        res.status(200).json(await buildUploadFileTree(upload));
      } catch (err) {
        logger.error({ err }, "getUploadFileTree failed");
        res.status(500).json({ error: "internal_error", message: "Failed to build file tree." });
      }
    },
  );

  /**
   * Finds the owning upload's full file tree, given the uuid of one of its
   * files (its own original-file uuid, or a transcoded FILE_VERSIONS
   * uuidName). Thumbnails have no uuid, so they cannot be looked up here.
   * GET /api/v1/admin/files/lookup/:uuid
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/files/lookup/{uuid}:
   *   get:
   *     tags: [Admin]
   *     summary: Find a file's source tree by its uuid
   *     operationId: getFileSourceTree
   *     parameters:
   *       - name: uuid
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Owning upload's full associated-file list
   *       400:
   *         description: Missing uuid
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       404:
   *         description: No file with that uuid was found
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with `{ matchedAs, matchedFileVersionId, upload, files }`, or error.
   */
  router.get(
    "/admin/files/lookup/:uuid",
    requireAuth,
    requireAdmin,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      const uuid = String(req.params.uuid || "").trim();
      if (!uuid) {
        res.status(400).json({ error: "invalid_id", message: "uuid is required." });
        return;
      }

      try {
        const match = await resolveUploadByFileUuid(uuid);
        if (!match) {
          res.status(404).json({ error: "not_found", message: "No file with that uuid was found." });
          return;
        }
        const tree = await buildUploadFileTree(match.upload);
        res.status(200).json({
          matchedAs: match.matchedAs,
          matchedFileVersionId: match.matchedFileVersionId,
          ...tree,
        });
      } catch (err) {
        logger.error({ err }, "getFileSourceTree failed");
        res.status(500).json({ error: "internal_error", message: "Failed to resolve file source tree." });
      }
    },
  );

  /**
   * Lists the full directory structure of one top-level media category,
   * verified directly against the filesystem (not the database).
   * GET /api/v1/admin/files/tree/:category
   * `:category` is one of `original`, `transcoded`, `thumbnails`.
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/files/tree/{category}:
   *   get:
   *     tags: [Admin]
   *     summary: List a top-level media directory's structure
   *     operationId: listMediaDirectoryTree
   *     parameters:
   *       - name: category
   *         in: path
   *         required: true
   *         schema: { type: string, enum: [original, transcoded, thumbnails] }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Directory tree for the category
   *       400:
   *         description: Invalid category
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with `{ category, absoluteRoot, children }`, or error.
   */
  router.get(
    "/admin/files/tree/:category",
    requireAuth,
    requireAdmin,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      const category = String(req.params.category || "").trim();
      const absoluteRoot = CATEGORY_DIRS[category];
      if (!absoluteRoot) {
        res.status(400).json({
          error: "invalid_category",
          message: `category must be one of: ${Object.keys(CATEGORY_DIRS).join(", ")}.`,
        });
        return;
      }

      try {
        const children = await walkDirectory(absoluteRoot, "", 0);
        res.status(200).json({ category, absoluteRoot, children });
      } catch (err) {
        logger.error({ err }, "listMediaDirectoryTree failed");
        res.status(500).json({ error: "internal_error", message: "Failed to list media directory." });
      }
    },
  );

  return router;
}
