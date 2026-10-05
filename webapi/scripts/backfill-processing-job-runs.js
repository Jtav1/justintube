import { pathToFileURL } from "node:url";
import { Op } from "sequelize";
import { buildParamsKey } from "../lib/processing-job-runs.js";
import { FileVersion, OriginalUpload, ProcessingJobRun, VideoSubtitle } from "../lib/models/index.js";

/**
 * Creates a PROCESSING_JOB_RUNS row for `(originalUploadId, jobKind,
 * paramsKey)` only if one doesn't already exist - this backfill is a
 * one-time catch-up for history that predates the ledger, so it must never
 * clobber a row the live enqueue/callback code paths have already written
 * (which may be mid-flight, with a real jobId this backfill has no way to
 * reconstruct).
 *
 * @param {object} options Row fields - same shape as the model's columns.
 * @returns {Promise<boolean>} Whether a new row was actually created.
 */
async function backfillRow({
  originalUploadId,
  jobKind,
  jobId,
  status,
  transcodeProfileId = null,
  language = null,
  thumbnailTimestampTenths = null,
  isDefaultThumbnail = null,
}) {
  const paramsKey = buildParamsKey(jobKind, {
    transcodeProfileId,
    language,
    thumbnailTimestampTenths,
    isDefaultThumbnail,
  });

  const [, created] = await ProcessingJobRun.findOrCreate({
    where: { originalUploadId, jobKind, paramsKey },
    defaults: {
      jobId,
      status,
      transcodeProfileId,
      language,
      thumbnailTimestampTenths,
      isDefaultThumbnail,
    },
  });
  return created;
}

/**
 * Backfills one row per FILE_VERSIONS row (`"rendition"`) - status copied
 * straight from the version's own `status` column (pending/processing/
 * complete/failed all mean the same thing on both tables).
 *
 * @returns {Promise<number>} Number of rows created.
 */
export async function backfillRenditionJobRuns() {
  const versions = await FileVersion.findAll();
  let created = 0;
  for (const version of versions) {
    const didCreate = await backfillRow({
      originalUploadId: version.originalUploadId,
      jobKind: "rendition",
      jobId: version.uuidName,
      status: version.status,
      transcodeProfileId: version.transcodeProfileId,
    });
    if (didCreate) created++;
  }
  return created;
}

/**
 * Backfills one row per auto-extracted VIDEO_SUBTITLE row (`"subtitle"`,
 * one per language) - always `"complete"` (the row only exists because
 * extraction succeeded). `jobId` is synthesized (`backfill-subtitle-
 * <uploadId>-<language>`) since the real BullMQ job id was never persisted
 * anywhere and the job itself is long gone - it only needs to be a stable,
 * non-empty placeholder here, never looked up again. User-provided
 * (`source: "user"`) subtitles are skipped - they were never a processing
 * job in the first place.
 *
 * @returns {Promise<number>} Number of rows created.
 */
export async function backfillSubtitleJobRuns() {
  const subtitles = await VideoSubtitle.findAll({ where: { source: "auto" } });
  let created = 0;
  for (const subtitle of subtitles) {
    const language = subtitle.label || "unknown";
    const didCreate = await backfillRow({
      originalUploadId: subtitle.originalUploadId,
      jobKind: "subtitle",
      jobId: `backfill-subtitle-${subtitle.originalUploadId}-${language}`,
      status: "complete",
      language,
    });
    if (didCreate) created++;
  }
  return created;
}

/**
 * Backfills one row per upload with a thumbnail job that's already run -
 * every upload past `"downloading"`/`"converting"` (i.e. one processing has
 * actually had a chance to generate a thumbnail for, successfully or not)
 * gets a row, `"complete"` only if a VIDEO_THUMBNAIL row exists for it. The
 * originally-requested timestamp before this ledger existed isn't
 * reconstructable beyond whatever `thumbnailTimestampTenths` still happens
 * to be set to (it's cleared by `POST /videos/:id/thumbnail`, a direct
 * upload, so this is best-effort for auto-generated thumbnails specifically).
 *
 * @returns {Promise<number>} Number of rows created.
 */
