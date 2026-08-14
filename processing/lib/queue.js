import { stat } from "node:fs/promises";
import { Queue, Worker } from "bullmq";
import {
  notifyContentHashComplete,
  notifyContentHashFailed,
  notifyFileVersionComplete,
  notifyFileVersionFailed,
  notifyThumbnailComplete,
} from "./api-client.js";
import {
  resolveOriginalInputPath,
  resolveThumbnailOutputPath,
  resolveTranscodedOutputPath,
} from "./media-paths.js";
import { collectOutputMetadata, computeContentHash } from "./probe.js";
import { buildFfmpegArgs, buildThumbnailFfmpegArgs, runFfmpeg } from "./transcode.js";
import { logger } from "./logger.js";

/**
 * BullMQ queue name for ffmpeg transcode jobs.
 *
 * @type {string}
 */
export const TRANSCODE_QUEUE_NAME = "transcode";

/**
 * Maximum number of times a duplicate-upload content-hash job may run
 * (counting its original attempt, any of BullMQ's own automatic
 * attempts/backoff retries, and every retry the nightly hash-reconcile cron
 * triggers) before {@link retryFailedHashJobs} discards it instead of
 * retrying it again.
 *
 * @type {number}
 */
export const MAX_HASH_JOB_RUNS = 7;

/**
 * Builds an ioredis-compatible connection options object for BullMQ.
 *
 * @param {object} [overrides] Optional host/port/password overrides for tests.
 * @param {string} [overrides.host] Redis hostname.
 * @param {number} [overrides.port] Redis port.
 * @param {string} [overrides.password] Redis auth password.
 * @returns {{ host: string, port: number, password: string|undefined, maxRetriesPerRequest: null }}
 *   Connection options suitable for Queue and Worker constructors.
 */
export function createRedisConnection(overrides = {}) {
  return {
    host: overrides.host || process.env.REDIS_HOST || "127.0.0.1",
    port: Number(overrides.port || process.env.REDIS_PORT || 6379),
    password: overrides.password || process.env.REDIS_PASSWORD || undefined,
    // Required by BullMQ so blocking commands are not buffered for retries.
    maxRetriesPerRequest: null,
  };
}

/**
 * Creates the BullMQ Queue used to enqueue and look up transcode jobs.
 *
 * @param {object} connection Redis connection options from
 *   {@link createRedisConnection}.
 * @returns {import('bullmq').Queue} Configured transcode queue.
 */
export function createTranscodeQueue(connection) {
  return new Queue(TRANSCODE_QUEUE_NAME, {
    connection,
    defaultJobOptions: {
      // Keep completed/failed jobs in Redis so GET /transcode/:jobId works.
      removeOnComplete: false,
      removeOnFail: false,
      // Retry transient failures (network blips, momentary ffmpeg/yt-dlp
      // errors) instead of failing permanently on the first attempt.
      attempts: Number(process.env.TRANSCODE_JOB_ATTEMPTS) || 3,
      backoff: { type: "exponential", delay: 5000 },
    },
  });
}

/**
 * Processes a single thumbnail (frame-extraction) job: resolve paths, run
 * ffmpeg, confirm the output exists, and notify the API. Unlike rendition
 * jobs, no FILE_VERSIONS row exists for a thumbnail, so there's no
 * width/height/resolution metadata to collect — the API only needs the
 * output filename.
 *
 * @private
 * @param {import('bullmq').Job} job BullMQ job whose data includes
 *   `inputFilename`, `outputFilename`, and `timestampSeconds`.
 * @returns {Promise<{ outputFilename: string }>} Result payload stored on the completed job.
 * @throws {Error} When the input is missing or ffmpeg fails.
 */
async function processThumbnailJob(job) {
  const { inputFilename, outputFilename, timestampSeconds } = job.data;
  const jobId = String(job.id);

  logger.info(`[thumbnail ${jobId}] processing started: ${inputFilename} -> ${outputFilename} @ ${timestampSeconds}s`);

  await job.updateProgress(10);

  const inputPath = resolveOriginalInputPath(inputFilename);
  const outputPath = resolveThumbnailOutputPath(outputFilename);
  const args = buildThumbnailFfmpegArgs({ inputPath, outputPath, timestampSeconds });

  await job.updateProgress(40);
  await runFfmpeg(args);
  await stat(outputPath);
  await job.updateProgress(80);

  const notify = await notifyThumbnailComplete(jobId, { thumbnailFilename: outputFilename });
  if (!notify.ok) {
    logger.error({ error: notify.error }, `failed to notify API of completed thumbnail ${jobId}`);
  }

  await job.updateProgress(100);

  logger.info(`[thumbnail ${jobId}] processing completed: ${outputFilename}`);

  return { outputFilename };
}

