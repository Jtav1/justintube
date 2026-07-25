import { Router } from "express";
import { createAdminUsersRouter } from "./admin-users.js";
import { createApiKeysRouter } from "./api-keys.js";
import { createAuthRouter } from "./auth.js";
import { createSearchRouter } from "./search.js";
import { createSystemConfigRouter } from "./system-config.js";
import { createTranscodeProfilesRouter } from "./transcode-profiles.js";
import { createUploadRouter } from "./uploads.js";
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

  // Auth (unimplemented)
  r("get", "/auth/sso/providers", "authSsoProviders");
  r("get", "/auth/sso/:provider/start", "authSsoStart");
  r("get", "/auth/sso/:provider/callback", "authSsoCallback");
  r("post", "/auth/sso/link", "authSsoLink");
  r("delete", "/auth/sso/link/:provider", "authSsoUnlink");

  // Search & discovery (unimplemented remainders)
  r("post", "/videos/import", "importVideo");
  r("get", "/videos/:id/stream", "getVideoStream");
  r("get", "/videos/:id/reaction", "getVideoReaction");
  r("delete", "/videos/:id/reaction", "clearVideoReaction");

  // Me / library / settings
  r("patch", "/me", "updateMe");
  r("get", "/me/settings", "getMeSettings");
  r("get", "/me/videos", "listMyVideos");
  r("get", "/me/history", "listMyHistory");
  r("delete", "/me/history", "clearMyHistory");
  r("get", "/me/likes", "listMyLikes");
  r("get", "/me/like-history", "listMyLikeHistory");
  r("get", "/me/videos/likes-received", "listLikesReceived");
  r("get", "/me/subscriptions", "listMySubscriptions");
  r("get", "/me/subscribers", "listMySubscribers");
  r("get", "/me/playlists", "listMyPlaylists");
  r("get", "/me/notification-preferences", "getNotificationPreferences");
  r("patch", "/me/notification-preferences", "updateNotificationPreferences");

  // Users / channels / engagement
  r("get", "/users/:username", "getUserChannel");
  r("get", "/users/:username/videos", "listUserVideos");
  r("post", "/users/:id/subscribe", "subscribeToUser");
  r("delete", "/users/:id/subscribe", "unsubscribeFromUser");
  r("get", "/users/:id/subscription", "getSubscriptionState");
  r("post", "/users/:id/ban", "banUser");
  r("delete", "/users/:id/ban", "unbanUser");

  // Playlists
  r("post", "/playlists", "createPlaylist");
  r("get", "/playlists/:id", "getPlaylist");
  r("patch", "/playlists/:id", "updatePlaylist");
  r("delete", "/playlists/:id", "deletePlaylist");
  r("post", "/playlists/:id/items", "addPlaylistItem");
  r("delete", "/playlists/:id/items/:videoId", "removePlaylistItem");

  // CAST
  r("post", "/cast", "createCastSpace");
  r("post", "/cast/join", "joinCastSpace");
  r("get", "/cast/:id", "getCastSpace");
  r("post", "/cast/:id/playlist", "addCastPlaylistItem");
  r("delete", "/cast/:id/playlist/:videoId", "removeCastPlaylistItem");
  r("get", "/cast/:id/members", "listCastMembers");
  r("get", "/cast/:id/display", "getCastDisplay");
  r("get", "/cast/:id/sync", "castSyncWebSocket");

  // Notifications & pages
  r("get", "/notifications", "listNotifications");
  r("post", "/notifications/read", "markNotificationsRead");
  r("get", "/pages/about", "getAboutPage");
  r("get", "/pages/rules", "getRulesPage");
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
  router.use(createSystemConfigRouter());
  router.use(createAdminUsersRouter());
  router.use(createTranscodeProfilesRouter());
  router.use(createVideosRouter());
  router.use(createSearchRouter());
  registerStubRoutes(router);
  return router;
}
