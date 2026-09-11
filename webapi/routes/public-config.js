import { Router } from "express";
import { livestreamEnabled } from "../lib/livestream-config.js";
import { transcodingEnabled } from "../lib/processing-features-config.js";

/**
 * Builds the public config router (mounted under `/api/v1`), exposing a
 * small set of runtime feature flags the webview needs at boot to decide
 * what to render - it has no access to webapi's process.env, since it's a
 * separately built/deployed static site.
 *
 * @returns {import('express').Router} Configured public-config router.
 */
export function createPublicConfigRouter() {
  const router = Router();

  /**
   * Returns public runtime feature flags.
   * GET /api/v1/config — no body. Auth: none.
   *
   * @openapi
   * /api/v1/config:
   *   get:
   *     tags: [Service]
   *     summary: Get public runtime feature flags
   *     operationId: getPublicConfig
   *     responses:
   *       200:
   *         description: Public feature flags
   *         content:
   *           application/json:
   *             schema:
   *               type: object
   *               properties:
   *                 livestreamEnabled:
   *                   type: boolean
   *                 transcodingEnabled:
   *                   type: boolean
   *
   * @param {import('express').Request} _req Incoming request (unused).
   * @param {import('express').Response} res Express response.
   * @returns {void} Sends `{ livestreamEnabled, transcodingEnabled }`.
   */
  router.get("/config", (_req, res) => {
    res.json({
      livestreamEnabled: livestreamEnabled(),
      transcodingEnabled: transcodingEnabled(),
    });
  });

  return router;
}