/**
 * Processes a single duplicate-upload content-hash job: probe the source
 * file's decoded video stream with ffmpeg and notify the API of the result.
 * No output file is written, so unlike rendition/thumbnail jobs there's
 * nothing to resolve an output path for.
 *
 * Persists a `runCount` on the job's own data (in Redis, alongside the job)
 * incremented at the start of every execution - whether this run was kicked
 * off by BullMQ's own attempts/backoff, or by the nightly hash-reconcile
 * cron retrying a job that had already landed in the failed state. This is
 * what {@link retryFailedHashJobs} checks against {@link MAX_HASH_JOB_RUNS}
 * to decide whether a failed job is retried again or discarded outright.
 *
 * @private
 * @param {import('bullmq').Job} job BullMQ job whose data includes `inputFilename`.
 * @returns {Promise<{ contentHash: string }>} Result payload stored on the completed job.
 * @throws {Error} When the input is missing or ffmpeg fails.
 */
async function processHashJob(job) {
  const { inputFilename } = job.data;
  const jobId = String(job.id);

  const runCount = (Number(job.data.runCount) || 0) + 1;
  await job.updateData({ ...job.data, runCount });

  logger.info(`[hash ${jobId}] processing started (run ${runCount}/${MAX_HASH_JOB_RUNS}): ${inputFilename}`);

  await job.updateProgress(20);

  const inputPath = resolveOriginalInputPath(inputFilename);
  const contentHash = await computeContentHash(inputPath);

  await job.updateProgress(90);

  const notify = await notifyContentHashComplete(jobId, { contentHash });
  if (!notify.ok) {
    logger.error({ error: notify.error }, `failed to notify API of computed hash ${jobId}`);
  }

  await job.updateProgress(100);

  logger.info(`[hash ${jobId}] processing completed: ${contentHash}`);

  return { contentHash };
}

/**
 * Processes a single rendition transcode job: resolve paths, run ffmpeg,
 * collect metadata, notify the API, and return the result payload.
 *
 * @private
 * @param {import('bullmq').Job} job BullMQ job whose data includes
 *   `inputFilename`, `outputFilename`, and `profile`.
 * @returns {Promise<{
 *   outputFilename: string,
 *   profileId: number,
 *   fileSizeBytes: number,
 *   videoWidth: number|null,
 *   videoHeight: number|null,
 *   resolution: string|null,
 *   storagePath: string,
 *   mimeType: string|null
 * }>} Result payload stored on the completed job.
 * @throws {Error} When the input is missing or ffmpeg fails.
 */
async function processRenditionJob(job) {
  const { inputFilename, outputFilename, profile } = job.data;
  const jobId = String(job.id);

  logger.info(`[rendition ${jobId}] processing started: ${inputFilename} -> ${outputFilename} (profile ${profile?.id})`);

  await job.updateProgress(10);

  const inputPath = resolveOriginalInputPath(inputFilename);
  const outputPath = resolveTranscodedOutputPath(outputFilename);
  const args = buildFfmpegArgs({ inputPath, outputPath, profile });

  await job.updateProgress(40);
  await runFfmpeg(args);
  await job.updateProgress(80);

  const metadata = await collectOutputMetadata({
    outputPath,
    outputFilename,
    outputContainer: profile.outputContainer,
  });

  const notify = await notifyFileVersionComplete(jobId, metadata);
  if (!notify.ok) {
    logger.error({ error: notify.error }, `failed to notify API of completed transcode ${jobId}`);
  }

  await job.updateProgress(100);

  logger.info(`[rendition ${jobId}] processing completed: ${outputFilename} (${metadata.resolution ?? "unknown resolution"}, ${metadata.fileSizeBytes} bytes)`);

  return {
    outputFilename,
    profileId: profile.id,
    fileSizeBytes: metadata.fileSizeBytes,
    videoWidth: metadata.videoWidth,
    videoHeight: metadata.videoHeight,
    resolution: metadata.resolution,
    storagePath: metadata.storagePath,
    mimeType: metadata.mimeType,
  };
}

/**
 * Processes a single queued job, dispatching on `job.data.kind`.
 *
 * @param {import('bullmq').Job} job BullMQ job (`data.kind` is `"thumbnail"`,
 *   `"hash"`, or `"rendition"`).
 * @returns {Promise<object>} Result payload stored on the completed job.
 * @throws {Error} When the input is missing or ffmpeg fails.
 */
export async function processTranscodeJob(job) {
  const kind = job.data?.kind || "rendition";
  logger.info(`[worker] dequeued job ${job.id} (${kind})`);

  if (kind === "thumbnail") {
    return processThumbnailJob(job);
  }
  if (kind === "hash") {
    return processHashJob(job);
  }
  return processRenditionJob(job);
}

