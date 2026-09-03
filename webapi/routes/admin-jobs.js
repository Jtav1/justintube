import { Router } from "express";
import { csrfProtection } from "../lib/auth/csrf.js";
import { requireAdmin } from "../lib/auth/require-admin.js";
import { requireApiKeyScope } from "../lib/auth/require-api-key-scope.js";
import { requireAuth } from "../lib/auth/require-auth.js";
import { parsePagination } from "../lib/pagination.js";
import { getProcessingHealth, getQueueHistory, getQueueJobs } from "../lib/processing-client.js";
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
   * kinds, newest first, paginated (5 per page by default).
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
   * @returns {Promise<void>} Sends 200 with `{ items, total, page, limit }`, or error.
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

        res.status(200).json({
          items: result.body?.items ?? [],
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
