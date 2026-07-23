import "dotenv/config";
import { pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { apiReference } from "@scalar/express-api-reference";
import { createCorsOptions } from "./lib/auth/cors.js";
import { createSessionMiddleware } from "./lib/auth/session.js";
import { loadOpenApiDocument } from "./lib/loadOpenApi.js";
import { ensureSchema } from "./lib/schema.js";
import { startTranscodeReconcileCron } from "./lib/transcode-reconcile.js";
import { createApiRouter } from "./routes/stubs.js";
import { createInternalFileVersionsRouter } from "./routes/internal-file-versions.js";

const PORT = Number(process.env.PORT) || 3000;

/**
 * Creates and configures the Express application (middleware, API stubs, Scalar docs).
 *
 * @returns {import('express').Express} Ready-to-listen Express app.
 */
export function createApp() {
  const app = express();
  const openApiDocument = loadOpenApiDocument();

  app.use(
    helmet({
      contentSecurityPolicy: false,
    }),
  );
  app.use(cors(createCorsOptions()));
  app.use(express.json({ limit: "2mb" }));
  app.use(createSessionMiddleware());
  app.use(
    rateLimit({
      windowMs: 60_000,
      max: 300,
      standardHeaders: true,
      legacyHeaders: false,
    }),
  );

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

  app.get("/openapi.json", (_req, res) => {
    res.json(openApiDocument);
  });

  app.use(
    "/docs",
    apiReference({
      url: "/openapi.json",
      theme: "default",
      pageTitle: "Justintube API",
      agent: {
        disabled: true,
      },
    }),
  );

  app.use("/internal", createInternalFileVersionsRouter());
  app.use("/api/v1", createApiRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "No route matched." });
  });

  return app;
}

const app = createApp();

/**
 * Ensures the database schema exists, then starts the HTTP server.
 *
 * @returns {Promise<void>} Resolves once the server is listening.
 */
async function start() {
  try {
    await ensureSchema();
  } catch (err) {
    console.error("Failed to ensure database schema:", err);
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Justintube API listening on http://localhost:${PORT}`);
    console.log(`Scalar docs: http://localhost:${PORT}/docs`);
    console.log(`OpenAPI:    http://localhost:${PORT}/openapi.json`);
  });

  try {
    await startTranscodeReconcileCron();
  } catch (err) {
    console.error(
      "Failed to start transcode reconcile cron:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Only boot the HTTP server (and touch the database) when this file is executed
// directly. Importing it (e.g. from tests) exposes `createApp` without starting.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start();
}
