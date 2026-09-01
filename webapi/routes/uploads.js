import { randomUUID } from "node:crypto";
import { mkdirSync, statSync } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve } from "node:path";
import { Router } from "express";
import multer from "multer";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { requireUploader } from "../lib/auth/require-uploader.js";
import {
  heightToResolution,
  mediaTypeForExtension,
  mimeTypeForContainer,
  plannedTranscodedStoragePath,
  userStorageSegment,
} from "../lib/media-meta.js";
import {
  markUploadFileVersionsFailed,
  toTranscodeProfilePayload,
} from "../lib/file-versions.js";
import {
  duplicateUploadDetectionEnabled,
  transcodingEnabled,
  videoImportsEnabled,
} from "../lib/processing-features-config.js";
import { FileVersion, OriginalUpload, TranscodeProfile, VideoMetadata, sequelize } from "../lib/models/index.js";
import { generateUniqueVideoId } from "../lib/video-id.js";
import {
  getProcessingHealth,
  requestDownload,
  requestTranscodeBatch,
} from "../lib/processing-client.js";
import { logger } from "../lib/logger.js";

const MEDIA_STORAGE_DIRECTORY = process.env.MEDIA_STORAGE_DIRECTORY || "media";

/**
 * Absolute path to the media root. Relative env values are resolved against
 * the process working directory.
 *
 * @type {string}
 */
export const mediaDir = isAbsolute(MEDIA_STORAGE_DIRECTORY)
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
 * Set of lowercase file extensions (without a leading dot) that aren't in
 * `allowedExtensions` but are common enough containers that an upload is
 * accepted anyway and automatically normalized (remuxed/transcoded) into an
 * H.264/AAC MP4 (or M4A for audio-only) before going live, rather than
 * rejected. Parsed from FILETYPES_CONVERTIBLE.
 *
 * @type {Set<string>}
 */
const convertibleExtensions = new Set(
  (process.env.FILETYPES_CONVERTIBLE || "")
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
export const THUMBNAIL_OUTPUT_EXT = "webp";

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
 * Multer storage engine that writes uploads to `original/<userId>/` under the
 * media root using a freshly generated UUID as the filename (preserving the
 * original extension) — the video id is still generated (for the public
 * `videoId` column) but no longer doubles as the on-disk filename. `req.user`
 * is always the video's owner for a direct upload (no admin-uploads-for-
 * someone-else path exists here), so the destination can be chosen directly
 * without a rename-after-write step.
 */
