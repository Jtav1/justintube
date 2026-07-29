import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { Router } from "express";
import multer from "multer";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { requireUploader } from "../lib/auth/require-uploader.js";
import {
  heightToResolution,
  mimeTypeForContainer,
  plannedTranscodedStoragePath,
} from "../lib/media-meta.js";
import { markUploadFileVersionsFailed } from "../lib/file-versions.js";
import { FileVersion, OriginalUpload, TranscodeProfile, VideoMetadata, sequelize } from "../lib/models/index.js";
import {
  getProcessingHealth,
  requestDownload,
  requestTranscodeBatch,
} from "../lib/processing-client.js";

const MEDIA_STORAGE_DIRECTORY = process.env.MEDIA_STORAGE_DIRECTORY || "media";

/**
 * Absolute path to the media root. Relative env values are resolved against
 * the process working directory.
 *
 * @type {string}
 */
const mediaDir = isAbsolute(MEDIA_STORAGE_DIRECTORY)
  ? MEDIA_STORAGE_DIRECTORY
  : resolve(process.cwd(), MEDIA_STORAGE_DIRECTORY);

/**
 * Absolute path to the directory where original uploads are stored
 * (`MEDIA_STORAGE_DIRECTORY/original`). Also where the processing service
 * writes files downloaded via `POST /download` (shared media volume).
 *
 * @type {string}
 */
export const originalDir = join(mediaDir, "original");

// Ensure the original-uploads directory exists before any upload is attempted.
mkdirSync(originalDir, { recursive: true });

/**
 * Set of allowed lowercase file extensions (without a leading dot), parsed from
 * the FILETYPES_ALLOWED env var (e.g. "mp4,mkv,webm,wav,mp3").
 *
 * @type {Set<string>}
 */
const allowedExtensions = new Set(
  (process.env.FILETYPES_ALLOWED || "")
    .split(",")
    .map((ext) => ext.trim().toLowerCase().replace(/^\./, ""))
    .filter(Boolean),
);

/**
 * Maximum accepted upload size in bytes. Defaults to 2 GiB; override with the
 * MAX_UPLOAD_SIZE_BYTES env var.
 *
 * @type {number}
 */
const maxUploadSizeBytes =
  Number(process.env.MAX_UPLOAD_SIZE_BYTES) || 2 * 1024 * 1024 * 1024;

/**
 * File extension used for auto-generated video thumbnails (WebP — efficient
 * for web delivery). Must match the extension `buildThumbnailFfmpegArgs`
 * (processing) and its `-c:v libwebp` encoder produce.
 *
 * @type {string}
 */
const THUMBNAIL_OUTPUT_EXT = "webp";

/**
 * Normalizes a file's extension to a lowercase value without the leading dot.
 *
 * @private
 * @param {string} filename Original client-provided filename.
 * @returns {string} Lowercase extension without a dot (empty string if none).
 */
function normalizedExtension(filename) {
  return extname(filename).toLowerCase().replace(/^\./, "");
}

/**
 * Multer storage engine that writes uploads to `original/` under the media
 * root using a freshly generated UUID as the filename (preserving the
 * original extension).
 */
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, originalDir),
  filename: (_req, file, cb) => {
    const ext = normalizedExtension(file.originalname);
    const uuid = randomUUID();
    // Stash the UUID so the handler can reuse it for the DB record.
    file.generatedUuid = uuid;
    cb(null, ext ? `${uuid}.${ext}` : uuid);
  },
});

/**
 * Multer file filter that rejects any file whose extension is not present in
 * FILETYPES_ALLOWED.
 *
 * @private
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {Express.Multer.File} file File metadata provided by multer.
 * @param {multer.FileFilterCallback} cb Callback signaling acceptance/rejection.
 * @returns {void} Invokes `cb` with the filter decision.
 */
function fileFilter(_req, file, cb) {
  const ext = normalizedExtension(file.originalname);
  if (!allowedExtensions.has(ext)) {
    const error = new Error(`File type ".${ext}" is not allowed.`);
    error.code = "UNSUPPORTED_FILE_TYPE";
    cb(error);
    return;
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: maxUploadSizeBytes },
});

