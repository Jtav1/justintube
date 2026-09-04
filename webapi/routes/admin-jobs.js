import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { FileVersion, OriginalUpload } from "../lib/models/index.js";
import { parsePagination } from "../lib/pagination.js";
import { getProcessingHealth, getQueueHistory, getQueueJobs } from "../lib/processing-client.js";
import { VIDEO_ID_LENGTH } from "../lib/video-id.js";
import { logger } from "../lib/logger.js";

/**
 * Every processing job kind, in the fixed order the admin queue view
 * displays them.
 *
 * @type {string[]}
 */
const JOB_KINDS = ["thumbnail", "normalize", "rendition", "embed", "hash", "subtitle"];

/**
 * Default page size for `GET /admin/jobs/history` when `limit` is omitted.
 *
 * @type {number}
 */
const DEFAULT_JOB_HISTORY_LIMIT = 5;

/**
 * Builds an empty `{ waiting, prioritized, active, delayed }` bucket.
 *
 * @private
 * @returns {{ waiting: number, prioritized: number, active: number, delayed: number }} Zeroed bucket.
 */
function emptyStateBucket() {
  return { waiting: 0, prioritized: 0, active: 0, delayed: 0 };
}

/**
 * Buckets the flat non-terminal job list from `GET /queue/jobs` into
 * per-kind waiting/prioritized/active/delayed counts, seeding every known
 * job kind so the response always has a stable shape even when a kind
 * currently has no jobs at all. Every job here is enqueued with an explicit
 * priority (see processing's `JOB_PRIORITY_BY_KIND`), so in practice most
 * not-yet-running jobs land in "prioritized" rather than "waiting" - both
 * still mean "queued, not started."
 *
 * @private
 * @param {Array<{ kind: string, state: string }>} jobs Non-terminal jobs from processing.
 * @returns {{ counts: Record<string, {waiting: number, prioritized: number, active: number, delayed: number}>, total: number }}
 *   Per-kind counts plus the overall total.
 */
function summarizeQueueJobs(jobs) {
  const counts = Object.fromEntries(JOB_KINDS.map((kind) => [kind, emptyStateBucket()]));

  for (const job of jobs) {
    if (!counts[job.kind]) {
      counts[job.kind] = emptyStateBucket();
    }
    if (counts[job.kind][job.state] !== undefined) {
      counts[job.kind][job.state] += 1;
    }
  }

  return { counts, total: jobs.length };
}

/**
 * Recovers the `videoId` embedded in a `<kind>-<videoId>` or
 * `<kind>-<videoId>-<uuid>` BullMQ job id, for every kind whose jobId
 * directly encodes it. Mirrors the identically-shaped helpers duplicated
 * per internal-callback router (`videoIdFromThumbnailJobId`,
 * `videoIdFromSubtitleJobId`, `videoIdFromEmbedJobId`,
 * `videoIdFromNormalizeJobId`, `videoIdFromHashJobId`) — kept as its own
 * copy here rather than importing one of those, matching this codebase's
 * existing precedent of one small self-contained helper per caller.
 * `"rendition"` jobIds are a bare `FileVersion.uuidName` with no videoId
 * embedded at all, so they're deliberately not handled here — see
 * `resolveUploadRefs`, which looks those up via `FileVersion` instead.
 *
 * @private
 * @param {string} jobId Raw BullMQ job id.
 * @param {string} kind Job kind (`job.data.kind`, e.g. `"thumbnail"`).
 * @returns {string} The embedded video id, or an empty string when this
 *   `kind` doesn't encode one this way.
 */
function videoIdFromJobId(jobId, kind) {
  const prefix = `${kind}-`;
  if (!jobId.startsWith(prefix)) {
    return "";
  }
  const rest = jobId.slice(prefix.length);
  // thumbnail/subtitle/embed jobIds append a random uuid after the videoId
  // (so a job can be re-enqueued for the same upload without colliding with
  // BullMQ's own dedup on a prior, already-completed job with the same id -
  // see enqueueAudioEmbedVideo's rationale, routes/uploads.js) - take
  // exactly VIDEO_ID_LENGTH characters for those. normalize/hash jobIds
  // have no such suffix; the videoId is the entire remainder.
  return kind === "thumbnail" || kind === "subtitle" || kind === "embed"
    ? rest.slice(0, VIDEO_ID_LENGTH)
    : rest;
}

