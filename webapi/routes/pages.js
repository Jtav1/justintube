import { Router } from "express";
import { sequelize, StaticPage } from "../lib/models/index.js";
import { logger } from "../lib/logger.js";

/**
 * Looks up a STATIC_PAGES row by `description`, matched case-insensitively,
 * and sends it (or a 404) as the response.
 *
 * @param {import('express').Response} res Express response.
 * @param {string} description Description value to match (case-insensitive).
 * @param {string} notFoundMessage Message to send if no row matches.
 * @returns {Promise<void>} Sends the static page or a 404 error response.
 */
async function sendStaticPageByDescription(res, description, notFoundMessage) {
  const page = await StaticPage.findOne({
    where: sequelize.where(
      sequelize.fn("LOWER", sequelize.col("description")),
      description.toLowerCase(),
    ),
  });

  if (!page) {
    res.status(404).json({ error: "not_found", message: notFoundMessage });
    return;
  }

  res.status(200).json({
    id: page.id,
    description: page.description,
    contents: page.contents,
    updatedAt: page.updatedAt,
  });
}

/**
 * Builds the static pages router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured pages router.
 */
export function createPagesRouter() {
  const router = Router();

  /**
   * Returns the "about" STATIC_PAGES row.
   * GET /api/v1/pages/about
   * Auth: none (public).
   *
   * @openapi
   * /api/v1/pages/about:
   *   get:
   *     tags: [Pages]
   *     summary: Get the about page
   *     operationId: getAboutPage
   *     responses:
   *       200:
   *         description: The about static page
   *       404:
   *         description: About page not configured
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the about page or an error response.
   */
  router.get("/pages/about", async (req, res) => {
    try {
      await sendStaticPageByDescription(res, "about", "About page is not configured.");
    } catch (err) {
      logger.error({ err }, "getAboutPage failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load the about page.",
      });
    }
  });

  /**
   * Returns the "rules" STATIC_PAGES row.
   * GET /api/v1/pages/rules
   * Auth: none (public).
   *
   * @openapi
   * /api/v1/pages/rules:
   *   get:
   *     tags: [Pages]
   *     summary: Get the rules page
   *     operationId: getRulesPage
   *     responses:
   *       200:
   *         description: The rules static page
   *       404:
   *         description: Rules page not configured
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Sends the rules page or an error response.
   */
  router.get("/pages/rules", async (req, res) => {
    try {
      await sendStaticPageByDescription(res, "rules", "Rules page is not configured.");
    } catch (err) {
      logger.error({ err }, "getRulesPage failed");
      res.status(500).json({
        error: "internal_error",
        message: "Failed to load the rules page.",
      });
    }
  });

  return router;
}