/**
 * Builds the standard JSON payload for a newly created ORIGINAL_UPLOADS row.
 *
 * @private
 * @param {import('sequelize').Model} upload Persisted upload instance.
 * @returns {object} Upload fields suitable for an HTTP response body.
 */
function uploadResponseBody(upload) {
  return {
    id: upload.id,
    originalFilename: upload.originalFilename,
    uuidName: upload.uuidName,
    fileExtension: upload.fileExtension,
    mimeType: upload.mimeType,
    fileSizeBytes: upload.fileSizeBytes,
    storagePath: upload.storagePath,
    status: upload.status,
    userId: upload.userId,
    videoWidth: upload.videoWidth,
    videoHeight: upload.videoHeight,
    resolution: upload.resolution,
    durationSeconds: upload.durationSeconds,
  };
}

/**
 * Derives a default video title from an original filename by stripping its
 * extension. Falls back to the raw filename if stripping would leave it
 * empty (e.g. a filename with no basename before the extension).
 *
 * @private
 * @param {string} originalFilename Client-provided filename.
 * @returns {string} Title suitable as VIDEO_METADATA.title (never empty).
 */
function defaultTitleFromFilename(originalFilename) {
  const ext = extname(originalFilename);
  const stripped = ext ? originalFilename.slice(0, -ext.length) : originalFilename;
  return stripped.trim() || originalFilename;
}

/**
 * Maps a Sequelize TranscodeProfile row to the processing API profile payload.
 *
 * @private
 * @param {import('sequelize').Model} row Transcode profile model instance.
 * @returns {import('../lib/processing-client.js').TranscodeProfilePayload} Profile body.
 */
function toTranscodeProfilePayload(row) {
  return {
    id: row.id,
    outputHeight: row.outputHeight,
    outputWidth: row.outputWidth,
    outputContainer: row.outputContainer,
    videoCodec: row.videoCodec,
    audioCodec: row.audioCodec,
  };
}

/**
 * Maps a FileVersion row to the upload response shape.
 *
 * @private
 * @param {import('sequelize').Model} version Persisted file version.
 * @returns {object} Public file-version fields.
 */
function fileVersionResponseBody(version) {
  return {
    id: version.id,
    uuidName: version.uuidName,
    jobId: version.uuidName,
    storagePath: version.storagePath,
    status: version.status,
    transcodeProfileId: version.transcodeProfileId,
    videoWidth: version.videoWidth,
    videoHeight: version.videoHeight,
    resolution: version.resolution,
  };
}

/**
 * Creates pending FILE_VERSIONS for each transcode profile and batch-enqueues
 * processing jobs against an already-persisted ORIGINAL_UPLOADS row. Shared
 * by both `uploadVideo` (multipart) and `importVideo` (URL download) once
 * each has stored its source file under `original/` and created `upload`.
 *
 * @private
 * @param {import('sequelize').Model} upload Persisted ORIGINAL_UPLOADS row.
 * @param {string} storedFilename Basename of the source file under `original/`.
 * @returns {Promise<{ status: number, body: object }>} HTTP status + JSON body to send.
 */
