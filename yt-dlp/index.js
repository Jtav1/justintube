import express from "express";
import { createDownloadRouter } from "./routes/download.js";

const PORT = Number(process.env.PORT) || 3001;

/**
 * Creates and configures the Express application for the yt-dlp service.
 * Download routes spawn yt-dlp with `--js-runtimes node`.
 *
 * @returns {import('express').Express} Ready-to-listen Express app.
 */
export function createApp() {
  const app = express();

  app.use(express.json());

  /**
   * Liveness probe for deploy and docker-compose checks.
   *
   * @param {import('express').Request} _req Incoming request (unused).
   * @param {import('express').Response} res Express response.
   * @returns {void} Sends JSON health payload.
   */
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/download", createDownloadRouter());

  return app;
}

/**
 * Starts the HTTP server when this module is the process entrypoint.
 *
 * @returns {void} Begins listening on PORT; no return value.
 */
function main() {
  const app = createApp();
  app.listen(PORT, () => {
    console.log(`justintube-ytdlp listening on port ${PORT}`);
  });
}

main();
