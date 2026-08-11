import { Router } from "express";
import { livestreamEnabled } from "../lib/livestream-config.js";
import { createAdminBroadcastRouter } from "./admin-broadcast.js";
import { createAdminUsersRouter } from "./admin-users.js";
import { createApiKeysRouter } from "./api-keys.js";
import { createAuthRouter } from "./auth.js";
import { createLivestreamsRouter } from "./livestreams.js";
import { createMeRouter } from "./me.js";
import { createMeStreamKeyRouter } from "./me-stream-key.js";
import { createNotificationPreferencesRouter } from "./notification-preferences.js";
import { createNotificationsRouter } from "./notifications.js";
import { createPagesRouter } from "./pages.js";
import { createPlaylistsRouter } from "./playlists.js";
import { createPublicConfigRouter } from "./public-config.js";
import { createReportsRouter } from "./reports.js";
import { createSearchRouter } from "./search.js";
import { createSystemConfigRouter } from "./system-config.js";
import { createThemesRouter } from "./themes.js";
import { createTranscodeProfilesRouter } from "./transcode-profiles.js";
import { createUploadRouter } from "./uploads.js";
import { createUsersRouter } from "./users.js";
import { createVideosRouter } from "./videos.js";

/**
 * Creates an Express middleware that responds with HTTP 501 for unimplemented routes.
 *
 * @param {string} operationId OpenAPI operationId for the route (surfaced in the body).
 * @returns {import('express').RequestHandler} Middleware that sends a 501 JSON error.
 */
export function notImplemented(operationId) {
  return (_req, res) => {
    res.status(501).json({
      error: "not_implemented",
      message: `Operation "${operationId}" is defined but not implemented yet.`,
      operationId,
    });
  };
}

/**
 * Registers stub handlers for every Views.md-derived API path that is not yet
 * implemented. Each stub responds with HTTP 501 and
 * `{ error: "not_implemented", message, operationId }`. Auth is not enforced on
 * stubs (real routers own auth when they replace these placeholders).
 *
 * @param {import('express').Router} router Router mounted at `/api/v1`.
 * @returns {void} No return value; mutates `router` in place.
 */
export function registerStubRoutes(router) {
  /**
   * Binds a 501 stub for one METHOD + path.
   *
   * @private
   * @param {"get"|"post"|"put"|"patch"|"delete"} method HTTP method name on the router.
   * @param {string} path Path relative to `/api/v1`.
   * @param {string} operationId OpenAPI operationId for the stub body.
   * @returns {void}
   */
  const r = (method, path, operationId) => {
    router[method](path, notImplemented(operationId));
  };

  // Search & discovery (unimplemented remainders)
  r("get", "/videos/:id/reaction", "getVideoReaction");
  r("delete", "/videos/:id/reaction", "clearVideoReaction");

  // CAST
  r("post", "/cast", "createCastSpace");
  r("post", "/cast/join", "joinCastSpace");
  r("get", "/cast/:id", "getCastSpace");
  r("post", "/cast/:id/playlist", "addCastPlaylistItem");
  r("delete", "/cast/:id/playlist/:videoId", "removeCastPlaylistItem");
  r("get", "/cast/:id/members", "listCastMembers");
  r("get", "/cast/:id/display", "getCastDisplay");
  r("get", "/cast/:id/sync", "castSyncWebSocket");
}

/**
 * Builds the `/api/v1` router with real implementations mounted before stubs.
 *
 * @returns {import('express').Router} Configured API router.
 */
export function createApiRouter() {
  const router = Router();
  // Real implementations are mounted before the stubs so they take precedence
  // over the corresponding 501 placeholders.
  router.use(createAuthRouter());
  router.use(createUploadRouter());
  router.use(createApiKeysRouter());
  router.use(createMeRouter());
  // Gated on ENABLE_LIVESTREAM: when disabled, these paths are simply never
  // mounted, so requests fall through to the app-level 404 handler (same
  // approach as ENABLE_API_DOCS gating /docs in index.js). The internal
  // ingest-server callbacks are gated the same way in index.js.
  if (livestreamEnabled()) {
    router.use(createMeStreamKeyRouter());
    router.use(createLivestreamsRouter());
  }
  router.use(createNotificationPreferencesRouter());
  router.use(createNotificationsRouter());
  router.use(createPagesRouter());
  router.use(createPublicConfigRouter());
  router.use(createSystemConfigRouter());
  router.use(createAdminUsersRouter());
  router.use(createAdminBroadcastRouter());
  router.use(createTranscodeProfilesRouter());
  router.use(createThemesRouter());
  router.use(createVideosRouter());
  router.use(createUsersRouter());
  router.use(createSearchRouter());
  router.use(createPlaylistsRouter());
  router.use(createReportsRouter());
  registerStubRoutes(router);
  return router;
}
