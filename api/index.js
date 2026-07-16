import "dotenv/config";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { apiReference } from "@scalar/express-api-reference";
import { loadOpenApiDocument } from "./lib/loadOpenApi.js";
import { createApiRouter } from "./routes/stubs.js";

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
  app.use(cors());
  app.use(express.json({ limit: "2mb" }));
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
    }),
  );

  app.use("/api/v1", createApiRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "No route matched." });
  });

  return app;
}

const app = createApp();

app.listen(PORT, () => {
  console.log(`Justintube API listening on http://localhost:${PORT}`);
  console.log(`Scalar docs: http://localhost:${PORT}/docs`);
  console.log(`OpenAPI:    http://localhost:${PORT}/openapi.json`);
});
