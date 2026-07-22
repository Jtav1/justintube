import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  TranscodeValidationError,
  resolveOriginalInputPath,
  validateInputFilename,
} from "../lib/media-paths.js";
import {
  enqueueTranscodeJobs,
  getTranscodeJobStatus,
  removeTranscodeJob,
} from "../lib/queue.js";
import { validateTranscodeBatchRequest } from "../lib/transcode.js";

/**
 * Creates the transcode router (`POST /`, `GET /:jobId`, `DELETE /:jobId` when
 * mounted at `/transcode`).
 *
 * @param {object} options Router dependencies.
 * @param {import('bullmq').Queue} options.queue BullMQ transcode queue.
 * @returns {import('express').Router} Router handling queue and status requests.
 */
export function createTranscodeRouter({ queue }) {
  const router = Router();

  /**
   * Queues one or more ffmpeg transcode jobs for a file under `/media/original`.
   * Accepts a legacy `{ filename, profile }` body or a batch
   * `{ filename, jobs: [...] }` body.
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success (202) or error payload.
   */
  router.post("/", async (req, res) => {
    try {
      const { filename: rawFilename, jobs } = validateTranscodeBatchRequest(
        req.body,
        { generateJobId: () => randomUUID() },
      );
      const filename = validateInputFilename(rawFilename);
      resolveOriginalInputPath(filename);

      await enqueueTranscodeJobs(queue, filename, jobs);

      const jobSummaries = jobs.map((job) => ({
        jobId: job.jobId,
        outputFilename: job.outputFilename,
        profileId: job.profile.id,
      }));

      // Preserve legacy single-job response fields when only one job was queued.
      if (jobSummaries.length === 1) {
        res.status(202).json({
          success: true,
          jobId: jobSummaries[0].jobId,
          outputFilename: jobSummaries[0].outputFilename,
          jobs: jobSummaries,
        });
        return;
      }

      res.status(202).json({
        success: true,
        jobs: jobSummaries,
      });
    } catch (err) {
      if (err instanceof TranscodeValidationError) {
        res.status(400).json({ success: false, error: err.message });
        return;
      }

      const message =
        err instanceof Error ? err.message : "failed to queue transcode";
      res.status(500).json({ success: false, error: message });
    }
  });

  /**
   * Returns BullMQ status for a previously queued transcode job.
   *
   * @param {import('express').Request} req Incoming request with `jobId` param.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON status, 404, or error payload.
   */
  router.get("/:jobId", async (req, res) => {
    try {
      const jobId = String(req.params.jobId || "").trim();
      if (!jobId) {
        res.status(400).json({
          success: false,
          error: "jobId is required",
        });
        return;
      }

      const status = await getTranscodeJobStatus(queue, jobId);
      if (!status) {
        res.status(404).json({
          success: false,
          error: "job not found",
        });
        return;
      }

      res.status(200).json({
        success: true,
        ...status,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "failed to load job status";
      res.status(500).json({ success: false, error: message });
    }
  });

  /**
   * Removes a transcode job from Redis by id.
   *
   * @param {import('express').Request} req Incoming request with `jobId` param.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success, 404, or error payload.
   */
  router.delete("/:jobId", async (req, res) => {
    try {
      const jobId = String(req.params.jobId || "").trim();
      if (!jobId) {
        res.status(400).json({
          success: false,
          error: "jobId is required",
        });
        return;
      }

      const removed = await removeTranscodeJob(queue, jobId);
      if (!removed) {
        res.status(404).json({
          success: false,
          error: "job not found",
        });
        return;
      }

      res.status(200).json({
        success: true,
        jobId,
        removed: true,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "failed to remove job";
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
