import "dotenv/config";
import { pathToFileURL } from "node:url";
import cors from "cors";
import express from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import { apiReference } from "@scalar/express-api-reference";
import { createCorsOptions } from "./lib/auth/cors.js";
import { getAuthContext } from "./lib/auth/require-auth.js";
import { logger } from "./lib/logger.js";
import { livestreamEnabled } from "./lib/livestream-config.js";
import { createSessionMiddleware } from "./lib/auth/session.js";
import { loadOpenApiDocument } from "./lib/loadOpenApi.js";
import { ensureSchema } from "./lib/schema.js";
import {
  runSearchReindex,
  startSearchReindexCron,
} from "./lib/search-reindex.js";
import { startTranscodeReconcileCron } from "./lib/transcode-reconcile.js";
import { startHashReconcileCron } from "./lib/hash-reconcile.js";
import { createApiRouter } from "./routes/stubs.js";
import { createInternalFileVersionsRouter } from "./routes/internal-file-versions.js";
import { createInternalLivestreamsRouter } from "./routes/internal-livestreams.js";
import { createInternalOriginalUploadsRouter } from "./routes/internal-original-uploads.js";
import { createInternalThumbnailsRouter } from "./routes/internal-thumbnails.js";

const PORT = Number(process.env.PORT) || 3000;

/**
 * Default per-IP request ceiling for the global rate limiter (requests per
 * `RATE_LIMIT_WINDOW_MS`).
 *
 * @type {number}
 */
const RATE_LIMIT_MAX = 300;

/**
 * Raised per-IP ceiling granted to requests from a logged-in, email-verified
 * uploader - trusted enough to need more headroom than anonymous/unverified
 * session traffic, but still identified by IP (unlike API-key callers, who
 * are exempt from this limiter entirely via `skip` below).
 *
 * @type {number}
 */
const RATE_LIMIT_MAX_TRUSTED_UPLOADER = 60000;

/**
 * Creates and configures the Express application (middleware, API stubs, Scalar docs).
 *
 * @returns {import('express').Express} Ready-to-listen Express app.
 */