async function finalizeUploadTranscodes(upload, storedFilename) {
  const profiles = await TranscodeProfile.findAll();

  /** @type {import('sequelize').Model[]} */
  const versions = [];
  try {
    for (const row of profiles) {
      const versionUuid = randomUUID();
      const ext = String(row.outputContainer || "mp4")
        .trim()
        .toLowerCase()
        .replace(/^\./, "");
      const version = await FileVersion.create({
        originalUploadId: upload.id,
        uuidName: versionUuid,
        fileExtension: ext,
        mimeType: mimeTypeForContainer(ext),
        fileSizeBytes: null,
        storagePath: plannedTranscodedStoragePath(versionUuid, ext),
        status: "pending",
        videoWidth: row.outputWidth,
        videoHeight: row.outputHeight,
        resolution: heightToResolution(row.outputHeight),
        transcodeProfileId: row.id,
      });
      versions.push(version);
    }
  } catch (err) {
    console.error("[upload] failed to create FILE_VERSIONS:", err);
    await markUploadFileVersionsFailed(upload.id);
    return {
      status: 201,
      body: {
        ...uploadResponseBody(upload),
        fileVersions: [],
        failures: [
          {
            profileId: null,
            message:
              err instanceof Error
                ? err.message
                : "failed to create file version rows",
          },
        ],
      },
    };
  }

  const renditionJobs = versions.map((version, index) => ({
    jobId: version.uuidName,
    outputFilename: `${version.uuidName}.${version.fileExtension}`,
    kind: "rendition",
    profile: toTranscodeProfilePayload(profiles[index]),
  }));

  // A thumbnail job is always enqueued alongside any renditions (or on its
  // own when there are zero transcode profiles) — see `THUMBNAIL_OUTPUT_EXT`.
  const thumbnailJob = {
    jobId: upload.uuidName,
    outputFilename: `${upload.uuidName}.${THUMBNAIL_OUTPUT_EXT}`,
    kind: "thumbnail",
    timestampSeconds:
      upload.thumbnailTimestampTenths != null
        ? upload.thumbnailTimestampTenths / 10
        : null,
  };

  const enqueue = await requestTranscodeBatch({
    filename: storedFilename,
    jobs: [thumbnailJob, ...renditionJobs],
  });

  if (!enqueue.ok) {
    console.error("[upload] transcode batch enqueue failed:", enqueue.error);
    await markUploadFileVersionsFailed(upload.id);
    await upload.reload();
    for (const version of versions) {
      await version.reload();
    }
    return {
      status: 201,
      body: {
        ...uploadResponseBody(upload),
        fileVersions: versions.map((v) => fileVersionResponseBody(v)),
        failures: [
          {
            profileId: null,
            message: enqueue.error || "transcode enqueue failed",
          },
        ],
      },
    };
  }

  const body = enqueue.body && typeof enqueue.body === "object" ? enqueue.body : {};
  const source =
    body.source && typeof body.source === "object" ? body.source : null;
  if (
    source &&
    (typeof source.videoWidth === "number" ||
      typeof source.videoHeight === "number" ||
      typeof source.durationSeconds === "number")
  ) {
    const sourceWidth =
      typeof source.videoWidth === "number" ? source.videoWidth : null;
    const sourceHeight =
      typeof source.videoHeight === "number" ? source.videoHeight : null;
    const updates = {
      videoWidth: sourceWidth,
      videoHeight: sourceHeight,
      resolution: heightToResolution(sourceHeight ?? 0),
    };
    if (typeof source.durationSeconds === "number") {
      updates.durationSeconds = source.durationSeconds;
    }
    await upload.update(updates);
  }

  /** @type {Set<string>} */
  const skippedJobIds = new Set(
    Array.isArray(body.skipped)
      ? body.skipped
          .map((row) =>
            row && typeof row.jobId === "string" ? row.jobId : null,
          )
          .filter(Boolean)
      : [],
  );

  /** @type {import('sequelize').Model[]} */
  const activeVersions = [];
  /** @type {Array<{ profileId: number|null, jobId: string, reason: string }>} */
  const skippedProfiles = [];

  for (const version of versions) {
    if (skippedJobIds.has(version.uuidName)) {
      const skipMeta = Array.isArray(body.skipped)
        ? body.skipped.find((row) => row?.jobId === version.uuidName)
        : null;
      skippedProfiles.push({
        profileId: version.transcodeProfileId ?? null,
        jobId: version.uuidName,
        reason:
          typeof skipMeta?.reason === "string"
            ? skipMeta.reason
            : "profile_exceeds_source_resolution",
      });
      await version.destroy();
      continue;
    }
    await version.update({ status: "processing" });
    activeVersions.push(version);
  }

  if (activeVersions.length > 0) {
    await upload.update({ status: "processing" });
  } else {
    // All profiles were above source resolution (or none accepted).
    await upload.update({ status: "uploaded" });
  }

  await upload.reload();
  for (const version of activeVersions) {
    await version.reload();
  }

  return {
    status: 201,
    body: {
      ...uploadResponseBody(upload),
      fileVersions: activeVersions.map((v) => fileVersionResponseBody(v)),
      ...(skippedProfiles.length > 0 ? { skippedProfiles } : {}),
    },
  };
}

