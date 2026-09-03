import { Router } from "express";
import { getQueueHistory, getQueueJobs } from "../lib/queue.js";
import { logger } from "../lib/logger.js";

/**
 * Default page size for `GET /history` when `limit` is omitted.
 *
 * @type {number}
 */
const DEFAULT_HISTORY_LIMIT = 5;

/**
 * Maximum page size accepted by `GET /history`.
 *
 * @type {number}
 */
const MAX_HISTORY_LIMIT = 100;

/**
 * Parses and validates `page`/`limit` query params for `GET /history`.
 *
 * @param {import('express').Request['query']} query Raw Express query object.
 * @returns {{ ok: true, page: number, limit: number } | { ok: false, message: string }}
 *   Parsed pagination, or a validation error.
 */
function parseHistoryPagination(query) {
  const page = query.page === undefined ? 1 : Number(query.page);
  if (!Number.isInteger(page) || page < 1) {
    return { ok: false, message: "page must be a positive integer" };
  }

  const limit = query.limit === undefined ? DEFAULT_HISTORY_LIMIT : Number(query.limit);
  if (!Number.isInteger(limit) || limit < 1) {
    return { ok: false, message: "limit must be a positive integer" };
  }
  if (limit > MAX_HISTORY_LIMIT) {
    return { ok: false, message: `limit must be at most ${MAX_HISTORY_LIMIT}` };
  }

  return { ok: true, page, limit };
}

/**
 * Creates the queue-introspection router (`GET /jobs`, `GET /history` when
 * mounted at `/queue`). A sibling of `/transcode` rather than nested under
 * it, so these aggregate-read routes never collide with `/transcode/:jobId`.
 *
 * @param {object} options Router dependencies.
 * @param {import('bullmq').Queue} options.queue BullMQ transcode queue.
 * @returns {import('express').Router} Router handling queue-summary requests.
 */
export function createQueueRouter({ queue }) {
  const router = Router();

  /**
   * Lists every currently non-terminal (waiting/prioritized/active/delayed)
   * job across all job kinds. Used by webapi to build the admin queue-summary
   * view and to check a specific video's outstanding jobs.
   *
   * @param {import('express').Request} _req Incoming request (unused).
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON job list, or an error payload.
   */
  router.get("/jobs", async (_req, res) => {
    try {
      const jobs = await getQueueJobs(queue);
      res.status(200).json({ success: true, jobs });
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed to list queue jobs";
      logger.error({ message }, "[queue] jobs listing failed");
      res.status(500).json({ success: false, error: message });
    }
  });

  /**
   * Lists the most recently completed/failed jobs across all job kinds,
   * newest first, paginated (`page`, `limit`, default `limit=5`).
   *
   * @param {import('express').Request} req Incoming request with `page`/`limit` query params.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON history page, or an error payload.
   */
  router.get("/history", async (req, res) => {
    const parsed = parseHistoryPagination(req.query);
    if (!parsed.ok) {
      res.status(400).json({ success: false, error: parsed.message });
      return;
    }

    try {
      const { items, total, page, limit } = await getQueueHistory(queue, {
        page: parsed.page,
        limit: parsed.limit,
      });
      res.status(200).json({ success: true, items, total, page, limit });
    } catch (err) {
      const message = err instanceof Error ? err.message : "failed to list queue history";
      logger.error({ message }, "[queue] history listing failed");
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