/**
 * Creates a BullMQ Worker that processes the transcode queue with ffmpeg.
 *
 * @param {object} connection Redis connection options from
 *   {@link createRedisConnection}.
 * @param {(job: import('bullmq').Job) => Promise<unknown>} [processor]
 *   Optional processor override for tests (defaults to
 *   {@link processTranscodeJob}).
 * @returns {import('bullmq').Worker} Started worker instance.
 */
export function createTranscodeWorker(
  connection,
  processor = processTranscodeJob,
) {
  return new Worker(TRANSCODE_QUEUE_NAME, processor, {
    connection,
    concurrency: 1,
  });
}

/**
 * Enqueues a transcode job with a caller-supplied job id and output filename.
 *
 * @param {import('bullmq').Queue} queue Transcode queue instance.
 * @param {object} options Job payload and identifiers.
 * @param {string} options.jobId Stable job identifier returned to the client.
 * @param {string} options.inputFilename Basename under `/media/original`.
 * @param {string} options.outputFilename Basename under `/media/transcoded`.
 * @param {import('./transcode.js').TranscodeProfilePayload} options.profile
 *   Validated profile fields.
 * @returns {Promise<import('bullmq').Job>} The created BullMQ job.
 */
export async function enqueueTranscodeJob(queue, options) {
  const { jobId, inputFilename, outputFilename, profile } = options;

  logger.info(`[rendition ${jobId}] enqueued: ${inputFilename} -> ${outputFilename} (profile ${profile?.id})`);

  return queue.add(
    "ffmpeg-transcode",
    { inputFilename, outputFilename, profile },
    { jobId },
  );
}

/**
 * Enqueues multiple transcode jobs for the same input file.
 *
 * @param {import('bullmq').Queue} queue Transcode queue instance.
 * @param {string} inputFilename Basename under `/media/original`.
 * @param {Array<import('./transcode.js').ValidatedTranscodeJob>} jobs Validated job descriptors.
 * @returns {Promise<import('bullmq').Job[]>} Created BullMQ jobs.
 */
export async function enqueueTranscodeJobs(queue, inputFilename, jobs) {
  for (const job of jobs) {
    logger.info(
      `[${job.kind} ${job.jobId}] enqueued: ${inputFilename} -> ${job.outputFilename}` +
        (job.kind === "rendition" ? ` (profile ${job.profile?.id})` : ""),
    );
  }

  return queue.addBulk(
    jobs.map((job) => ({
      name:
        job.kind === "thumbnail"
          ? "ffmpeg-thumbnail"
          : job.kind === "hash"
            ? "ffmpeg-hash"
            : "ffmpeg-transcode",
      data: {
        inputFilename,
        outputFilename: job.outputFilename,
        kind: job.kind,
        profile: job.profile,
        timestampSeconds: job.timestampSeconds,
      },
      opts: { jobId: job.jobId },
    })),
  );
}

/**
 * Loads a transcode job by id and maps it to a status payload for the API.
 *
 * @param {import('bullmq').Queue} queue Transcode queue instance.
 * @param {string} jobId Job identifier from POST `/transcode`.
 * @returns {Promise<object | null>} Status object, or `null` if not found.
 */
export async function getTranscodeJobStatus(queue, jobId) {
  const job = await queue.getJob(jobId);
  if (!job) {
    return null;
  }

  const state = await job.getState();
  const progress =
    typeof job.progress === "number" ? job.progress : Number(job.progress) || 0;

  logger.info(`[job ${jobId}] status queried: state=${state}, progress=${progress}`);

  return {
    jobId: String(job.id),
    state,
    progress,
    outputFilename: job.data?.outputFilename ?? null,
    profileId: job.data?.profile?.id ?? null,
    failedReason: job.failedReason || null,
    returnvalue: job.returnvalue ?? null,
    // Only ever set for kind: "hash" jobs (see processHashJob) - null for
    // rendition/thumbnail jobs, which don't track this.
    runCount: job.data?.runCount ?? null,
  };
}

/**
 * Removes a transcode job from Redis by id (any state).
 *
 * @param {import('bullmq').Queue} queue Transcode queue instance.
 * @param {string} jobId Job identifier to remove.
 * @returns {Promise<boolean>} `true` when a job was found and removed.
 */
export async function removeTranscodeJob(queue, jobId) {
  const job = await queue.getJob(jobId);
  if (!job) {
    logger.info(`[job ${jobId}] remove requested: not found`);
    return false;
  }
  await job.remove();
  logger.info(`[job ${jobId}] removed`);
  return true;
}