/**
 * Resolves each job history item's originating upload (its numeric primary
 * key and public videoId), batched across the whole page rather than
 * queried one row at a time. A job's own record never stores this — BullMQ
 * only knows the jobId string — so it has to be recovered from the jobId's
 * shape, which differs per kind (see `videoIdFromJobId`), or, for
 * `"rendition"` jobs, by looking up the `FileVersion` row whose
 * `uuidName` *is* the jobId.
 *
 * Best-effort: a job whose upload was since deleted (see
 * `cancelQueuedTranscodeJobs`) or whose jobId doesn't match any known shape
 * simply gets `uploadId: null, videoId: null` rather than failing the whole
 * history request.
 *
 * @private
 * @param {Array<{ jobId: string, kind: string }>} items Job history entries
 *   (from `getQueueHistory`), not yet enriched.
 * @returns {Promise<Array<object>>} The same items, each with `uploadId`
 *   and `videoId` added.
 */
async function resolveUploadRefs(items) {
  const directVideoIds = new Set();
  const renditionJobIds = [];
  for (const item of items) {
    if (item.kind === "rendition") {
      renditionJobIds.push(item.jobId);
      continue;
    }
    const videoId = videoIdFromJobId(item.jobId, item.kind);
    if (videoId) {
      directVideoIds.add(videoId);
    }
  }

  const [directUploads, fileVersions] = await Promise.all([
    directVideoIds.size > 0
      ? OriginalUpload.findAll({
          where: { videoId: [...directVideoIds] },
          attributes: ["id", "videoId"],
        })
      : [],
    renditionJobIds.length > 0
      ? FileVersion.findAll({
          where: { uuidName: renditionJobIds },
          attributes: ["uuidName", "originalUploadId"],
        })
      : [],
  ]);

  const uploadByVideoId = new Map(directUploads.map((u) => [u.videoId, u]));

  const renditionUploadIds = [...new Set(fileVersions.map((fv) => fv.originalUploadId))];
  const renditionUploads =
    renditionUploadIds.length > 0
      ? await OriginalUpload.findAll({
          where: { id: renditionUploadIds },
          attributes: ["id", "videoId"],
        })
      : [];
  const uploadById = new Map(renditionUploads.map((u) => [u.id, u]));
  const originalUploadIdByJobId = new Map(fileVersions.map((fv) => [fv.uuidName, fv.originalUploadId]));

  return items.map((item) => {
    let upload = null;
    if (item.kind === "rendition") {
      const originalUploadId = originalUploadIdByJobId.get(item.jobId);
      upload = originalUploadId != null ? (uploadById.get(originalUploadId) ?? null) : null;
    } else {
      const videoId = videoIdFromJobId(item.jobId, item.kind);
      upload = videoId ? (uploadByVideoId.get(videoId) ?? null) : null;
    }
    return {
      ...item,
      uploadId: upload ? upload.id : null,
      videoId: upload ? upload.videoId : null,
    };
  });
}

/**
 * Builds the admin router exposing live processing-queue visibility: a
 * job-kind-segmented count of everything currently queued/running, and a
 * paginated history of recently completed/failed jobs. Both proxy the
 * processing service over HTTP (webapi has no direct Redis/BullMQ access).
 *
 * @returns {import('express').Router} Router mounted under `/api/v1`.
 */
