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
import {
  probeVideoDimensions,
  probeVideoDuration,
  shouldSkipProfileForOrientation,
  shouldSkipProfileForSource,
} from "../lib/probe.js";
import {
  getTranscodeConfig,
  shouldSkipHardwareProfile,
  validateTranscodeBatchRequest,
} from "../lib/transcode.js";
import { logger } from "../lib/logger.js";

/**
 * Creates the transcode router (`POST /`, `GET /:jobId`, `DELETE /:jobId` when
 * mounted at `/transcode`).
 *
 * @param {object} options Router dependencies.
 * @param {import('bullmq').Queue} options.queue BullMQ transcode queue.
 * @param {(inputPath: string) => Promise<{ videoWidth: number|null, videoHeight: number|null }>}
 *   [options.probeInput] Optional probe override (defaults to ffprobe).
 * @param {(inputPath: string) => Promise<number|null>} [options.probeDuration]
 *   Optional duration probe override (defaults to ffprobe), used to validate
 *   thumbnail-job timestamps.
 * @returns {import('express').Router} Router handling queue and status requests.
 */
export function createTranscodeRouter({
  queue,
  probeInput = probeVideoDimensions,
  probeDuration = probeVideoDuration,
}) {
  const router = Router();

  /**
   * Queues one or more ffmpeg transcode jobs for a file under `/media/original`.
   * Accepts a legacy `{ filename, profile }` body or a batch
   * `{ filename, jobs: [...] }` body.
   *
   * Profiles that would upscale the source (output width/height greater than
   * the probed source) are skipped, as are hardware-accelerated profiles
   * when hardware transcoding isn't currently usable on this deployment or
   * this profile's codec isn't in the configured encoder allowlist. Finally,
   * profiles whose orientation (horizontal/vertical) doesn't match the
   * source's orientation are skipped; remaining jobs are enqueued normally.
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
      const inputPath = resolveOriginalInputPath(filename);

      logger.info(`[transcode] batch request received: ${filename} (${jobs.length} job(s) requested)`);

      /** @type {{ videoWidth: number|null, videoHeight: number|null }} */
      let source = { videoWidth: null, videoHeight: null };
      try {
        source = await probeInput(inputPath);
      } catch (err) {
        logger.error({ err }, "ffprobe failed for transcode input; enqueueing all profiles");
      }

      // Duration is a source-level fact (not per-rendition), probed separately
      // from `probeInput` since that hook's contract (and its test override)
      // is scoped to the resolution-skip decision above.
      let durationSeconds = null;
      try {
        durationSeconds = await probeDuration(inputPath);
      } catch (err) {
        logger.error({ err }, "ffprobe failed to read duration for transcode input");
      }

      // Resolve the final thumbnail timestamp before enqueueing: null (no
      // preference) or a value past the video's actual duration both fall
      // back to a random timestamp within the video. When duration probing
      // itself failed, there's nothing to validate against — pass whatever
      // was given through as-is (ffmpeg's -ss will fail closed like a bad
      // rendition would).
      for (const job of jobs) {
        if (job.kind !== "thumbnail" || durationSeconds == null) {
          continue;
        }
        if (
          job.timestampSeconds == null ||
          job.timestampSeconds > durationSeconds ||
          job.timestampSeconds < 0
        ) {
          job.timestampSeconds = Math.round(Math.random() * durationSeconds * 10) / 10;
        }
      }

      /** @type {typeof jobs} */
      const accepted = [];
      /** @type {Array<{ jobId: string, profileId: number, reason: string }>} */
      const skipped = [];
      const hardwareConfig = getTranscodeConfig();

      for (const job of jobs) {
        if (job.kind === "rendition" && shouldSkipProfileForSource(job.profile, source)) {
          skipped.push({
            jobId: job.jobId,
            profileId: job.profile.id,
            reason: "profile_exceeds_source_resolution",
          });
          continue;
        }
        if (job.kind === "rendition") {
          const hardwareSkipReason = shouldSkipHardwareProfile(
            job.profile,
            hardwareConfig,
          );
          if (hardwareSkipReason) {
            skipped.push({
              jobId: job.jobId,
              profileId: job.profile.id,
              reason: hardwareSkipReason,
            });
            continue;
          }
        }
        if (
          job.kind === "rendition" &&
          shouldSkipProfileForOrientation(job.profile, source)
        ) {
          skipped.push({
            jobId: job.jobId,
            profileId: job.profile.id,
            reason: "profile_orientation_mismatch",
          });
          continue;
        }
        accepted.push(job);
      }

      if (skipped.length > 0) {
        logger.info(
          `[transcode] batch skipped ${skipped.length} job(s) for ${filename}: ` +
            skipped.map((s) => `${s.jobId}(${s.reason})`).join(", "),
        );
      }

      if (accepted.length > 0) {
        await enqueueTranscodeJobs(queue, filename, accepted);
      }

      const jobSummaries = accepted.map((job) => ({
        jobId: job.jobId,
        outputFilename: job.outputFilename,
        profileId: job.profile?.id ?? null,
      }));

      const payload = {
        success: true,
        jobs: jobSummaries,
        skipped,
        source: {
          videoWidth: source.videoWidth,
          videoHeight: source.videoHeight,
          durationSeconds,
        },
      };

      // Preserve legacy single-job response fields when exactly one job queued.
      if (jobSummaries.length === 1 && skipped.length === 0) {
        res.status(202).json({
          ...payload,
          jobId: jobSummaries[0].jobId,
          outputFilename: jobSummaries[0].outputFilename,
        });
        return;
      }

      logger.info(
        `[transcode] batch request accepted: ${jobSummaries.length} job(s) enqueued, ${skipped.length} skipped for ${filename}`,
      );

      res.status(202).json(payload);
    } catch (err) {
      if (err instanceof TranscodeValidationError) {
        logger.warn(`[transcode] batch request rejected: ${err.message}`);
        res.status(400).json({ success: false, error: err.message });
        return;
      }

      const message =
        err instanceof Error ? err.message : "failed to queue transcode";
      logger.error({ message }, "[transcode] batch request failed");
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
      logger.error({ message }, "[transcode] status lookup failed");
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
      logger.error({ message }, "[transcode] job removal failed");
      res.status(500).json({ success: false, error: message });
    }
  });

  return router;
}