export async function backfillThumbnailJobRuns() {
  const uploads = await OriginalUpload.findAll({
    where: { status: { [Op.notIn]: ["downloading", "converting"] } },
    include: [{ association: "VideoThumbnail", required: false }],
  });
  let created = 0;
  for (const upload of uploads) {
    const didCreate = await backfillRow({
      originalUploadId: upload.id,
      jobKind: "thumbnail",
      jobId: `backfill-thumbnail-${upload.id}`,
      status: upload.VideoThumbnail ? "complete" : "failed",
      thumbnailTimestampTenths: upload.thumbnailTimestampTenths ?? null,
    });
    if (didCreate) created++;
  }
  return created;
}

/**
 * Backfills one `"hash"` row per upload with a recorded `contentHash`.
 *
 * @returns {Promise<number>} Number of rows created.
 */
export async function backfillHashJobRuns() {
  const uploads = await OriginalUpload.findAll({
    where: { contentHash: { [Op.ne]: null } },
  });
  let created = 0;
  for (const upload of uploads) {
    const didCreate = await backfillRow({
      originalUploadId: upload.id,
      jobKind: "hash",
      jobId: `hash-${upload.videoId}`,
      status: "complete",
    });
    if (didCreate) created++;
  }
  return created;
}

/**
 * Backfills one `"hls"` row per upload with a recorded
 * `hlsPlaylistStoragePath` ("Best" quality already packaged).
 *
 * @returns {Promise<number>} Number of rows created.
 */
export async function backfillHlsJobRuns() {
  const uploads = await OriginalUpload.findAll({
    where: { hlsPlaylistStoragePath: { [Op.ne]: null } },
  });
  let created = 0;
  for (const upload of uploads) {
    const didCreate = await backfillRow({
      originalUploadId: upload.id,
      jobKind: "hls",
      jobId: `backfill-hls-${upload.id}`,
      status: "complete",
    });
    if (didCreate) created++;
  }
  return created;
}

/**
 * Backfills one `"embed"` row per audio upload with a recorded
 * `embedVideoStoragePath` (link-unfurl embed video already muxed).
 *
 * @returns {Promise<number>} Number of rows created.
 */
export async function backfillEmbedJobRuns() {
  const uploads = await OriginalUpload.findAll({
    where: { embedVideoStoragePath: { [Op.ne]: null } },
  });
  let created = 0;
  for (const upload of uploads) {
    const didCreate = await backfillRow({
      originalUploadId: upload.id,
      jobKind: "embed",
      jobId: `backfill-embed-${upload.id}`,
      status: "complete",
      isDefaultThumbnail: upload.embedVideoIsDefault,
    });
    if (didCreate) created++;
  }
  return created;
}

/**
 * Runs every backfill in this file. Idempotent and safe to re-run: each one
 * only ever creates a row for an identity that doesn't already have one
 * (see {@link backfillRow}), so a row the live code already wrote (from
 * running this twice, or from normal traffic since the feature shipped) is
 * never touched. `"normalize"` jobs are deliberately not backfilled - once
 * normalization replaces an upload's source file, nothing distinguishes a
 * normalized upload from one that was never convertible-tier in the first
 * place, so there's no reliable signal left to backfill from.
 *
 * @returns {Promise<Record<string, number>>} Rows created per job kind.
 */
export async function runProcessingJobRunsBackfill() {
  const counts = {
    rendition: await backfillRenditionJobRuns(),
    subtitle: await backfillSubtitleJobRuns(),
    thumbnail: await backfillThumbnailJobRuns(),
    hash: await backfillHashJobRuns(),
    hls: await backfillHlsJobRuns(),
    embed: await backfillEmbedJobRuns(),
  };
  for (const [kind, count] of Object.entries(counts)) {
    console.log(`[${kind}] backfilled ${count} row(s)`);
  }
  return counts;
}

/**
 * Run with `npm run backfill-processing-job-runs` (inside the
 * `justintube-api` container in production: `docker compose exec webapi npm
 * run backfill-processing-job-runs`).
 *
 * @returns {Promise<void>} Resolves once the backfill run completes.
 */
async function main() {
  console.log("Starting PROCESSING_JOB_RUNS backfill ...");
  const counts = await runProcessingJobRunsBackfill();
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  console.log(`Done. ${total} row(s) created in total.`);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("backfill-processing-job-runs failed:", err);
    process.exit(1);
  });
}