/**
 * Parses an optional thumbnail-timestamp field (seconds, possibly fractional)
 * into tenths-of-a-second for storage on `ORIGINAL_UPLOADS`. Multipart form
 * fields arrive as strings; JSON bodies may send a number directly. Omitted
 * means "no preference" — processing will pick a random timestamp.
 *
 * @param {unknown} raw Raw `thumbnailTimestamp` value from the request.
 * @returns {{ok: true, tenths: number|null}|{ok: false, message: string}}
 *   Parsed tenths-of-a-second (null when omitted), or a validation error.
 */
function parseThumbnailTimestampTenths(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, tenths: null };
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return {
      ok: false,
      message: "thumbnailTimestamp must be a non-negative number of seconds.",
    };
  }
  return { ok: true, tenths: Math.round(seconds * 10) };
}

/**
 * Express handler for raw video upload.
 * POST /api/v1/videos/upload — multipart form field `file` (single).
 * Auth: required, uploader flag (or admin). Handler runs after `requireAuth`
 * + `requireUploader`, so `req.user` is always set.
 *
 * Persists the already-stored file's metadata to ORIGINAL_UPLOADS, then delegates
 * to {@link finalizeUploadTranscodes} for FILE_VERSIONS + processing enqueue.
 *
 * @private
 * @param {import('express').Request} req Request whose `file` was populated by multer.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Sends 201 upload JSON, or an error status on failure.
 */
async function uploadVideo(req, res) {
  const file = req.file;
  if (!file) {
    res.status(400).json({
      error: "missing_file",
      message: 'A multipart "file" field is required.',
    });
    return;
  }

  const thumbnailTimestamp = parseThumbnailTimestampTenths(req.body?.thumbnailTimestamp);
  if (!thumbnailTimestamp.ok) {
    // Roll back the already-stored file so we don't leave orphaned media behind.
    await unlink(join(originalDir, file.filename)).catch(() => {});
    res.status(400).json({
      error: "invalid_body",
      message: thumbnailTimestamp.message,
    });
    return;
  }

  const uuidName = file.generatedUuid;
  const fileExtension = normalizedExtension(file.originalname);
  // Relative storage path uses forward slashes for cross-platform DB consistency.
  const storagePath = `original/${file.filename}`;

  let upload;
  try {
    upload = await sequelize.transaction(async (transaction) => {
      const created = await OriginalUpload.create(
        {
          originalFilename: file.originalname,
          uuidName,
          fileExtension,
          mimeType: file.mimetype || null,
          fileSizeBytes: file.size ?? null,
          storagePath,
          userId: req.user.id,
          thumbnailTimestampTenths: thumbnailTimestamp.tenths,
        },
        { transaction },
      );
      await VideoMetadata.create(
        {
          originalUploadId: created.id,
          title: defaultTitleFromFilename(file.originalname),
        },
        { transaction },
      );
      return created;
    });
  } catch (err) {
    // Roll back the stored file so we don't leave orphaned media behind.
    await unlink(join(originalDir, file.filename)).catch(() => {});
    res.status(500).json({
      error: "upload_persist_failed",
      message: "The file was received but could not be recorded.",
    });
    return;
  }

  const result = await finalizeUploadTranscodes(upload, file.filename);
  res.status(result.status).json(result.body);
}

/**
 * Validates that `url` is a non-empty absolute http(s) URL string.
 *
 * @private
 * @param {unknown} url Value from the request body.
 * @returns {string} Trimmed URL string.
 * @throws {Error} When the URL is missing or malformed (message is user-facing).
 */
