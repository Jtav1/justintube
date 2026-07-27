# API Implementation Checklist

Manual tracking of API route implementation progress across the two backend services.

- **Web API** (`api/`) — public application API, base path `/api/v1` unless noted. Service-to-service callbacks use `/internal`.
- **Processing API** (`processing/`) — internal yt-dlp download + ffmpeg transcode service.

---

## Web API (`api/`)

### Service / infrastructure

- [x] `GET /health` — liveness probe
- [x] `GET /openapi.json` — OpenAPI document
- [x] `GET /docs` — Scalar API reference UI

### Internal (processing callbacks)

Bearer `INTERNAL_SERVICE_TOKEN` required.

- [x] `POST /internal/file-versions/:uuid/complete` — fileVersionComplete
- [x] `POST /internal/file-versions/:uuid/fail` — fileVersionFail

### Auth

- [x] `POST /api/v1/auth/register` — authRegister
- [x] `POST /api/v1/auth/login` — authLogin
- [x] `POST /api/v1/auth/logout` — authLogout
- [x] `GET /api/v1/auth/me` — authMe
- [x] `GET /api/v1/auth/csrf` — authCsrf
- [x] `POST /api/v1/auth/verify-email` — authVerifyEmail
- [x] `POST /api/v1/auth/resend-verification` — authResendVerification
- [x] `POST /api/v1/auth/password` — authChangePassword

Future/wont do now

- [ ] `GET /api/v1/auth/sso/providers` — authSsoProviders
- [ ] `GET /api/v1/auth/sso/:provider/start` — authSsoStart
- [ ] `GET /api/v1/auth/sso/:provider/callback` — authSsoCallback
- [ ] `POST /api/v1/auth/sso/link` — authSsoLink
- [ ] `DELETE /api/v1/auth/sso/link/:provider` — authSsoUnlink

### Search & discovery

- [x] `GET /api/v1/search/suggest` — searchSuggest
- [x] `GET /api/v1/search` — searchVideos
- [x] `GET /api/v1/videos` — listVideos
- [x] `GET /api/v1/videos/featured` — listFeaturedVideos
- [x] `GET /api/v1/videos/newest` — listNewestVideos
- [x] `POST /api/v1/videos/import` — importVideo
- [x] `GET /api/v1/videos/:id` — getVideo
- [x] `PATCH /api/v1/videos/:id` — updateVideo
- [x] `DELETE /api/v1/videos/:id` — deleteVideo
- [x] `GET /api/v1/videos/:id/stream` — getVideoStream
- [x] `GET /api/v1/videos/:id/thumbnail` — getVideoThumbnail
- [x] `POST /api/v1/videos/:id/delist` — delistVideo
- [x] `GET /api/v1/videos/:id/access` — listVideoAccess
- [x] `PUT /api/v1/videos/:id/access` — setVideoAccess
- [x] `POST /api/v1/videos/:id/view` — recordVideoView
- [x] `POST /api/v1/videos/:id/like` — likeVideo
- [x] `POST /api/v1/videos/:id/dislike` — dislikeVideo
- [x] `GET /api/v1/tags` — listTags
- [x] `GET /api/v1/tags/:tag/videos` — listTagVideos
- [x] `GET /api/v1/feed/subscriptions` — feedSubscriptions

### Uploads

- [x] `POST /api/v1/videos/upload` — uploadVideo (multipart)

### Me / library

- [x] `PATCH /api/v1/me` — updateMe
- [x] `GET /api/v1/me/settings` — getMeSettings
- [x] `GET /api/v1/me/videos` — listMyVideos
- [x] `GET /api/v1/me/likes` — listMyLikes
- [x] `GET /api/v1/me/subscriptions` — listMySubscriptions
- [x] `GET /api/v1/me/subscribers` — listMySubscribers
- [x] `GET /api/v1/me/playlists` — listMyPlaylists
- [x] `GET /api/v1/me/notification-preferences` — getNotificationPreferences
- [x] `PATCH /api/v1/me/notification-preferences` — updateNotificationPreferences

Future

- [ ] `GET /api/v1/me/history` — listMyHistory (Will require new history table)
- [ ] `DELETE /api/v1/me/history` — clearMyHistory

### Me / API Keys

- [x] `GET /api/v1/me/api-keys` — listMyApiKeys
- [x] `POST /api/v1/me/api-keys` — createMyApiKey
- [x] `PATCH /api/v1/me/api-keys/:id` — updateMyApiKey
- [x] `DELETE /api/v1/me/api-keys/:id` — revokeMyApiKey

### Users / channels / engagement

- [ ] `GET /api/v1/users/:username` — getUserChannel
- [ ] `GET /api/v1/users/:username/videos` — listUserVideos
- [ ] `POST /api/v1/users/:id/subscribe` — subscribeToUser
- [ ] `DELETE /api/v1/users/:id/subscribe` — unsubscribeFromUser
- [ ] `GET /api/v1/users/:id/subscription` — getSubscriptionState
- [ ] `POST /api/v1/users/:id/ban` — banUser
- [ ] `DELETE /api/v1/users/:id/ban` — unbanUser

### Avatars

- [x] `POST /api/v1/me/avatar` — updateMyAvatar
- [x] `DELETE /api/v1/me/avatar` — deleteMyAvatar
- [x] `GET /api/v1/users/:username/avatar` — getUserAvatar

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

- [x] `GET /api/v1/admin/api-keys` — adminListApiKeys
- [x] `DELETE /api/v1/admin/api-keys/:id` — adminRevokeApiKey
- [x] `GET /api/v1/admin/users` — adminListUsers
- [x] `PATCH /api/v1/admin/users/:id` — adminUpdateUser
- [x] `POST /api/v1/admin/users/:id/password` — adminResetUserPassword
- [x] `GET /api/v1/admin/transcode-profiles` — adminListTranscodeProfiles
- [x] `POST /api/v1/admin/transcode-profiles` — adminCreateTranscodeProfile
- [x] `PATCH /api/v1/admin/transcode-profiles/:id` — adminUpdateTranscodeProfile
- [x] `DELETE /api/v1/admin/transcode-profiles/:id` — adminDeleteTranscodeProfile
- [x] `GET /api/v1/admin/config` — adminListSystemConfig
- [x] `GET /api/v1/admin/config/:name` — adminGetSystemConfig
- [x] `PUT /api/v1/admin/config/:name` — adminUpsertSystemConfig
- [x] `DELETE /api/v1/admin/config/:name` — adminDeleteSystemConfig

---

## Processing API (`processing/`)

### Service / infrastructure

- [x] `GET /health` — liveness/readiness probe (includes queue readiness)

### Download

- [x] `POST /download` — download a remote video via yt-dlp

### Transcode

- [x] `POST /transcode` — queue an ffmpeg transcode job (legacy single or batch)
- [x] `GET /transcode/:jobId` — get transcode job status
- [x] `DELETE /transcode/:jobId` — remove transcode job from Redis
