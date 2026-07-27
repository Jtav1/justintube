import { join } from "node:path";
import { Router } from "express";
import { mimeTypeForImage } from "../lib/media-meta.js";
import { User } from "../lib/models/index.js";
import { streamFileWithRangeSupport } from "../lib/range-stream.js";
import { resolveSitedataPath } from "../lib/sitedata-meta.js";

/**
 * Sends a standard 404 for an unknown username or missing avatar.
 *
 * @param {import('express').Response} res Express response.
 * @returns {void}
 */
function sendNotFound(res) {
  res.status(404).json({ error: "not_found", message: "Avatar not found." });
}

/**
 * Builds the public users router (mounted under `/api/v1`).
 *
 * @returns {import('express').Router} Configured users router.
 */
export function createUsersRouter() {
  const router = Router();

  /**
   * Serves a user's avatar image by username. Public; no auth required.
   * GET /api/v1/users/:username/avatar
   *
   * @openapi
   * /api/v1/users/{username}/avatar:
   *   get:
   *     tags: [Users]
   *     summary: Get a user's avatar image
   *     operationId: getUserAvatar
   *     parameters:
   *       - in: path
   *         name: username
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       "200":
   *         description: Avatar image
   *       "404":
   *         description: Unknown username, or no avatar set
   *
   * @param {import('express').Request} req Incoming request.
   * @param {import('express').Response} res Express response.
   * @returns {Promise<void>} Streams the avatar image or sends a 404.
   */
  router.get("/users/:username/avatar", async (req, res) => {
    try {
      const user = await User.findOne({ where: { username: req.params.username } });
      if (!user || !user.avatarFilename) {
        sendNotFound(res);
        return;
      }

      const absolutePath = resolveSitedataPath(join("avatars", user.avatarFilename));
      const contentType = mimeTypeForImage(user.avatarFilename);
      await streamFileWithRangeSupport(req, res, absolutePath, contentType);
    } catch (err) {
      console.error("getUserAvatar failed:", err);
      if (!res.headersSent) {
        res.status(500).json({
          error: "internal_error",
          message: "Failed to load avatar.",
        });
      }
    }
  });

  return router;
}