/**
 * Finds every failed BullMQ job of kind `"hash"` and either moves it back to
 * the wait queue for reprocessing, or - once it's already run
 * {@link MAX_HASH_JOB_RUNS} times (per the `runCount` {@link processHashJob}
 * persists on the job's own data) - discards it outright rather than
 * retrying forever. A failed hash job is deliberately left in Redis
 * (`removeOnFail: false` on the queue, set in {@link createTranscodeQueue})
 * rather than requeued automatically, so this is what actually resurfaces
 * it — driven by webapi's nightly duplicate-hash reconcile cron rather than
 * anything in-process here.
 *
 * @param {import('bullmq').Queue} queue Transcode queue instance.
 * @returns {Promise<{
 *   retried: string[],
 *   discarded: string[],
 *   failed: Array<{ jobId: string, error: string }>
 * }>} Job ids retried, job ids discarded after reaching the run cap, and any
 *   that errored while retrying/discarding.
 */
export async function retryFailedHashJobs(queue) {
  const failedJobs = await queue.getJobs(["failed"]);
  const hashJobs = failedJobs.filter((job) => job.data?.kind === "hash");

  /** @type {string[]} */
  const retried = [];
  /** @type {string[]} */
  const discarded = [];
  /** @type {Array<{ jobId: string, error: string }>} */
  const failed = [];

  for (const job of hashJobs) {
    const jobId = String(job.id);
    const runCount = Number(job.data?.runCount) || 0;

    if (runCount >= MAX_HASH_JOB_RUNS) {
      try {
        await job.remove();
        discarded.push(jobId);
        logger.warn(`[hash ${jobId}] discarded after ${runCount} run(s) (max ${MAX_HASH_JOB_RUNS})`);
      } catch (err) {
        const message = err instanceof Error ? err.message : "discard failed";
        failed.push({ jobId, error: message });
        logger.error({ err }, `[hash ${jobId}] failed to discard after reaching max runs`);
      }
      continue;
    }

    try {
      await job.retry();
      retried.push(jobId);
      logger.info(`[hash ${jobId}] retried by reconcile (run ${runCount}/${MAX_HASH_JOB_RUNS})`);
    } catch (err) {
      const message = err instanceof Error ? err.message : "retry failed";
      failed.push({ jobId, error: message });
      logger.error({ err }, `[hash ${jobId}] retry by reconcile failed`);
    }
  }

  return { retried, discarded, failed };
}

/**
 * Notifies the API that a BullMQ job failed (best-effort). Thumbnail jobs
 * have no pending placeholder row to roll back (unlike FILE_VERSIONS, no
 * VIDEO_THUMBNAIL row exists until success), so a failed thumbnail job just
 * logs locally rather than calling back to the API. Hash jobs also call back
 * on failure purely so the API can log it — hashing runs entirely in the
 * background after the upload is already live, so there is nothing to roll
 * back or release either way.
 *
 * @param {import('bullmq').Job | undefined} job Failed job, when available.
 * @param {Error | undefined} err Failure reason.
 * @returns {Promise<void>} Resolves after the callback attempt finishes.
 */
export async function notifyTranscodeJobFailed(job, err) {
  const jobId = job?.id != null ? String(job.id) : "";
  if (!jobId) {
    return;
  }
  const message =
    err instanceof Error
      ? err.message
      : typeof job?.failedReason === "string" && job.failedReason
        ? job.failedReason
        : "transcode failed";

  if (job?.data?.kind === "thumbnail") {
    logger.error({ message }, `[thumbnail ${jobId}] processing failed`);
    return;
  }

  if (job?.data?.kind === "hash") {
    logger.error({ message }, `[hash ${jobId}] processing failed`);
    const notify = await notifyContentHashFailed(jobId, message);
    if (!notify.ok) {
      logger.error({ error: notify.error }, `failed to notify API of failed hash job ${jobId}`);
    }
    return;
  }

  logger.error({ message }, `[rendition ${jobId}] processing failed`);
  const notify = await notifyFileVersionFailed(jobId, message);
  if (!notify.ok) {
    logger.error({ error: notify.error }, `failed to notify API of failed transcode ${jobId}`);
  }
}

/**
 * Closes BullMQ queue and worker resources gracefully.
 *
 * @param {object} resources Open queue/worker handles.
 * @param {import('bullmq').Queue | null | undefined} [resources.queue] Queue.
 * @param {import('bullmq').Worker | null | undefined} [resources.worker] Worker.
 * @returns {Promise<void>} Resolves after both are closed (when present).
 */
export async function closeTranscodeResources({ queue, worker } = {}) {
  const tasks = [];
  if (worker) {
    tasks.push(worker.close());
  }
  if (queue) {
    tasks.push(queue.close());
  }
  await Promise.all(tasks);
}
