import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { Router } from "express";
import multer from "multer";
import {
  heightToResolution,
  mimeTypeForContainer,
  plannedTranscodedStoragePath,
} from "../lib/media-meta.js";
import { markUploadFileVersionsFailed } from "../lib/file-versions.js";
import { FileVersion, OriginalUpload, TranscodeProfile } from "../lib/models/index.js";
import { requestTranscodeBatch } from "../lib/processing-client.js";

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
 * (`MEDIA_STORAGE_DIRECTORY/original`).
 *
 * @type {string}
 */
const originalDir = join(mediaDir, "original");

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
 * Normalizes a file's extension to a lowercase value without the leading dot.
 *
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
  };
}

/**
 * Maps a Sequelize TranscodeProfile row to the processing API profile payload.
 *
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
 * Express handler for `POST /videos/upload`. Persists the already-stored file's
 * metadata to ORIGINAL_UPLOADS, creates pending FILE_VERSIONS for each
 * transcode profile, then batch-enqueues processing jobs.
 *
 * @param {import('express').Request} req Request whose `file` was populated by multer.
 * @param {import('express').Response} res Express response.
 * @returns {Promise<void>} Sends a 201 JSON response, or an error status on failure.
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

  const uuidName = file.generatedUuid;
  const fileExtension = normalizedExtension(file.originalname);
  // Relative storage path uses forward slashes for cross-platform DB consistency.
  const storagePath = `original/${file.filename}`;

  let upload;
  try {
    upload = await OriginalUpload.create({
      originalFilename: file.originalname,
      uuidName,
      fileExtension,
      mimeType: file.mimetype || null,
      fileSizeBytes: file.size ?? null,
      storagePath,
      userId: null,
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

  const profiles = await TranscodeProfile.findAll();
  if (profiles.length === 0) {
    res.status(201).json(uploadResponseBody(upload));
    return;
  }

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
    res.status(201).json({
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
    });
    return;
  }

  const jobs = versions.map((version, index) => ({
    jobId: version.uuidName,
    outputFilename: `${version.uuidName}.${version.fileExtension}`,
    profile: toTranscodeProfilePayload(profiles[index]),
  }));

  const enqueue = await requestTranscodeBatch({
    filename: file.filename,
    jobs,
  });

  if (!enqueue.ok) {
    console.error("[upload] transcode batch enqueue failed:", enqueue.error);
    await markUploadFileVersionsFailed(upload.id);
    await upload.reload();
    for (const version of versions) {
      await version.reload();
    }
    res.status(201).json({
      ...uploadResponseBody(upload),
      fileVersions: versions.map((v) => fileVersionResponseBody(v)),
      failures: [
        {
          profileId: null,
          message: enqueue.error || "transcode enqueue failed",
        },
      ],
    });
    return;
  }

  for (const version of versions) {
    await version.update({ status: "processing" });
  }
  await upload.update({ status: "processing" });
  await upload.reload();
  for (const version of versions) {
    await version.reload();
  }

  res.status(201).json({
    ...uploadResponseBody(upload),
    fileVersions: versions.map((v) => fileVersionResponseBody(v)),
  });
}

/**
 * Express error handler for multer/upload failures, mapping known error codes to
 * appropriate HTTP responses.
 *
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
 * @returns {import('express').Router} Router handling `POST /videos/upload`.
 */
export function createUploadRouter() {
  const router = Router();
  router.post("/videos/upload", upload.single("file"), uploadVideo);
  router.use(uploadErrorHandler);
  return router;
}
