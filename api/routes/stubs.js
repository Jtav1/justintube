import { Router } from 'express';

/**
 * Creates an Express middleware that responds with HTTP 501 for unimplemented routes.
 *
 * @param {string} operationId OpenAPI operationId for the route (surfaced in the body).
 * @returns {import('express').RequestHandler} Middleware that sends a 501 JSON error.
 */
export function notImplemented(operationId) {
  return (_req, res) => {
    res.status(501).json({
      error: 'not_implemented',
      message: `Operation "${operationId}" is defined but not implemented yet.`,
      operationId,
    });
  };
}

/**
 * Registers stub handlers for every Views.md-derived API path.
 *
 * @param {import('express').Router} router Router mounted at `/api/v1`.
 * @returns {void} No return value; mutates `router` in place.
 */
export function registerStubRoutes(router) {
  const r = (method, path, operationId) => {
    router[method](path, notImplemented(operationId));
  };

  // Auth
  r('post', '/auth/register', 'authRegister');
  r('post', '/auth/login', 'authLogin');
  r('post', '/auth/logout', 'authLogout');
  r('get', '/auth/me', 'authMe');
  r('post', '/auth/verify-email', 'authVerifyEmail');
  r('post', '/auth/resend-verification', 'authResendVerification');
  r('post', '/auth/password', 'authChangePassword');
  r('get', '/auth/sso/providers', 'authSsoProviders');
  r('get', '/auth/sso/:provider/start', 'authSsoStart');
  r('get', '/auth/sso/:provider/callback', 'authSsoCallback');
  r('post', '/auth/sso/link', 'authSsoLink');
  r('delete', '/auth/sso/link/:provider', 'authSsoUnlink');

  // Search & discovery
  r('get', '/search/suggest', 'searchSuggest');
  r('get', '/search', 'searchVideos');
  r('get', '/videos', 'listVideos');
  r('post', '/videos', 'createVideo');
  r('get', '/videos/featured', 'listFeaturedVideos');
  r('get', '/videos/newest', 'listNewestVideos');
  r('post', '/videos/upload', 'uploadVideo');
  r('post', '/videos/import', 'importVideo');
  r('get', '/videos/:id', 'getVideo');
  r('patch', '/videos/:id', 'updateVideo');
  r('delete', '/videos/:id', 'deleteVideo');
  r('get', '/videos/:id/stream', 'getVideoStream');
  r('post', '/videos/:id/delist', 'delistVideo');
  r('get', '/videos/:id/access', 'listVideoAccess');
  r('put', '/videos/:id/access', 'setVideoAccess');
  r('get', '/videos/:id/transcode', 'getVideoTranscode');
  r('post', '/videos/:id/transcode', 'forceVideoTranscode');
  r('post', '/videos/:id/view', 'recordVideoView');
  r('post', '/videos/:id/like', 'likeVideo');
  r('post', '/videos/:id/dislike', 'dislikeVideo');
  r('get', '/videos/:id/reaction', 'getVideoReaction');
  r('delete', '/videos/:id/reaction', 'clearVideoReaction');
  r('get', '/tags', 'listTags');
  r('get', '/tags/:tag/videos', 'listTagVideos');
  r('get', '/feed/subscriptions', 'feedSubscriptions');

  // Me / library / settings
  r('patch', '/me', 'updateMe');
  r('get', '/me/settings', 'getMeSettings');
  r('get', '/me/videos', 'listMyVideos');
  r('get', '/me/history', 'listMyHistory');
  r('delete', '/me/history', 'clearMyHistory');
  r('get', '/me/likes', 'listMyLikes');
  r('get', '/me/like-history', 'listMyLikeHistory');
  r('get', '/me/videos/likes-received', 'listLikesReceived');
  r('get', '/me/subscriptions', 'listMySubscriptions');
  r('get', '/me/subscribers', 'listMySubscribers');
  r('get', '/me/playlists', 'listMyPlaylists');
  r('get', '/me/notification-preferences', 'getNotificationPreferences');
  r('patch', '/me/notification-preferences', 'updateNotificationPreferences');

  // Users / channels / engagement
  r('get', '/users/:username', 'getUserChannel');
  r('get', '/users/:username/videos', 'listUserVideos');
  r('post', '/users/:id/subscribe', 'subscribeToUser');
  r('delete', '/users/:id/subscribe', 'unsubscribeFromUser');
  r('get', '/users/:id/subscription', 'getSubscriptionState');
  r('post', '/users/:id/ban', 'banUser');
  r('delete', '/users/:id/ban', 'unbanUser');

  // Playlists
  r('post', '/playlists', 'createPlaylist');
  r('get', '/playlists/:id', 'getPlaylist');
  r('patch', '/playlists/:id', 'updatePlaylist');
  r('delete', '/playlists/:id', 'deletePlaylist');
  r('post', '/playlists/:id/items', 'addPlaylistItem');
  r('delete', '/playlists/:id/items/:videoId', 'removePlaylistItem');

  // CAST
  r('post', '/cast', 'createCastSpace');
  r('post', '/cast/join', 'joinCastSpace');
  r('get', '/cast/:id', 'getCastSpace');
  r('post', '/cast/:id/playlist', 'addCastPlaylistItem');
  r('delete', '/cast/:id/playlist/:videoId', 'removeCastPlaylistItem');
  r('get', '/cast/:id/members', 'listCastMembers');
  r('get', '/cast/:id/display', 'getCastDisplay');
  r('get', '/cast/:id/sync', 'castSyncWebSocket');

  // Notifications & pages
  r('get', '/notifications', 'listNotifications');
  r('post', '/notifications/read', 'markNotificationsRead');
  r('get', '/pages/about', 'getAboutPage');
  r('get', '/pages/rules', 'getRulesPage');

  // Admin
  r('get', '/admin/users', 'adminListUsers');
  r('patch', '/admin/users/:id', 'adminUpdateUser');
  r('get', '/admin/transcode-profiles', 'adminListTranscodeProfiles');
  r('post', '/admin/transcode-profiles', 'adminCreateTranscodeProfile');
  r('patch', '/admin/transcode-profiles/:id', 'adminUpdateTranscodeProfile');
  r('delete', '/admin/transcode-profiles/:id', 'adminDeleteTranscodeProfile');
}

/**
 * Builds the `/api/v1` router with all stub endpoints registered.
 *
 * @returns {import('express').Router} Configured API router.
 */
export function createApiRouter() {
  const router = Router();
  registerStubRoutes(router);
  return router;
}
