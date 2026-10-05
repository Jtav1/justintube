import { ProcessingJobRun } from "./models/index.js";

/**
 * Computes the deterministic `paramsKey` for a job kind + its parameters -
 * see `ProcessingJobRun`'s model-level doc comment for why this exists.
 * Every kind not explicitly handled below (`"hls"`, `"normalize"`, `"hash"`)
 * has no distinguishing parameter, so it always gets the same key -
 * `"singleton"` - meaning there's at most one row per `(upload, kind)`.
 *
 * @param {string} jobKind One of `JOB_KIND_VALUES`.
 * @param {object} [params] Raw per-kind parameters (unset ones are ignored).
 * @param {number} [params.transcodeProfileId] `"rendition"` only.
 * @param {string} [params.language] `"subtitle"` only.
 * @param {number|null} [params.thumbnailTimestampTenths] `"thumbnail"` only.
 * @param {boolean} [params.isDefaultThumbnail] `"embed"` only.
 * @returns {string} The computed params key (at most 64 chars, matching the
 *   column width).
 */
export function buildParamsKey(jobKind, params = {}) {
  switch (jobKind) {
    case "rendition":
      return `profile:${params.transcodeProfileId}`;
    case "subtitle":
      return `lang:${params.language || "unknown"}`;
    case "thumbnail":
      return params.thumbnailTimestampTenths != null
        ? `ts:${params.thumbnailTimestampTenths}`
        : "ts:random";
    case "embed":
      return `default:${params.isDefaultThumbnail ? "true" : "false"}`;
    default:
      return "singleton";
  }
}

/**
 * Upserts a job run row into `"pending"` right after a successful enqueue -
 * the first of this table's three lifecycle writes (pending -> processing ->
 * complete/failed/cancelled). Overwrites `jobId` and clears any previous
 * `errorMessage` in place, rather than creating a new row, so a re-enqueued
 * job (after a prior failure, or a user-triggered regeneration) reuses the
 * same `(originalUploadId, jobKind, paramsKey)` identity.
 *
 * @param {object} options Job identity + parameters.
 * @param {number} options.originalUploadId Parent ORIGINAL_UPLOADS id.
 * @param {string} options.jobKind One of `JOB_KIND_VALUES`.
 * @param {string} options.jobId BullMQ job id as of this enqueue.
 * @param {number} [options.transcodeProfileId] `"rendition"` only.
 * @param {string} [options.language] `"subtitle"` only.
 * @param {number|null} [options.thumbnailTimestampTenths] `"thumbnail"` only.
 * @param {boolean} [options.isDefaultThumbnail] `"embed"` only.
 * @returns {Promise<import('sequelize').Model>} The upserted row.
 */
