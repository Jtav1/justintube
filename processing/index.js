import { pathToFileURL } from "node:url";
import express from "express";
import { requireInternalToken } from "./lib/require-internal-token.js";
import { createDownloadRouter } from "./routes/download.js";
import { createTranscodeRouter } from "./routes/transcode.js";
import {
  closeTranscodeResources,
  createRedisConnection,
  createTranscodeQueue,
  createTranscodeWorker,
  notifyTranscodeJobFailed,
} from "./lib/queue.js";

const PORT = Number(process.env.PORT) || 3001;

/**
 * Creates and configures the Express application for the processing service
 * (yt-dlp downloads + queued ffmpeg transcodes).
 *
 * @param {object} [options] Optional dependencies for tests / wiring.
 * @param {import('bullmq').Queue | null} [options.transcodeQueue] BullMQ queue
 *   used by `/transcode` routes. When omitted, those routes are not mounted.
 * @returns {import('express').Express} Ready-to-listen Express app.
 */
export function createApp(options = {}) {
  const app = express();
  const { transcodeQueue = null } = options;

  app.use(express.json());

  /**
   * Liveness / readiness probe for deploy and docker-compose checks.
   *
   * @param {import('express').Request} _req Incoming request (unused).
   * @param {import('express').Response} res Express response.
   * @returns {void} Sends JSON health payload including queue readiness.
   */
  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      redis: transcodeQueue ? "configured" : "unavailable",
    });
  });

  app.use("/download", requireInternalToken, createDownloadRouter());

  if (transcodeQueue) {
    app.use(
      "/transcode",
      requireInternalToken,
      createTranscodeRouter({ queue: transcodeQueue }),
    );
  }

  return app;
}

/**
 * Starts the HTTP server, BullMQ queue, and ffmpeg worker when this module is
 * the process entrypoint.
 *
 * @returns {Promise<void>} Resolves once the server is listening.
 */
async function main() {
  const connection = createRedisConnection();
  const queue = createTranscodeQueue(connection);
  const worker = createTranscodeWorker(connection);

  worker.on("failed", (job, err) => {
    console.error(
      `transcode job ${job?.id ?? "unknown"} failed:`,
      err?.message || err,
    );
    void notifyTranscodeJobFailed(job, err);
  });

  const app = createApp({ transcodeQueue: queue });
  const server = app.listen(PORT, () => {
    console.log(`justintube-processing listening on port ${PORT}`);
  });

  /**
   * Stops accepting HTTP traffic and closes BullMQ resources.
   *
   * @returns {Promise<void>} Resolves after shutdown completes.
   */
  async function shutdown() {
    console.log("shutting down processing service…");
    await new Promise((resolve) => server.close(resolve));
    await closeTranscodeResources({ queue, worker });
    process.exit(0);
  }

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
}

// Only boot HTTP + workers when this file is executed directly.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error("Failed to start processing service:", err);
    process.exit(1);
  });
}
