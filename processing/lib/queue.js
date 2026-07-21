import { Queue, Worker } from "bullmq";
import {
  resolveOriginalInputPath,
  resolveTranscodedOutputPath,
} from "./media-paths.js";
import { buildFfmpegArgs, runFfmpeg } from "./transcode.js";

/**
 * BullMQ queue name for ffmpeg transcode jobs.
 *
 * @type {string}
 */
export const TRANSCODE_QUEUE_NAME = "transcode";

/**
 * Builds an ioredis-compatible connection options object for BullMQ.
 *
 * @param {object} [overrides] Optional host/port overrides for tests.
 * @param {string} [overrides.host] Redis hostname.
 * @param {number} [overrides.port] Redis port.
 * @returns {{ host: string, port: number, maxRetriesPerRequest: null }}
 *   Connection options suitable for Queue and Worker constructors.
 */
export function createRedisConnection(overrides = {}) {
  return {
    host: overrides.host || process.env.REDIS_HOST || "127.0.0.1",
    port: Number(overrides.port || process.env.REDIS_PORT || 6379),
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
    },
  });
}

/**
 * Processes a single transcode job: resolve paths, run ffmpeg, return result.
 *
 * @param {import('bullmq').Job} job BullMQ job whose data includes
 *   `inputFilename`, `outputFilename`, and `profile`.
 * @returns {Promise<{ outputFilename: string, profileId: number }>}
 *   Result payload stored on the completed job.
 * @throws {Error} When the input is missing or ffmpeg fails.
 */
export async function processTranscodeJob(job) {
  const { inputFilename, outputFilename, profile } = job.data;

  await job.updateProgress(10);

  const inputPath = resolveOriginalInputPath(inputFilename);
  const outputPath = resolveTranscodedOutputPath(outputFilename);
  const args = buildFfmpegArgs({ inputPath, outputPath, profile });

  await job.updateProgress(40);
  await runFfmpeg(args);
  await job.updateProgress(100);

  return {
    outputFilename,
    profileId: profile.id,
  };
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

  return queue.add(
    "ffmpeg-transcode",
    { inputFilename, outputFilename, profile },
    { jobId },
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

  return {
    jobId: String(job.id),
    state,
    progress,
    outputFilename: job.data?.outputFilename ?? null,
    profileId: job.data?.profile?.id ?? null,
    failedReason: job.failedReason || null,
    returnvalue: job.returnvalue ?? null,
  };
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