export function createAdminJobsRouter() {
  const router = Router();
  router.use(csrfProtection);

  /**
   * Summarizes the processing queue's currently non-terminal jobs, bucketed
   * by job kind and BullMQ state, alongside whether the processing service
   * itself is reachable/healthy (`GET /health`, the same endpoint Docker's
   * own container healthcheck polls). The two calls run in parallel; when
   * processing is unreachable, `getQueueJobs()` fails too (same HTTP target),
   * so rather than returning a bare 502 (which the admin panel would have no
   * clean way to distinguish from "you're not authorized" or a transient
   * blip), this responds 200 with `healthy: false` and an all-zero queue
   * snapshot — the admin panel renders a persistent "processing is
   * unhealthy" indicator from that flag instead of guessing from a fetch
   * failure. A queue-jobs failure with processing still reporting healthy
   * (an unusual, genuinely unexpected combination) still surfaces as a 502.
   * GET /api/v1/admin/jobs/queue
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/jobs/queue:
   *   get:
   *     tags: [Admin]
   *     summary: Summarize the live processing queue by job kind
   *     operationId: getAdminJobQueue
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: >
   *           Per-job-kind waiting/prioritized/active/delayed counts, the
   *           overall total, and whether the processing service is currently
   *           healthy
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       502:
   *         description: Processing service reachable but the queue-jobs call itself failed
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with `{ counts, total, healthy }`, or error.
   */
  router.get(
    "/admin/jobs/queue",
    requireAuth,
    requireAdmin,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      try {
        const [queueResult, healthResult] = await Promise.all([
          getQueueJobs(),
          getProcessingHealth(),
        ]);
        const healthy = healthResult.ok;

        if (!queueResult.ok) {
          if (!healthy) {
            res.status(200).json({ ...summarizeQueueJobs([]), healthy: false });
            return;
          }
          logger.error({ error: queueResult.error }, "getAdminJobQueue failed");
          res.status(502).json({
            error: "processing_unavailable",
            message: "Failed to load the processing queue.",
          });
          return;
        }

        res.status(200).json({ ...summarizeQueueJobs(queueResult.body?.jobs ?? []), healthy });
      } catch (err) {
        logger.error({ err }, "getAdminJobQueue failed");
        res.status(500).json({
          error: "internal_error",
          message: "Failed to load the processing queue.",
        });
      }
    },
  );

  /**
   * Lists the most recently completed/failed processing jobs across all job
   * kinds, newest first, paginated (5 per page by default). Each item that's
   * traceable back to an ORIGINAL_UPLOADS row (i.e. its jobId still matches
   * a known shape and that upload hasn't since been deleted) is enriched
   * with that upload's numeric `uploadId` and public `videoId`; otherwise
   * both are `null` — see `resolveUploadRefs`.
   * GET /api/v1/admin/jobs/history?page=&limit=
   * Auth: session cookie or Bearer API key; admin role required.
   *
   * @openapi
   * /api/v1/admin/jobs/history:
   *   get:
   *     tags: [Admin]
   *     summary: List recently completed/failed processing jobs
   *     operationId: getAdminJobHistory
   *     parameters:
   *       - name: page
   *         in: query
   *         schema: { type: integer, minimum: 1, default: 1 }
   *       - name: limit
   *         in: query
   *         schema: { type: integer, minimum: 1, maximum: 99, default: 5 }
   *     security:
   *       - cookieAuth: []
   *       - bearerApiKey: []
   *     responses:
   *       200:
   *         description: Paginated job history
   *       400:
   *         description: Invalid page/limit
   *       401:
   *         description: Not authenticated
   *       403:
   *         description: Not an admin
   *       502:
   *         description: Processing service unavailable
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 with `{ items, total, page, limit }`
   *   (each item additionally carrying `uploadId`/`videoId`), or error.
   */
  router.get(
    "/admin/jobs/history",
    requireAuth,
    requireAdmin,
    requireApiKeyScope("full_access"),
    async (req, res) => {
      const pagination = parsePagination({
        ...req.query,
        limit: req.query.limit ?? String(DEFAULT_JOB_HISTORY_LIMIT),
      });
      if (!pagination.ok) {
        res.status(400).json({ error: "invalid_query", message: pagination.message });
        return;
      }

      try {
        const result = await getQueueHistory({ page: pagination.page, limit: pagination.limit });
        if (!result.ok) {
          logger.error({ error: result.error }, "getAdminJobHistory failed");
          res.status(502).json({
            error: "processing_unavailable",
            message: "Failed to load job history.",
          });
          return;
        }

        const items = await resolveUploadRefs(result.body?.items ?? []);

        res.status(200).json({
          items,
          total: result.body?.total ?? 0,
          page: pagination.page,
          limit: pagination.limit,
        });
      } catch (err) {
        logger.error({ err }, "getAdminJobHistory failed");
        res.status(500).json({
          error: "internal_error",
          message: "Failed to load job history.",
        });
      }
    },
  );

  return router;
}
