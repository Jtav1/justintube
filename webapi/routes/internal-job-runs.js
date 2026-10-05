import { Router } from "express";
import { markJobRunProcessing } from "../lib/processing-job-runs.js";
import { timingSafeStringEqual } from "../lib/auth/timing-safe-equal.js";

/**
 * Express middleware that requires `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>`.
 * Duplicated from `internal-thumbnails.js` rather than shared, matching that
 * file's existing precedent of one small self-contained internal router per
 * caller.
 *
 * @private
 * @param {import('express').Request} req Incoming request.
 * @param {import('express').Response} res Express response.
 * @param {import('express').NextFunction} next Continues when authorized.
 * @returns {void} Sends 401/503 when the token is missing, mismatched, or unconfigured.
 */
function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_TOKEN || "";
  if (!expected) {
    res.status(503).json({
      error: "internal_auth_unconfigured",
      message: "INTERNAL_SERVICE_TOKEN is not configured.",
    });
    return;
  }

  const header = String(req.headers.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header);
  const provided = match ? match[1].trim() : "";
  if (!timingSafeStringEqual(expected, provided)) {
    res.status(401).json({
      error: "unauthorized",
      message: "Valid internal service token required.",
    });
    return;
  }

  next();
}

/**
 * Builds the router for processing → API generic job-run lifecycle
 * callbacks - currently just the "a worker picked this job up" signal, the
 * middle state of PROCESSING_JOB_RUNS' pending -> processing ->
 * complete/failed/cancelled lifecycle (see `lib/processing-job-runs.js`).
 * Unlike every kind-specific internal router (`internal-hls.js`,
 * `internal-thumbnails.js`, ...), this one needs no videoId/upload lookup at
 * all - just the bare jobId, since `markJobRunProcessing` matches on that
 * column directly.
 *
 * @returns {import('express').Router} Router mounted at `/internal`.
 */
export function createInternalJobRunsRouter() {
  const router = Router();
  router.use(requireInternalToken);

  /**
   * Marks a job run `"processing"` once a worker actually picks it up.
   * A no-op (still 200) when `jobId` doesn't match any row's current jobId -
   * e.g. it was superseded by a fresher re-enqueue, or processing is calling
   * back for a job kind/situation this ledger never recorded a pending row
   * for - this callback is purely advisory and never blocks the job itself.
   * POST /internal/job-runs/:jobId/start.
   * Auth: Bearer INTERNAL_SERVICE_TOKEN (router-level).
   *
   * @openapi
   * /internal/job-runs/{jobId}/start:
   *   post:
   *     tags: [Internal]
   *     summary: Mark a queued job as actively processing
   *     operationId: jobRunStarted
   *     security:
   *       - internalServiceToken: []
   *     parameters:
   *       - name: jobId
   *         in: path
   *         required: true
   *         schema: { type: string }
   *     responses:
   *       200:
   *         description: Acknowledged (whether or not a matching row existed)
   *       400:
   *         description: Missing jobId
   *
   * @param {import('express').Request} req Request with `jobId` param.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends 200 or 400.
   */
  router.post("/job-runs/:jobId/start", async (req, res) => {
    const jobId = String(req.params.jobId || "").trim();
    if (!jobId) {
      res.status(400).json({
        success: false,
        error: "missing_job_id",
        message: "jobId is required.",
      });
      return;
    }

    await markJobRunProcessing(jobId);

    res.status(200).json({ success: true });
  });

  return router;
}
