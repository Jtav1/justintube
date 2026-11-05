import { Op } from "sequelize";
import { pathToFileURL } from "node:url";
import { userStorageSegment } from "../lib/media-meta.js";
import { OriginalUpload } from "../lib/models/index.js";
import { requestTranscodeBatch } from "../lib/processing-client.js";
import { upsertPendingJobRun } from "../lib/processing-job-runs.js";
import { buildHlsJob } from "../routes/uploads.js";

/**
 * Minimum width or height, in pixels, an upload must reach to be eligible for
 * "Best" quality HLS packaging - mirrors `HLS_MINIMUM_DIMENSION_PX` in
 * `processing/lib/probe.js` (which makes the authoritative call on
 * processing's side, against a fresh probe, when the job actually runs).
 * Duplicated rather than shared since the two services are separate
 * codebases; kept here only to avoid enqueueing jobs processing's own check
 * will almost always skip anyway.
 *
 * @type {number}
 */
const HLS_MINIMUM_DIMENSION_PX = 1080;

/**
 * Finds every original upload that's at least `HLS_MINIMUM_DIMENSION_PX` on
 * its width or height, has a real stored file (not an in-progress/never-
 * finished import), and has no "Best" quality HLS stream yet
 * (`hlsPlaylistStoragePath IS NULL`) - the same condition `GET /videos/:id`
 * uses to decide whether to advertise the "best" rendition, so this and that
 * route never disagree about what "doesn't have one yet" means.
 *
 * @returns {Promise<import('sequelize').Model[]>} Eligible upload rows.
 */
export async function findUploadsMissingHls() {
  return OriginalUpload.findAll({
    where: {
      hlsPlaylistStoragePath: null,
      storagePath: { [Op.ne]: "" },
      [Op.or]: [
        { videoWidth: { [Op.gte]: HLS_MINIMUM_DIMENSION_PX } },
        { videoHeight: { [Op.gte]: HLS_MINIMUM_DIMENSION_PX } },
      ],
    },
  });
}

/**
 * Enqueues a "Best" quality HLS packaging job for a single upload, in
 * isolation from every other upload in the batch - one failing (a network
 * blip talking to processing, say) never stops the rest from being
 * attempted.
 *
 * @param {import('sequelize').Model} upload Eligible upload row (see
 *   {@link findUploadsMissingHls}).
 * @returns {Promise<{ videoId: string, action: "enqueued" | "failed", error?: string }>}
 *   Outcome for this upload.
 */
export async function enqueueHlsBackfillJob(upload) {
  const segment = userStorageSegment(upload.userId);
  const hlsJob = buildHlsJob(upload, segment);
  const storedFilename = String(upload.storagePath).replace(/^original\//, "");

  const enqueue = await requestTranscodeBatch({
    filename: storedFilename,
    jobs: [hlsJob],
  });

  if (!enqueue.ok) {
    return { videoId: upload.videoId, action: "failed", error: enqueue.error || "enqueue failed" };
  }
  await upsertPendingJobRun({ originalUploadId: upload.id, jobKind: "hls", jobId: hlsJob.jobId });
  return { videoId: upload.videoId, action: "enqueued" };
}

/**
 * Idempotent backfill: finds every original upload that qualifies for "Best"
 * quality HLS (>=1080px on width or height) but doesn't have one yet, and
 * enqueues a packaging job for each. Safe to re-run - an upload whose job
 * already completed (`hlsPlaylistStoragePath` set) simply won't be selected
 * again by {@link findUploadsMissingHls}. Re-running while a prior run's
 * jobs are still in flight can enqueue a duplicate for those specific
 * uploads (there's no "job already queued" tracking column, same as every
 * other job kind in this codebase) - harmless beyond the wasted ffmpeg work,
 * since both jobs would just report the same successful result.
 *
 * @returns {Promise<{ total: number, enqueued: number, failed: number }>} Run summary.
 */
export async function runHlsBackfill() {
  const uploads = await findUploadsMissingHls();
  console.log(`Found ${uploads.length} upload(s) eligible for "Best" quality HLS backfill.`);

  let enqueued = 0;
  let failed = 0;
  for (const upload of uploads) {
    const result = await enqueueHlsBackfillJob(upload);
    if (result.action === "enqueued") {
      console.log(`[enqueued] ${result.videoId}`);
      enqueued++;
    } else {
      console.error(`[failed] ${result.videoId}: ${result.error}`);
      failed++;
    }
  }

  console.log(`Backfill complete: enqueued=${enqueued} failed=${failed} total=${uploads.length}`);
  return { total: uploads.length, enqueued, failed };
}

/**
 * Run with `npm run backfill-hls` (inside the `justintube-api` container in
 * production: `docker compose exec webapi npm run backfill-hls`). Requires
 * the processing service to be reachable.
 *
 * @returns {Promise<void>} Resolves once the backfill run completes.
 */
async function main() {
  console.log("Starting HLS backfill ...");
  await runHlsBackfill();
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("backfill-hls failed:", err);
    process.exit(1);
  });
}