export async function upsertPendingJobRun({
  originalUploadId,
  jobKind,
  jobId,
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

  const [row] = await ProcessingJobRun.findOrCreate({
    where: { originalUploadId, jobKind, paramsKey },
    defaults: {
      jobId,
      status: "pending",
      transcodeProfileId,
      language,
      thumbnailTimestampTenths,
      isDefaultThumbnail,
    },
  });

  await row.update({
    jobId,
    status: "pending",
    errorMessage: null,
    transcodeProfileId,
    language,
    thumbnailTimestampTenths,
    isDefaultThumbnail,
  });

  return row;
}

/**
 * Flips a job run to `"processing"` - called when processing's worker
 * actually picks the job up (see `POST /internal/job-runs/:jobId/start`),
 * the second lifecycle write. A no-op (matches zero rows) when `jobId` no
 * longer matches any row's current `jobId` - e.g. it was superseded by a
 * fresher re-enqueue, or the row doesn't exist for some other reason.
 *
 * @param {string} jobId BullMQ job id.
 * @returns {Promise<void>} Resolves once the update attempt completes.
 */
export async function markJobRunProcessing(jobId) {
  await ProcessingJobRun.update({ status: "processing" }, { where: { jobId } });
}

/**
 * Flips a job run to `"complete"`, clearing any previous failure message -
 * the terminal success write. Same stale-jobId no-op behavior as
 * {@link markJobRunProcessing}.
 *
 * @param {string} jobId BullMQ job id.
 * @returns {Promise<void>} Resolves once the update attempt completes.
 */
export async function markJobRunComplete(jobId) {
  await ProcessingJobRun.update({ status: "complete", errorMessage: null }, { where: { jobId } });
}

/**
 * Flips a job run to `"failed"`, recording the failure reason. Same stale-
 * jobId no-op behavior as {@link markJobRunProcessing}.
 *
 * @param {string} jobId BullMQ job id.
 * @param {string} [errorMessage] Human-readable failure reason (truncated to
 *   the column's 255-char width).
 * @returns {Promise<void>} Resolves once the update attempt completes.
 */
export async function markJobRunFailed(jobId, errorMessage) {
  await ProcessingJobRun.update(
    {
      status: "failed",
      errorMessage: errorMessage ? String(errorMessage).slice(0, 255) : null,
    },
    { where: { jobId } },
  );
}

/**
 * Flips a job run to `"cancelled"` - for a job explicitly removed from the
 * BullMQ queue (see `cancelQueuedTranscodeJobs`) before it ran to
 * completion, as opposed to one that ran and failed on its own. Same stale-
 * jobId no-op behavior as {@link markJobRunProcessing}.
 *
 * @param {string} jobId BullMQ job id.
 * @returns {Promise<void>} Resolves once the update attempt completes.
 */
export async function markJobRunCancelled(jobId) {
  await ProcessingJobRun.update({ status: "cancelled" }, { where: { jobId } });
}

/**
 * Upserts one `"subtitle"` job run per extracted/attempted language straight
 * to `"complete"` - subtitle extraction discovers its languages during the
 * run, not at enqueue time, so (unlike every other kind) there's no pending
 * row with a real `language` to flip; this creates each language's row
 * outright. Called once per language from the same `/internal/subtitles/
 * :jobId/complete` callback that also writes VIDEO_SUBTITLE, so all of a
 * run's language rows share that one call's `jobId`.
 *
 * @param {object} options Job identity.
 * @param {number} options.originalUploadId Parent ORIGINAL_UPLOADS id.
 * @param {string} options.jobId BullMQ job id (shared across every language
 *   from the same run).
 * @param {string} options.language Extracted track's language (empty string
 *   for an unlabeled track).
 * @returns {Promise<import('sequelize').Model>} The upserted row.
 */
export async function upsertCompleteSubtitleLanguageRun({ originalUploadId, jobId, language }) {
  const paramsKey = buildParamsKey("subtitle", { language });

  const [row] = await ProcessingJobRun.findOrCreate({
    where: { originalUploadId, jobKind: "subtitle", paramsKey },
    defaults: { jobId, status: "complete", language },
  });

  await row.update({ jobId, status: "complete", errorMessage: null, language });

  return row;
}

/**
 * Looks up the current job run for a `(upload, kind, params)` identity, so a
 * caller can decide whether it needs to (re)run the job: missing, `"failed"`,
 * or `"cancelled"` means yes; `"pending"`/`"processing"` means one is already
 * in flight; `"complete"` means it's already done.
 *
 * @param {number} originalUploadId Parent ORIGINAL_UPLOADS id.
 * @param {string} jobKind One of `JOB_KIND_VALUES`.
 * @param {object} [params] Same shape as {@link buildParamsKey}'s `params`.
 * @returns {Promise<import('sequelize').Model|null>} The matching row, or
 *   `null` when this exact job has never been run.
 */
export async function findJobRun(originalUploadId, jobKind, params = {}) {
  const paramsKey = buildParamsKey(jobKind, params);
  return ProcessingJobRun.findOne({ where: { originalUploadId, jobKind, paramsKey } });
}