const storage = multer.diskStorage({
  destination: (req, _file, cb) => {
    try {
      const dir = join(originalDir, userStorageSegment(req.user?.id ?? null));
      mkdirSync(dir, { recursive: true });
      cb(null, dir);
    } catch (err) {
      cb(err);
    }
  },
  filename: async (_req, file, cb) => {
    try {
      const ext = normalizedExtension(file.originalname);
      const videoId = await generateUniqueVideoId();
      const uuid = randomUUID();
      // Stash both ids so the handler can reuse them for the DB record.
      file.generatedVideoId = videoId;
      file.generatedUuid = uuid;
      cb(null, ext ? `${uuid}.${ext}` : uuid);
    } catch (err) {
      cb(err);
    }
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
  if (allowedExtensions.has(ext)) {
    cb(null, true);
    return;
  }
  if (convertibleExtensions.has(ext) && transcodingEnabled()) {
    // Accepted, but flagged so the handler normalizes it (remux/transcode to
    // H.264/AAC MP4) instead of treating it as an already-playable original.
    file.needsConversion = true;
    cb(null, true);
    return;
  }
  const error = new Error(`File type ".${ext}" is not allowed.`);
  error.code = "UNSUPPORTED_FILE_TYPE";
  cb(error);
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
    videoId: upload.videoId,
    fileExtension: upload.fileExtension,
    mimeType: upload.mimeType,
    mediaType: upload.mediaType,
    fileSizeBytes: upload.fileSizeBytes,
    storagePath: upload.storagePath,
    status: upload.status,
    statusMessage: upload.statusMessage ?? null,
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
 * Derives a placeholder title for an in-progress URL import. Shown only
 * until the frontend's immediate follow-up `updateVideo` call overwrites it
 * with the user's actual title — the same way `defaultTitleFromFilename`'s
 * output is immediately overwritten for direct uploads today.
 *
 * @private
 * @param {string} url Already-validated absolute http(s) URL.
 * @returns {string} Non-empty placeholder title.
 */
function defaultImportTitle(url) {
  try {
    return `Importing from ${new URL(url).hostname}`;
  } catch {
    return "Importing…";
  }
}

/**
 * Maps a failed `requestDownload` outcome to a human-readable message for
 * `ORIGINAL_UPLOADS.statusMessage`, preserving the same status-code
 * distinctions the old synchronous `importVideo` used to reflect directly in
 * its HTTP response (400 = rejected URL, 0 = processing unreachable, other =
 * generic download failure).
 *
 * @private
 * @param {import('../lib/processing-client.js').DownloadRequestResult} download
 *   Failed (`ok: false`) result from `requestDownload`.
 * @returns {string} Message suitable for display to the uploading user.
 */
function describeDownloadFailure(download) {
  if (download.status === 400) {
    return download.error || "The processing service rejected the URL.";
  }
  if (download.status === 0) {
    return download.error || "The processing service is unreachable.";
  }
  return download.error || "Failed to download the video from the provided URL.";
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
 * When `transcodingEnabled()` is false, finishes immediately without
 * contacting the processing service at all — see that early-return below.
 *
 * @private
 * @param {import('sequelize').Model} upload Persisted ORIGINAL_UPLOADS row.
 * @param {string} storedFilename Basename of the source file under `original/`.
 * @param {{ skipThumbnail?: boolean }} [options] `skipThumbnail` omits the
 *   auto-generated thumbnail job — set when the caller is about to upload a
 *   custom thumbnail, to avoid the processing service's result racing with
 *   (and overwriting) it.
 * @returns {Promise<{ status: number, body: object }>} HTTP status + JSON body to send.
 */
export async function finalizeUploadTranscodes(upload, storedFilename, { skipThumbnail = false } = {}) {
  if (!transcodingEnabled()) {
    // Transcoding is disabled deployment-wide: never contact the processing
    // service (it may not even be running). The original file stays
    // playable via the "original" rendition, just without any transcoded
    // FILE_VERSIONS or a generated thumbnail.
    await upload.update({ status: "uploaded" });
    await upload.reload();
    return {
      status: 201,
      body: {
        ...uploadResponseBody(upload),
        fileVersions: [],
      },
    };
  }

  const profiles = await TranscodeProfile.findAll({
    where: { mediaType: upload.mediaType },
  });

  const segment = userStorageSegment(upload.userId);

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
        storagePath: plannedTranscodedStoragePath(upload.userId, versionUuid, ext),
        status: "pending",
        videoWidth: row.outputWidth,
        videoHeight: row.outputHeight,
        resolution: heightToResolution(row.outputHeight),
        transcodeProfileId: row.id,
      });
      versions.push(version);
    }
  } catch (err) {
    logger.error({ err }, "[upload] failed to create FILE_VERSIONS");
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
    outputFilename: `${segment}/${version.uuidName}.${version.fileExtension}`,
    kind: "rendition",
    profile: toTranscodeProfilePayload(profiles[index]),
  }));

  // A thumbnail job is enqueued alongside any renditions (or on its own when
  // there are zero transcode profiles) for video uploads — see
  // `THUMBNAIL_OUTPUT_EXT`. Audio-only uploads never get a generated
  // thumbnail (the frontend renders a placeholder instead) and must never
  // enter the ffmpeg transcode pipeline at all. `skipThumbnail` opts out
  // too, when the caller is supplying its own thumbnail image instead.
  const thumbnailJob =
    upload.mediaType === "video" && !skipThumbnail
      ? {
          jobId: upload.videoId,
          outputFilename: `${segment}/${upload.videoId}.${THUMBNAIL_OUTPUT_EXT}`,
          kind: "thumbnail",
          timestampSeconds:
            upload.thumbnailTimestampTenths != null
              ? upload.thumbnailTimestampTenths / 10
              : null,
        }
      : null;

  const jobs = [...(thumbnailJob ? [thumbnailJob] : []), ...renditionJobs];

  if (jobs.length === 0) {
    // Nothing to transcode (audio upload with no matching audio profiles) -
    // skip the processing round-trip entirely rather than enqueueing an
    // empty batch.
    await upload.update({ status: "uploaded" });
    await upload.reload();
    return {
      status: 201,
      body: {
        ...uploadResponseBody(upload),
        fileVersions: [],
      },
    };
  }

  const enqueue = await requestTranscodeBatch({
    filename: storedFilename,
    jobs,
  });

  if (!enqueue.ok) {
    logger.error({ error: enqueue.error }, "[upload] transcode batch enqueue failed");
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
 * When duplicate-upload detection is enabled, fires off a content-hash job
 * with the processing service for `upload` without affecting the upload
 * itself in any way — the caller does not await this, the upload's status
 * and response are never touched by it, and it never blocks or delays
 * finalizing the upload for the user. Any match is discovered later, out of
 * band, by the `/internal/original-uploads/:jobId/hash-complete` callback,
 * which only records a `DuplicateUploadFlag` and notifies admins/moderators
 * for manual review — it does not alter the (already-live) video.
 *
 * Best-effort: when the feature is disabled, or the enqueue call fails
 * (processing unreachable, etc.), this just logs and gives up. A missed
 * duplicate check is an acceptable outcome; an upload must never be blocked
 * or delayed by it.
 *
 * @private
 * @param {import('sequelize').Model} upload Persisted ORIGINAL_UPLOADS row.
 * @param {string} storedFilename Basename of the source file under `original/`.
 * @returns {void} Nothing — the hash job is enqueued in the background.
 */
export function enqueueDuplicateHashCheck(upload, storedFilename) {
  if (!duplicateUploadDetectionEnabled()) {
    return;
  }

  requestTranscodeBatch({
    filename: storedFilename,
    jobs: [{ jobId: `hash-${upload.videoId}`, kind: "hash" }],
  })
    .then((enqueue) => {
      if (!enqueue.ok) {
        logger.warn(
          { error: enqueue.error },
          `[upload] duplicate-check enqueue failed for ${upload.videoId}`,
        );
      }
    })
    .catch((err) => {
      logger.warn({ err }, `[upload] duplicate-check enqueue threw for ${upload.videoId}`);
    });
}

/**
 * For an audio upload that now has a thumbnail, fires off an `"embed"`
 * processing job that muxes the thumbnail image with the audio into a real
 * MP4 — purely so link-unfurl bots that only render `og:video` (Discord in
 * particular; see `renderUnfurlHtml` in routes/videos.js) have something
 * genuinely playable to embed for audio uploads. Video uploads are skipped
 * entirely — they already have a real video stream to point unfurlers at.
 *
 * Fire-and-forget like `enqueueDuplicateHashCheck`: the caller (the
 * thumbnail-upload route) does not await this and its response is never
 * touched by it. The completion callback
 * (`/internal/original-uploads/:jobId/embed-complete`) is what actually
 * updates `embedVideoStoragePath`/width/height and cleans up whichever
 * previous embed video this upload had, once the new one is confirmed on
 * disk — nothing is deleted here up front, so a failed regeneration never
 * leaves the upload with no working embed video at all.
 *
 * Reuses the fixed jobId `embed-<videoId>` (like `normalize-<videoId>`
 * elsewhere in this file) - if a previous embed job for this same upload is
 * still queued/active when the thumbnail changes again, this enqueue is a
 * silent no-op (BullMQ dedupes by jobId) and the in-flight job keeps running
 * against the older thumbnail. Acceptable for v1: the same limitation
 * already exists for normalize/hash jobs, and worst case a re-upload shortly
 * after finishes the regeneration anyway.
 *
 * @private
 * @param {import('sequelize').Model} upload Persisted ORIGINAL_UPLOADS row.
 * @param {string} thumbnailFilename Relative path under `thumbnails/` (e.g. `"42/cover.jpg"`).
 * @param {string} storedFilename Basename of the audio source file under `original/`.
 * @returns {void} Nothing — the embed job is enqueued in the background.
 */
export function enqueueAudioEmbedVideo(upload, thumbnailFilename, storedFilename) {
  if (upload.mediaType !== "audio" || !transcodingEnabled()) {
    return;
  }

  const segment = userStorageSegment(upload.userId);
  const outputFilename = `${segment}/${randomUUID()}-embed.mp4`;

  requestTranscodeBatch({
    filename: storedFilename,
    jobs: [
      {
        jobId: `embed-${upload.videoId}`,
        outputFilename,
        kind: "embed",
        thumbnailFilename,
      },
    ],
  })
    .then((enqueue) => {
      if (!enqueue.ok) {
        logger.warn(
          { error: enqueue.error },
          `[upload] audio-embed enqueue failed for ${upload.videoId}`,
        );
      }
    })
    .catch((err) => {
      logger.warn({ err }, `[upload] audio-embed enqueue threw for ${upload.videoId}`);
    });
}

/**
 * Kicks off server-side normalization for an upload accepted through the
 * FILETYPES_CONVERTIBLE tier (a common container ffmpeg can read but that
 * FILETYPES_ALLOWED doesn't serve as-is): enqueues a single `"normalize"`
 * job with the processing service, which remuxes/transcodes the source into
 * an H.264/AAC MP4 (or M4A for audio-only uploads) at its original
 * resolution. Marks the upload `"converting"` and returns immediately —
 * `finalizeUploadTranscodes` and the duplicate-hash check both run later,
 * once `/internal/original-uploads/:jobId/normalize-complete` fires (see
 * routes/internal-original-uploads.js), against the normalized file rather
 * than the raw source.
 *
 * @private
 * @param {import('sequelize').Model} upload Persisted ORIGINAL_UPLOADS row.
 * @param {string} storedFilename Basename of the raw source file under `original/`.
 * @returns {Promise<{ status: number, body: object }>} HTTP status + JSON body to send.
 */
async function startUploadConversion(upload, storedFilename) {
  const outputExtension = upload.mediaType === "audio" ? "m4a" : "mp4";
  // Normalize output replaces the raw source and becomes the upload's new
  // canonical "original" file — a distinct physical file, so it gets its own
  // fresh uuid rather than reusing videoId as a filename stem.
  const newUuid = randomUUID();
  const segment = userStorageSegment(upload.userId);
  const enqueue = await requestTranscodeBatch({
    filename: storedFilename,
    jobs: [
      {
        jobId: `normalize-${upload.videoId}`,
        outputFilename: `${segment}/${newUuid}.${outputExtension}`,
        kind: "normalize",
      },
    ],
  });

  if (!enqueue.ok) {
    logger.error(
      { error: enqueue.error },
      `[upload] normalize enqueue failed for ${upload.videoId}`,
    );
    await upload.update({
      status: "failed",
      statusMessage: enqueue.error || "Failed to queue format conversion.",
    });
    await upload.reload();
    return {
      status: 201,
      body: {
        ...uploadResponseBody(upload),
        fileVersions: [],
        failures: [
          {
            profileId: null,
            message: enqueue.error || "normalize enqueue failed",
          },
        ],
      },
    };
  }

  await upload.update({ status: "converting" });
  await upload.reload();
  return {
    status: 201,
    body: {
      ...uploadResponseBody(upload),
      fileVersions: [],
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
export function parseThumbnailTimestampTenths(raw) {
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
 * Parses the optional `skipThumbnail` field. Multipart requests deliver it as
 * a string ("true"/"1"); JSON requests may send a real boolean.
 *
 * @param {unknown} raw Raw `skipThumbnail` value from the request.
 * @returns {boolean} Whether the auto-generated thumbnail job should be skipped.
 */
function parseSkipThumbnail(raw) {
  return raw === true || raw === "true" || raw === "1";
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
    await unlink(file.path).catch(() => {});
    res.status(400).json({
      error: "invalid_body",
      message: thumbnailTimestamp.message,
    });
    return;
  }

  const skipThumbnail = parseSkipThumbnail(req.body?.skipThumbnail);

  const videoId = file.generatedVideoId;
  const uuid = file.generatedUuid;
  const fileExtension = normalizedExtension(file.originalname);
  // Path relative to originalDir, e.g. "42/<uuid>.mp4" — forward slashes for
  // cross-platform DB consistency (path.relative returns backslashes on Windows).
  const storedFilename = relative(originalDir, file.path).replace(/\\/g, "/");
  const storagePath = `original/${storedFilename}`;

  let upload;
  try {
    upload = await sequelize.transaction(async (transaction) => {
      const created = await OriginalUpload.create(
        {
          originalFilename: file.originalname,
          videoId,
          uuid,
          fileExtension,
          mimeType: mimeTypeForContainer(fileExtension) || file.mimetype || null,
          mediaType: mediaTypeForExtension(fileExtension),
          fileSizeBytes: file.size ?? null,
          storagePath,
          userId: req.user.id,
          thumbnailTimestampTenths: thumbnailTimestamp.tenths,
          skipThumbnail,
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
    await unlink(file.path).catch(() => {});
    res.status(500).json({
      error: "upload_persist_failed",
      message: "The file was received but could not be recorded.",
    });
    return;
  }

  let result;
  if (file.needsConversion) {
    // Renditions/thumbnail must scale from the normalized file, not the raw
    // source, and the duplicate-hash check should hash the final playable
    // file — both are deferred until normalize-complete (see
    // routes/internal-original-uploads.js) instead of running now.
    result = await startUploadConversion(upload, storedFilename);
  } else {
    enqueueDuplicateHashCheck(upload, storedFilename);
    result = await finalizeUploadTranscodes(upload, storedFilename, { skipThumbnail });
  }
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
  if (!videoImportsEnabled()) {
    res.status(403).json({
      error: "video_imports_disabled",
      message: "URL import is disabled on this deployment.",
    });
    return;
  }

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

  const skipThumbnail = parseSkipThumbnail(req.body?.skipThumbnail);
  const videoId = await generateUniqueVideoId();
  // Generated now (like the direct-upload path's multer filename callback)
  // rather than waiting for the download to complete — continueImport reuses
  // this same uuid as the final on-disk filename once the file actually
  // exists, so the placeholder row is never left with a null uuid.
  const uuid = randomUUID();

  let upload;
  try {
    upload = await sequelize.transaction(async (transaction) => {
      const created = await OriginalUpload.create(
        {
          // originalFilename/fileExtension/storagePath are NOT NULL with no
          // default and aren't known until the download (below) completes —
          // empty-string placeholders, overwritten by continueImport. Safe:
          // serializeVideo() never reads these fields, and this row stays
          // invisible everywhere else until VIDEO_METADATA.visibility is set
          // by the client's immediate follow-up updateVideo call (defaults
          // to "private").
          originalFilename: "",
          videoId,
          uuid,
          fileExtension: "",
          mimeType: null,
          fileSizeBytes: null,
          storagePath: "",
          status: "downloading",
          userId: req.user.id,
          thumbnailTimestampTenths: thumbnailTimestamp.tenths,
        },
        { transaction },
      );
      await VideoMetadata.create(
        {
          originalUploadId: created.id,
          title: defaultImportTitle(url),
        },
        { transaction },
      );
      return created;
    });
  } catch (err) {
    res.status(500).json({
      error: "upload_persist_failed",
      message: "The import could not be started.",
    });
    return;
  }

  res.status(201).json({ ...uploadResponseBody(upload), fileVersions: [] });

  // Fire-and-forget: continueImport never throws (all failures are caught
  // internally and recorded on the row instead), matching this codebase's
  // existing un-awaited syncVideoIndex()/syncUserIndex() convention for
  // post-response side effects. The frontend polls
  // GET /videos/:id/processing-status to observe how this turns out.
  continueImport(upload, url, { skipThumbnail });
}

/**
 * Rolls back a failed URL import: deletes the placeholder ORIGINAL_UPLOADS
 * row (cascading its VIDEO_METADATA and any FILE_VERSIONS rows already
 * created) and unlinks any file it had written, so a failed
 * `POST /videos/import` attempt never leaves a persisted record or an
 * orphaned file behind. Logs `statusMessage` server-side since it's no
 * longer stored anywhere the client can read it.
 *
 * @private
 * @param {import('sequelize').Model} upload Placeholder upload row to roll back.
 * @param {string} statusMessage Human-readable failure reason, logged only.
 * @param {string[]} [extraFiles] Extra absolute paths to unlink (e.g. a
 *   downloaded source file that never got renamed to `upload.storagePath`).
 * @returns {Promise<void>} Resolves once the row and files are gone.
 */
async function rollbackFailedImport(upload, statusMessage, extraFiles = []) {
  logger.error({ statusMessage }, `[import] rolled back failed import for ${upload.videoId}`);

  const versions = await FileVersion.findAll({ where: { originalUploadId: upload.id } });
  const filesToDelete = [...extraFiles];
  if (upload.storagePath) {
    filesToDelete.push(join(mediaDir, upload.storagePath));
  }
  for (const version of versions) {
    if (version.storagePath) {
      filesToDelete.push(join(mediaDir, version.storagePath));
    }
  }

  await upload.destroy();
  await Promise.all(filesToDelete.map((path) => unlink(path).catch(() => {})));
}

/**
 * Finishes an in-progress URL import that `importVideo` started: downloads
 * the source via the processing service, renames it into `original/` under
 * the upload's videoId, fills in the real file metadata on the placeholder
 * `upload` row, then delegates to `finalizeUploadTranscodes` exactly like
 * the old synchronous import path did. Never throws — any failure rolls the
 * placeholder row (and any file it wrote) back via
 * {@link rollbackFailedImport} instead of leaving a "failed" record behind.
 * Exported so tests can await it directly instead of racing the
 * fire-and-forget call `importVideo` makes.
 *
 * @param {import('sequelize').Model} upload Placeholder ORIGINAL_UPLOADS row
 *   (status "downloading"; originalFilename/fileExtension/storagePath "").
 * @param {string} url Already-validated absolute http(s) URL.
 * @param {{ skipThumbnail?: boolean }} [options] Forwarded to `finalizeUploadTranscodes`.
 * @returns {Promise<void>} Resolves once the import either finalizes or fails.
 */
export async function continueImport(upload, url, { skipThumbnail = false } = {}) {
  try {
    const download = await requestDownload(url);
    if (!download.ok) {
      await rollbackFailedImport(upload, describeDownloadFailure(download));
      return;
    }

    const downloadedFilename = download.body?.filename;
    if (typeof downloadedFilename !== "string" || !downloadedFilename) {
      await rollbackFailedImport(
        upload,
        "The processing service did not return a downloaded filename.",
      );
      return;
    }

    const fileExtension = normalizedExtension(downloadedFilename);
    // Prefer processing's ffprobe-based signal over extension sniffing: a
    // yt-dlp audio-only download can land in an ambiguous container (e.g.
    // opus-in-webm), which extension alone can't distinguish from a video
    // webm. Fall back to extension when the field is absent (defensive, in
    // case an older processing deployment doesn't send it yet).
    const mediaType =
      typeof download.body?.hasVideo === "boolean"
        ? download.body.hasVideo
          ? "video"
          : "audio"
        : mediaTypeForExtension(fileExtension);
    // Reuses the uuid generated at placeholder-creation time (importVideo)
    // as the final on-disk filename, now that the file actually exists.
    const uuid = upload.uuid;
    const segment = userStorageSegment(upload.userId);
    const storedFilename = fileExtension ? `${segment}/${uuid}.${fileExtension}` : `${segment}/${uuid}`;
    // Relative storage path uses forward slashes for cross-platform DB consistency.
    const storagePath = `original/${storedFilename}`;

    try {
      mkdirSync(join(originalDir, segment), { recursive: true });
      await rename(
        join(originalDir, downloadedFilename),
        join(originalDir, storedFilename),
      );
    } catch {
      await rollbackFailedImport(upload, "The video was downloaded but could not be stored.", [
        join(originalDir, downloadedFilename),
      ]);
      return;
    }

    let fileSizeBytes = null;
    try {
      fileSizeBytes = statSync(join(originalDir, storedFilename)).size;
    } catch {
      // Leave fileSizeBytes null if the stat somehow fails right after rename.
    }

    await upload.update({
      originalFilename: downloadedFilename,
      uuid,
      fileExtension,
      mimeType: mimeTypeForContainer(fileExtension),
      mediaType,
      fileSizeBytes,
      storagePath,
    });

    enqueueDuplicateHashCheck(upload, storedFilename);

    await finalizeUploadTranscodes(upload, storedFilename, { skipThumbnail });
  } catch (err) {
    logger.error({ err }, "[import] continueImport failed unexpectedly");
    await rollbackFailedImport(
      upload,
      "An unexpected error occurred while importing this video.",
    ).catch(() => {});
  }
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
   *               skipThumbnail:
   *                 type: boolean
   *                 description: >
   *                   When true, don't enqueue a processing-generated
   *                   thumbnail. Set this when the caller is about to upload
   *                   a custom thumbnail via POST /videos/{id}/thumbnail, to
   *                   avoid the auto-generated one overwriting it.
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
    requireApiKeyScope("content_edit"),
    upload.single("file"),
    uploadVideo,
  );
  router.use(uploadErrorHandler);

  /**
   * POST /api/v1/videos/import — JSON `{ url }`.
   * Auth: required, uploader flag (or admin).
   * Handler: {@link importVideo}. Responds as soon as a placeholder
   * ORIGINAL_UPLOADS/VIDEO_METADATA row exists (status "downloading") — the
   * actual yt-dlp download and transcode-enqueue happen afterward via
   * {@link continueImport}. Poll GET /videos/{id}/processing-status to
   * observe progress/failure instead of relying on this response's status.
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
   *               skipThumbnail:
   *                 type: boolean
   *                 description: >
   *                   When true, don't enqueue a processing-generated
   *                   thumbnail. Set this when the caller is about to upload
   *                   a custom thumbnail via POST /videos/{id}/thumbnail, to
   *                   avoid the auto-generated one overwriting it.
   *     responses:
   *       201:
   *         description: >
   *           Import started; the returned upload has status "downloading".
   *           Poll GET /videos/{id}/processing-status for progress/failure.
   *       400:
   *         description: Missing or invalid url
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Uploader access required
   */
  router.post(
    "/videos/import",
    requireAuth,
    csrfProtection,
    requireUploader,
    requireApiKeyScope("content_edit"),
    importVideo,
  );

  /**
   * GET /api/v1/videos/import/status — importStatus
   * Auth: required. Reports whether the processing service (which backs
   * `POST /videos/import`) is currently reachable and healthy, so clients can
   * hide/disable URL-import UI when it isn't. When `ENABLE_VIDEO_IMPORTS` is
   * disabled, reports unavailable without contacting processing at all.
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
    if (!videoImportsEnabled()) {
      // Disabled deployment-wide: report unavailable without pinging
      // processing, which may not even be running.
      res.status(200).json({ available: false });
      return;
    }
    const health = await getProcessingHealth();
    res.status(200).json({ available: health.ok });
  });

  return router;
}
