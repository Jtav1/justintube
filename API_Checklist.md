# API Implementation Checklist

Manual tracking of API route implementation progress across the two backend services.

- **Web API** (`api/`) — public application API, base path `/api/v1` unless noted.
- **Processing API** (`processing/`) — internal yt-dlp download + ffmpeg transcode service.

---

## Web API (`api/`)

### Service / infrastructure

- [x] `GET /health` — liveness probe
- [x] `GET /openapi.json` — OpenAPI document
- [x] `GET /docs` — Scalar API reference UI

### Auth

- [ ] `POST /api/v1/auth/register` — authRegister
- [ ] `POST /api/v1/auth/login` — authLogin
- [ ] `POST /api/v1/auth/logout` — authLogout
- [ ] `GET /api/v1/auth/me` — authMe
- [ ] `POST /api/v1/auth/verify-email` — authVerifyEmail
- [ ] `POST /api/v1/auth/resend-verification` — authResendVerification
- [ ] `POST /api/v1/auth/password` — authChangePassword
- [ ] `GET /api/v1/auth/sso/providers` — authSsoProviders
- [ ] `GET /api/v1/auth/sso/:provider/start` — authSsoStart
- [ ] `GET /api/v1/auth/sso/:provider/callback` — authSsoCallback
- [ ] `POST /api/v1/auth/sso/link` — authSsoLink
- [ ] `DELETE /api/v1/auth/sso/link/:provider` — authSsoUnlink

### Search & discovery

- [ ] `GET /api/v1/search/suggest` — searchSuggest
- [ ] `GET /api/v1/search` — searchVideos
- [ ] `GET /api/v1/videos` — listVideos
- [ ] `GET /api/v1/videos/featured` — listFeaturedVideos
- [ ] `GET /api/v1/videos/newest` — listNewestVideos
- [ ] `POST /api/v1/videos/import` — importVideo
- [ ] `GET /api/v1/videos/:id` — getVideo
- [ ] `PATCH /api/v1/videos/:id` — updateVideo
- [ ] `DELETE /api/v1/videos/:id` — deleteVideo
- [ ] `GET /api/v1/videos/:id/stream` — getVideoStream
- [ ] `POST /api/v1/videos/:id/delist` — delistVideo
- [ ] `GET /api/v1/videos/:id/access` — listVideoAccess
- [ ] `PUT /api/v1/videos/:id/access` — setVideoAccess
- [ ] `POST /api/v1/videos/:id/view` — recordVideoView
- [ ] `POST /api/v1/videos/:id/like` — likeVideo
- [ ] `POST /api/v1/videos/:id/dislike` — dislikeVideo
- [ ] `GET /api/v1/videos/:id/reaction` — getVideoReaction
- [ ] `DELETE /api/v1/videos/:id/reaction` — clearVideoReaction
- [ ] `GET /api/v1/tags` — listTags
- [ ] `GET /api/v1/tags/:tag/videos` — listTagVideos
- [ ] `GET /api/v1/feed/subscriptions` — feedSubscriptions

### Uploads

- [ ] `POST /api/v1/videos/upload` — uploadVideo (multipart)

### Me / library / settings

- [ ] `PATCH /api/v1/me` — updateMe
- [ ] `GET /api/v1/me/settings` — getMeSettings
- [ ] `GET /api/v1/me/videos` — listMyVideos
- [ ] `GET /api/v1/me/history` — listMyHistory
- [ ] `DELETE /api/v1/me/history` — clearMyHistory
- [ ] `GET /api/v1/me/likes` — listMyLikes
- [ ] `GET /api/v1/me/like-history` — listMyLikeHistory
- [ ] `GET /api/v1/me/videos/likes-received` — listLikesReceived
- [ ] `GET /api/v1/me/subscriptions` — listMySubscriptions
- [ ] `GET /api/v1/me/subscribers` — listMySubscribers
- [ ] `GET /api/v1/me/playlists` — listMyPlaylists
- [ ] `GET /api/v1/me/notification-preferences` — getNotificationPreferences
- [ ] `PATCH /api/v1/me/notification-preferences` — updateNotificationPreferences

### Users / channels / engagement

- [ ] `GET /api/v1/users/:username` — getUserChannel
- [ ] `GET /api/v1/users/:username/videos` — listUserVideos
- [ ] `POST /api/v1/users/:id/subscribe` — subscribeToUser
- [ ] `DELETE /api/v1/users/:id/subscribe` — unsubscribeFromUser
- [ ] `GET /api/v1/users/:id/subscription` — getSubscriptionState
- [ ] `POST /api/v1/users/:id/ban` — banUser
- [ ] `DELETE /api/v1/users/:id/ban` — unbanUser

### Playlists

- [ ] `POST /api/v1/playlists` — createPlaylist
- [ ] `GET /api/v1/playlists/:id` — getPlaylist
- [ ] `PATCH /api/v1/playlists/:id` — updatePlaylist
- [ ] `DELETE /api/v1/playlists/:id` — deletePlaylist
- [ ] `POST /api/v1/playlists/:id/items` — addPlaylistItem
- [ ] `DELETE /api/v1/playlists/:id/items/:videoId` — removePlaylistItem

### CAST

- [ ] `POST /api/v1/cast` — createCastSpace
- [ ] `POST /api/v1/cast/join` — joinCastSpace
- [ ] `GET /api/v1/cast/:id` — getCastSpace
- [ ] `POST /api/v1/cast/:id/playlist` — addCastPlaylistItem
- [ ] `DELETE /api/v1/cast/:id/playlist/:videoId` — removeCastPlaylistItem
- [ ] `GET /api/v1/cast/:id/members` — listCastMembers
- [ ] `GET /api/v1/cast/:id/display` — getCastDisplay
- [ ] `GET /api/v1/cast/:id/sync` — castSyncWebSocket

### Notifications & pages

- [ ] `GET /api/v1/notifications` — listNotifications
- [ ] `POST /api/v1/notifications/read` — markNotificationsRead
- [ ] `GET /api/v1/pages/about` — getAboutPage
- [ ] `GET /api/v1/pages/rules` — getRulesPage

### Admin

- [ ] `GET /api/v1/admin/users` — adminListUsers
- [ ] `PATCH /api/v1/admin/users/:id` — adminUpdateUser
- [ ] `GET /api/v1/admin/transcode-profiles` — adminListTranscodeProfiles
- [ ] `POST /api/v1/admin/transcode-profiles` — adminCreateTranscodeProfile
- [ ] `PATCH /api/v1/admin/transcode-profiles/:id` — adminUpdateTranscodeProfile
- [ ] `DELETE /api/v1/admin/transcode-profiles/:id` — adminDeleteTranscodeProfile

---

## Processing API (`processing/`)

### Service / infrastructure

- [x] `GET /health` — liveness/readiness probe (includes queue readiness)

### Download

- [x] `POST /download` — download a remote video via yt-dlp

### Transcode

- [ ] `POST /transcode` — queue an ffmpeg transcode job
- [ ] `GET /transcode/:jobId` — get transcode job status