function validateImportUrl(url) {
  if (typeof url !== "string" || !url.trim()) {
    throw new Error("url is required and must be a string");
  }

  const trimmed = url.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("url must be a valid absolute URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("url must use http or https");
  }

  return trimmed;
}

/**
 * Express handler for importing a video from a remote URL.
 * POST /api/v1/videos/import — JSON body `{ url }`.
 * Auth: required, uploader flag (or admin). Handler runs after `requireAuth`
 * + `requireUploader`, so `req.user` is always set.
 *
 * Asks the processing service to download `url` via yt-dlp into the shared
 * `original/` media directory, renames the result to a fresh UUID basename
 * (matching the multipart upload convention), persists ORIGINAL_UPLOADS, then
 * delegates to {@link finalizeUploadTranscodes} exactly like `uploadVideo`.
 *
 * @private
 * @param {import('express').Request} req Request with JSON body `{ url }`.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Sends 201 upload JSON, or an error status on failure.
 */
async function importVideo(req, res) {
  let url;
  try {
    url = validateImportUrl(req.body?.url);
  } catch (err) {
    res.status(400).json({
      error: "invalid_body",
      message: err instanceof Error ? err.message : "url is invalid",
    });
    return;
  }

  const thumbnailTimestamp = parseThumbnailTimestampTenths(req.body?.thumbnailTimestamp);
  if (!thumbnailTimestamp.ok) {
    res.status(400).json({
      error: "invalid_body",
      message: thumbnailTimestamp.message,
    });
    return;
  }

  const download = await requestDownload(url);
  if (!download.ok) {
    if (download.status === 400) {
      res.status(400).json({
        error: "invalid_body",
        message: download.error || "The processing service rejected the URL.",
      });
      return;
    }
    if (download.status === 0) {
      res.status(503).json({
        error: "processing_unavailable",
        message: download.error || "The processing service is unreachable.",
      });
      return;
    }
    res.status(502).json({
      error: "import_download_failed",
      message: download.error || "Failed to download the video from the provided URL.",
    });
    return;
  }

  const downloadedFilename = download.body?.filename;
  if (typeof downloadedFilename !== "string" || !downloadedFilename) {
    res.status(502).json({
      error: "import_download_failed",
      message: "The processing service did not return a downloaded filename.",
    });
    return;
  }

  const fileExtension = normalizedExtension(downloadedFilename);
  const uuidName = randomUUID();
  const storedFilename = fileExtension ? `${uuidName}.${fileExtension}` : uuidName;
  // Relative storage path uses forward slashes for cross-platform DB consistency.
  const storagePath = `original/${storedFilename}`;

  try {
    await rename(
      join(originalDir, downloadedFilename),
      join(originalDir, storedFilename),
    );
  } catch (err) {
    res.status(500).json({
      error: "import_persist_failed",
      message: "The video was downloaded but could not be stored.",
    });
    return;
  }

  let fileSizeBytes = null;
  try {
    fileSizeBytes = statSync(join(originalDir, storedFilename)).size;
  } catch {
    // Leave fileSizeBytes null if the stat somehow fails right after rename.
  }

  let upload;
  try {
    upload = await sequelize.transaction(async (transaction) => {
      const created = await OriginalUpload.create(
        {
          originalFilename: downloadedFilename,
          uuidName,
          fileExtension,
          mimeType: mimeTypeForContainer(fileExtension),
          fileSizeBytes,
          storagePath,
          userId: req.user.id,
          thumbnailTimestampTenths: thumbnailTimestamp.tenths,
        },
        { transaction },
      );
      await VideoMetadata.create(
        {
          originalUploadId: created.id,
          title: defaultTitleFromFilename(downloadedFilename),
        },
        { transaction },
      );
      return created;
    });
  } catch (err) {
    // Roll back the stored file so we don't leave orphaned media behind.
    await unlink(join(originalDir, storedFilename)).catch(() => {});
    res.status(500).json({
      error: "upload_persist_failed",
      message: "The video was downloaded but could not be recorded.",
    });
    return;
  }

  const result = await finalizeUploadTranscodes(upload, storedFilename);
  res.status(result.status).json(result.body);
}

