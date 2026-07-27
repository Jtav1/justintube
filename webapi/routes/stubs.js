import { Router } from "express";
import { createAdminUsersRouter } from "./admin-users.js";
import { createApiKeysRouter } from "./api-keys.js";
import { createAuthRouter } from "./auth.js";
import { createMeRouter } from "./me.js";
import { createNotificationPreferencesRouter } from "./notification-preferences.js";
import { createNotificationsRouter } from "./notifications.js";
import { createPagesRouter } from "./pages.js";
import { createPlaylistsRouter } from "./playlists.js";
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

  // Me / library / settings
  r("get", "/me/history", "listMyHistory");
  r("delete", "/me/history", "clearMyHistory");
  r("get", "/me/like-history", "listMyLikeHistory");
  r("get", "/me/videos/likes-received", "listLikesReceived");

  // Me / stream key (OBS / RTMP ingest credential)
  r("get", "/me/stream-key", "getMyStreamKey");
  r("post", "/me/stream-key/rotate", "rotateMyStreamKey");
  r("delete", "/me/stream-key", "revokeMyStreamKey");

  // Livestreaming
  r("get", "/livestreams", "listLivestreams");
  r("get", "/livestreams/:id", "getLivestream");
  r("patch", "/livestreams/:id", "updateLivestream");
  r("get", "/livestreams/:id/playback", "getLivestreamPlayback");
  r("get", "/users/:username/live", "getUserLiveStatus");

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
  router.use(createNotificationPreferencesRouter());
  router.use(createNotificationsRouter());
  router.use(createPagesRouter());
  router.use(createSystemConfigRouter());
  router.use(createAdminUsersRouter());
  router.use(createTranscodeProfilesRouter());
  router.use(createThemesRouter());
  router.use(createVideosRouter());
  router.use(createUsersRouter());
  router.use(createSearchRouter());
  router.use(createPlaylistsRouter());
  registerStubRoutes(router);
  return router;
}