export function createApp() {
  const app = express();
  const openApiDocument = loadOpenApiDocument();

  // Trust one hop of reverse proxy by default (secure cookies, req.secure,
  // and rate-limit IPs all depend on this behind a fronting LB/proxy).
  // Override TRUST_PROXY to match your actual proxy topology - a numeric
  // string is treated as a hop count, anything else (e.g. "loopback", a
  // CIDR list) is passed through to Express as-is.
  const trustProxyEnv = process.env.TRUST_PROXY;
  app.set(
    "trust proxy",
    trustProxyEnv === undefined
      ? 1
      : /^\d+$/.test(trustProxyEnv.trim())
        ? Number(trustProxyEnv)
        : trustProxyEnv,
  );

  app.use(
    helmet({
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
    }),
  );
  app.use(cors(createCorsOptions()));
  app.use(express.json({ limit: "2mb" }));
  app.use(createSessionMiddleware());
  app.use(
    rateLimit({
      windowMs: 60_000,
      // Logged-in, verified uploaders get a raised ceiling - they're trusted
      // enough to browse/upload more heavily, but (unlike API-key callers)
      // still identified by IP, so still worth capping.
      max: async (req) => {
        const auth = await getAuthContext(req);
        const user = auth?.user;
        return user?.emailVerified && user?.uploader
          ? RATE_LIMIT_MAX_TRUSTED_UPLOADER
          : RATE_LIMIT_MAX;
      },
      standardHeaders: true,
      legacyHeaders: false,
      // Requests authenticated with a valid user API key are exempt from this
      // (and any other client-facing) rate limit - API key holders are trusted
      // callers, distinct from anonymous/session traffic this limiter targets.
      skip: async (req) => {
        const auth = await getAuthContext(req);
        return auth?.authMethod === "api_key";
      },
    }),
  );

  /**
   * Liveness probe for deploy and docker-compose checks.
   * GET /health — no body. Auth: none.
   *
   * @openapi
   * /health:
   *   get:
   *     tags: [Service]
   *     summary: Liveness probe
   *     operationId: health
   *     responses:
   *       200:
   *         description: Service is up
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 status:
   *                   type: string
   *                   example: ok
   *
   * @param {import('express').Request} _req Incoming request (unused).
   * @param {import('express').Response} res Express response.
   * @returns {void} Sends `{ status: "ok" }`.
   */
  app.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });

  /**
   * Serves a robots.txt that disallows crawling of this service entirely.
   * GET /robots.txt — no body. Auth: none.
   *
   * @param {import('express').Request} _req Incoming request (unused).
   * @param {import('express').Response} res Express response.
   * @returns {void} Sends a plain-text robots.txt body.
   */
  app.get("/robots.txt", (_req, res) => {
    res.type("text/plain").send("User-agent: *\nDisallow: /\n");
  });

  // Publicly exposes the full API schema/UI - on by default outside
  // production, off in production unless explicitly enabled.
  const docsEnabled =
    String(
      process.env.ENABLE_API_DOCS ?? process.env.NODE_ENV !== "production",
    ).toLowerCase() === "true";

  if (docsEnabled) {
    /**
     * Serves the loaded OpenAPI document as JSON.
     * GET /openapi.json — no body. Auth: none.
     *
     * @openapi
     * /openapi.json:
     *   get:
     *     tags: [Service]
     *     summary: OpenAPI document
     *     operationId: openApiJson
     *     responses:
     *       200:
     *         description: OpenAPI 3 document generated via swagger-jsdoc
     *
     * @param {import('express').Request} _req Incoming request (unused).
     * @param {import('express').Response} res Express response.
     * @returns {void} Sends the OpenAPI document object.
     */
    app.get("/openapi.json", (_req, res) => {
      res.json(openApiDocument);
    });

    /**
     * Serves the Scalar API reference UI for `/openapi.json`.
     * GET /docs — no body. Auth: none.
     *
     * @openapi
     * /docs:
     *   get:
     *     tags: [Service]
     *     summary: Scalar API reference UI
     *     operationId: docs
     *     responses:
     *       200:
     *         description: HTML page embedding Scalar API Reference
     *         content:
     *           text/html:
     *             schema:
     *               type: string
     */
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
  }

  // Mounted first: unlike the other two internal routers, this one has a
  // route (mediamtx-auth) that's deliberately NOT Bearer-gated (MediaMTX's
  // authHTTPAddress webhook can't send an Authorization header). The other
  // two routers apply their requireInternalToken as a blanket `router.use`
  // with no path restriction, which would otherwise intercept every
  // /internal/* request - including this one - before it ever reached a
  // matching route.
  // Gated on ENABLE_LIVESTREAM, matching the public livestream routes in
  // routes/stubs.js - when disabled, these callbacks are unmounted and any
  // request to them falls through to the app-level 404 handler below.
  if (livestreamEnabled()) {
    app.use("/internal", createInternalLivestreamsRouter());
  }
  app.use("/internal", createInternalFileVersionsRouter());
  app.use("/internal", createInternalThumbnailsRouter());
  app.use("/internal", createInternalOriginalUploadsRouter());
  app.use("/api/v1", createApiRouter());

  /**
   * Fallback when no route matched.
   * Auth: none.
   *
   * @param {import('express').Request} _req Incoming request (unused).
   * @param {import('express').Response} res Express response.
   * @returns {void} Sends 404 `{ error: "not_found", message }`.
   */
  app.use((_req, res) => {
    res.status(404).json({ error: "not_found", message: "No route matched." });
  });

  /**
   * Catch-all error handler. Logs the cause of any unhandled error (including
   * async errors Express 5 forwards automatically) so it's visible in the
   * Docker log console, then responds with the standard error envelope if a
   * response hasn't already been sent.
   *
   * @param {Error} err The error that was thrown or forwarded via next(err).
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @param {import('express').NextFunction} next Express next function.
   * @returns {void} Sends 500 `{ error: "internal_error", message }`.
   */
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    logger.error(
      { err },
      `Unhandled error on ${req.method} ${req.originalUrl}`,
    );
    if (res.headersSent) {
      return;
    }
    res
      .status(500)
      .json({ error: "internal_error", message: "Internal server error." });
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
    logger.error({ err }, "Failed to ensure database schema");
    process.exit(1);
  }

  app.listen(PORT, () => {
    console.log(`Justintube API listening on http://localhost:${PORT}`);
    console.log(`Scalar docs: http://localhost:${PORT}/docs`);
    console.log(`OpenAPI:     http://localhost:${PORT}/openapi.json`);
  });

  try {
    await startTranscodeReconcileCron();
  } catch (err) {
    logger.error({ err }, "Failed to start transcode reconcile cron");
  }

  try {
    await startHashReconcileCron();
  } catch (err) {
    logger.error({ err }, "Failed to start hash reconcile cron");
  }

  try {
    await startSearchReindexCron();
  } catch (err) {
    logger.error({ err }, "Failed to start search reindex cron");
  }

  try {
    await runSearchReindex();
  } catch (err) {
    logger.error({ err }, "Failed to run startup search reindex");
  }
}

// Only boot the HTTP server (and touch the database) when this file is executed
// directly. Importing it (e.g. from tests) exposes `createApp` without starting.
const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  start();
}