/**
 * Express error handler for multer/upload failures, mapping known error codes to
 * appropriate HTTP responses.
 *
 * @private
 * @param {Error} err Error thrown by multer or the file filter.
 * @param {import('express').Request} _req Incoming request (unused).
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Passes non-upload errors along.
 * @returns {void} Sends an error JSON response or delegates via `next`.
 */
function uploadErrorHandler(err, _req, res, next) {
  if (err?.code === "UNSUPPORTED_FILE_TYPE") {
    res.status(400).json({
      error: "unsupported_file_type",
      message: err.message,
      allowed: [...allowedExtensions],
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
 * Builds a router exposing the real media upload endpoint.
 *
 * @returns {import('express').Router} Router handling POST /api/v1/videos/upload.
 */
export function createUploadRouter() {
  const router = Router();
  /**
   * POST /api/v1/videos/upload — multipart `file`.
   * Auth: required, uploader flag (or admin).
   * Handler: {@link uploadVideo}.
   *
   * @openapi
   * /api/v1/videos/upload:
   *   post:
   *     tags: [Uploads]
   *     summary: Upload a video file
   *     operationId: uploadVideo
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
   *             required: [file]
   *             properties:
   *               file:
   *                 type: string
   *                 format: binary
   *               thumbnailTimestamp:
   *                 type: number
   *                 format: float
   *                 minimum: 0
   *                 description: >
   *                   Optional timestamp (seconds, may be fractional) to grab the
   *                   auto-generated thumbnail frame from. Omitted, or past the
   *                   video's actual duration, picks a random timestamp instead.
   *     responses:
   *       201:
   *         description: Upload recorded
   *       400:
   *         description: Missing or invalid file
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Uploader access required
   */
  router.post(
    "/videos/upload",
    requireAuth,
    csrfProtection,
    requireUploader,
    upload.single("file"),
    uploadVideo,
  );
  router.use(uploadErrorHandler);

  /**
   * POST /api/v1/videos/import — JSON `{ url }`.
   * Auth: required, uploader flag (or admin).
   * Handler: {@link importVideo}.
   *
   * @openapi
   * /api/v1/videos/import:
   *   post:
   *     tags: [Uploads]
   *     summary: Import a video from a remote URL
   *     operationId: importVideo
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
   *             required: [url]
   *             properties:
   *               url:
   *                 type: string
   *                 format: uri
   *               thumbnailTimestamp:
   *                 type: number
   *                 format: float
   *                 minimum: 0
   *                 description: >
   *                   Optional timestamp (seconds, may be fractional) to grab the
   *                   auto-generated thumbnail frame from. Omitted, or past the
   *                   video's actual duration, picks a random timestamp instead.
   *     responses:
   *       201:
   *         description: Video downloaded and recorded
   *       400:
   *         description: Missing or invalid url
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Uploader access required
   *       502:
   *         description: Processing service failed to download the URL
   *       503:
   *         description: Processing service unreachable
   */
  router.post("/videos/import", requireAuth, csrfProtection, requireUploader, importVideo);

  /**
   * GET /api/v1/videos/import/status — importStatus
   * Auth: required. Reports whether the processing service (which backs
   * `POST /videos/import`) is currently reachable and healthy, so clients can
   * hide/disable URL-import UI when it isn't.
   *
   * @openapi
   * /api/v1/videos/import/status:
   *   get:
   *     tags: [Uploads]
   *     summary: Check whether URL import is currently available
   *     operationId: importStatus
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Processing-service availability
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 available:
   *                   type: boolean
   *       401:
   *         description: Not authenticated
   */
  router.get("/videos/import/status", requireAuth, async (_req, res) => {
    const health = await getProcessingHealth();
    res.status(200).json({ available: health.ok });
  });

  return router;
}
