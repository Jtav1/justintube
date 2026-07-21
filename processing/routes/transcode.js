import { randomUUID } from "node:crypto";
import { Router } from "express";
import {
  TranscodeValidationError,
  resolveOriginalInputPath,
  validateInputFilename,
} from "../lib/media-paths.js";
import {
  enqueueTranscodeJob,
  getTranscodeJobStatus,
} from "../lib/queue.js";
import {
  buildOutputFilename,
  validateTranscodeRequest,
} from "../lib/transcode.js";

/**
 * Creates the transcode router (`POST /` and `GET /:jobId` when mounted at
 * `/transcode`).
 *
 * @param {object} options Router dependencies.
 * @param {import('bullmq').Queue} options.queue BullMQ transcode queue.
 * @returns {import('express').Router} Router handling queue and status requests.
 */
export function createTranscodeRouter({ queue }) {
  const router = Router();

  /**
   * Queues an ffmpeg transcode job for a file under `/media/original`.
   *
   * @param {import('express').Request} req Incoming request with
   *   `{ filename, profile }`.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends JSON success (202) or error payload.
   */
  router.post("/", async (req, res) => {
    try {
      const { filename: rawFilename, profile } = validateTranscodeRequest(
        req.body,
      );
      const filename = validateInputFilename(rawFilename);
      resolveOriginalInputPath(filename);

      const jobId = randomUUID();
      const outputFilename = buildOutputFilename(
        jobId,
        profile.outputContainer,
      );

      await enqueueTranscodeJob(queue, {
        jobId,
        inputFilename: filename,
        outputFilename,
        profile,
      });

      res.status(202).json({
        success: true,
        jobId,
        outputFilename,
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

  return router;
}
