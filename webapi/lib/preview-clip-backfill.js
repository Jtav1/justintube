import { Op } from "sequelize";
import { userStorageSegment } from "./media-meta.js";
import { OriginalUpload } from "./models/index.js";
import { requestTranscodeBatch } from "./processing-client.js";
import { transcodingEnabled } from "./processing-features-config.js";
import { findJobRun, upsertPendingJobRun } from "./processing-job-runs.js";
import { buildPreviewJob } from "../routes/uploads.js";
import { logger } from "./logger.js";

/**
 * Default cron expression: once nightly, at 4am (offset from the 3am hash
 * reconcile - see `hash-reconcile.js` - so the two nightly jobs don't both
 * hit the processing service at the same minute).
 *
 * @type {string}
 */
const DEFAULT_CRON = "0 4 * * *";

/**
 * Reads nightly preview-clip backfill configuration from the environment.
 *
 * @returns {{ cron: string, enabled: boolean }} Scheduler settings.
 */
export function getPreviewClipBackfillConfig() {
  const cron = (process.env.PREVIEW_CLIP_BACKFILL_CRON || DEFAULT_CRON).trim();
  const disabled = ["0", "false", "off", "no"].includes(
    String(process.env.PREVIEW_CLIP_BACKFILL_ENABLED || "true")
      .trim()
      .toLowerCase(),
  );
  return { cron, enabled: !disabled };
}

/**
 * Finds every original upload with no hover-preview clip yet
 * (`previewClipStoragePath IS NULL`), a real stored file (not an in-progress/
 * never-finished import), and that hasn't been probed as definitely lacking a
 * video stream (`hasVideoStream` false is the only value excluded - null is
 * treated the same as true, matching the fail-open convention documented on
 * that column). Does **not** check PROCESSING_JOB_RUNS itself - that's
 * `isPreviewBackfillEligible`'s job, kept separate so it can be awaited
 * per-row without loading every job run up front.
 *
 * @returns {Promise<import('sequelize').Model[]>} Candidate upload rows.
 */
export async function findUploadsMissingPreviewClip() {
  return OriginalUpload.findAll({
    where: {
      previewClipStoragePath: null,
      storagePath: { [Op.ne]: "" },
      // SQL NULL comparisons never satisfy `<>`, so `hasVideoStream: null`
      // must be listed explicitly alongside `true` - excluding only the
      // genuine `false` can't be expressed as a single not-equals check.
      [Op.or]: [{ hasVideoStream: null }, { hasVideoStream: true }],
    },
  });
}

/**
 * Decides whether a candidate upload still needs a preview-clip job enqueued,
 * by checking its current PROCESSING_JOB_RUNS row (if any) for the
 * `"preview"` kind. A row already `"pending"` or `"processing"` means a job
 * is already in flight - enqueueing another would just be duplicate ffmpeg
 * work racing the first - so this is the piece that makes the backfill safe
 * to re-run while a prior run is still draining, unlike `backfill-hls.js`'s
 * known gap. Missing, `"failed"`, or `"cancelled"` all mean yes, retry.
 * `"complete"` can't actually happen here since that would have set
 * `previewClipStoragePath` (excluded by {@link findUploadsMissingPreviewClip}
 * already), but is treated as "don't retry" anyway for safety.
 *
 * @param {number} originalUploadId Parent ORIGINAL_UPLOADS id.
 * @returns {Promise<boolean>} Whether to enqueue a preview-clip job for this upload.
 */
export async function isPreviewBackfillEligible(originalUploadId) {
  const jobRun = await findJobRun(originalUploadId, "preview");
  if (!jobRun) {
    return true;
  }
  return !["pending", "processing", "complete"].includes(jobRun.status);
}

/**
 * Enqueues a hover-preview clip packaging job for a single upload, in
 * isolation from every other upload in the batch - one failing (a network
 * blip talking to processing, say) never stops the rest from being
 * attempted.
 *
 * @param {import('sequelize').Model} upload Eligible upload row (see
 *   {@link findUploadsMissingPreviewClip} and {@link isPreviewBackfillEligible}).
 * @returns {Promise<{ videoId: string, action: "enqueued" | "failed", error?: string }>}
 *   Outcome for this upload.
 */
export async function enqueuePreviewBackfillJob(upload) {
  const segment = userStorageSegment(upload.userId);
  const previewJob = buildPreviewJob(upload, segment);
  const storedFilename = String(upload.storagePath).replace(/^original\//, "");

  const enqueue = await requestTranscodeBatch({
    filename: storedFilename,
    jobs: [previewJob],
  });

  if (!enqueue.ok) {
    return { videoId: upload.videoId, action: "failed", error: enqueue.error || "enqueue failed" };
  }
  await upsertPendingJobRun({
    originalUploadId: upload.id,
    jobKind: "preview",
    jobId: previewJob.jobId,
  });
  return { videoId: upload.videoId, action: "enqueued" };
}

/**
 * Idempotent backfill: finds every original upload that has no hover-preview
 * clip yet and no in-flight job for one (see {@link findUploadsMissingPreviewClip}
 * and {@link isPreviewBackfillEligible}), and enqueues a packaging job for
 * each. Safe to re-run at any point, including while a prior run's jobs are
 * still in flight - the PROCESSING_JOB_RUNS status check skips those rather
 * than enqueueing a duplicate. A no-op when transcoding is disabled
 * deployment-wide - there is no processing service to enqueue onto.
 *
 * @returns {Promise<{ total: number, enqueued: number, skipped: number, failed: number }>}
 *   Run summary.
 */
export async function runPreviewClipBackfill() {
  if (!transcodingEnabled()) {
    logger.info("[preview-backfill] transcoding is disabled; nothing to do.");
    return { total: 0, enqueued: 0, skipped: 0, failed: 0 };
  }

  const candidates = await findUploadsMissingPreviewClip();

  let enqueued = 0;
  let skipped = 0;
  let failed = 0;
  for (const upload of candidates) {
    const eligible = await isPreviewBackfillEligible(upload.id);
    if (!eligible) {
      skipped++;
      continue;
    }

    const result = await enqueuePreviewBackfillJob(upload);
    if (result.action === "enqueued") {
      enqueued++;
    } else {
      logger.error({ error: result.error }, `[preview-backfill] enqueue failed for ${result.videoId}`);
      failed++;
    }
  }

  logger.info(
    `[preview-backfill] run complete: total=${candidates.length} enqueued=${enqueued} skipped=${skipped} failed=${failed}`,
  );
  return { total: candidates.length, enqueued, skipped, failed };
}

/**
 * Starts the node-cron scheduler for the nightly hover-preview clip backfill.
 *
 * @returns {Promise<import('node-cron').ScheduledTask | null>} Started task, or
 *   null when disabled or the cron expression is invalid.
 */
export async function startPreviewClipBackfillCron() {
  const config = getPreviewClipBackfillConfig();
  if (!config.enabled) {
    logger.info("[preview-backfill] disabled via PREVIEW_CLIP_BACKFILL_ENABLED");
    return null;
  }

  const cron = await import("node-cron");
  if (!cron.validate(config.cron)) {
    logger.error(`[preview-backfill] invalid PREVIEW_CLIP_BACKFILL_CRON: ${config.cron}`);
    return null;
  }

  const task = cron.schedule(config.cron, () => {
    void runPreviewClipBackfill().catch((err) => {
      logger.error({ err }, "[preview-backfill] run failed");
    });
  });

  logger.info(`[preview-backfill] scheduled (${config.cron})`);
  return task;
}
