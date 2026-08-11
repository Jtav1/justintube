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
- [x] `POST /internal/thumbnails/:uploadUuid/complete` — thumbnailComplete

### Auth

- [x] `POST /api/v1/auth/register` — authRegister
- [x] `POST /api/v1/auth/login` — authLogin
- [x] `POST /api/v1/auth/logout` — authLogout
- [x] `GET /api/v1/auth/me` — authMe
- [x] `GET /api/v1/auth/csrf` — authCsrf
- [x] `POST /api/v1/auth/verify-email` — authVerifyEmail
- [x] `POST /api/v1/auth/resend-verification` — authResendVerification
- [x] `POST /api/v1/auth/password` — authChangePassword

### Search & discovery

- [x] `GET /api/v1/search/suggest` — searchSuggest
- [x] `GET /api/v1/search` — searchVideos
- [x] `GET /api/v1/search/users` — searchUsers
- [x] `GET /api/v1/search/advanced` — searchAdvanced
- [x] `GET /api/v1/videos` — listVideos
- [x] `GET /api/v1/videos/featured` — listFeaturedVideos
- [x] `GET /api/v1/videos/newest` — listNewestVideos
- [x] `POST /api/v1/videos/import` — importVideo
- [x] `GET /api/v1/videos/:id` — getVideo
- [x] `GET /api/v1/videos/:id/processing-status` — getVideoProcessingStatus
- [x] `PATCH /api/v1/videos/:id` — updateVideo
- [x] `DELETE /api/v1/videos/:id` — deleteVideo
- [x] `GET /api/v1/videos/:id/unfurl` — getVideoUnfurl
- [x] `GET /api/v1/videos/:id/player` — getVideoPlayer
- [x] `GET /api/v1/videos/:id/stream` — getVideoStream
- [x] `GET /api/v1/videos/:id/thumbnail` — getVideoThumbnail
- [x] `POST /api/v1/videos/:id/thumbnail` — updateVideoThumbnail
- [x] `POST /api/v1/videos/:id/delist` — delistVideo
- [x] `PUT /api/v1/videos/:id/featured` — setVideoFeatured
- [x] `GET /api/v1/videos/:id/access` — listVideoAccess
- [x] `PUT /api/v1/videos/:id/editors` — setVideoEditors
- [x] `PUT /api/v1/videos/:id/viewers` — setVideoViewers
- [x] `POST /api/v1/videos/:id/view` — recordVideoView
- [x] `POST /api/v1/videos/:id/like` — likeVideo
- [x] `POST /api/v1/videos/:id/dislike` — dislikeVideo
- [x] `POST /api/v1/videos/:id/hide` — hideVideo
- [x] `DELETE /api/v1/videos/:id/hide` — unhideVideo
- [x] `POST /api/v1/videos/:id/comments` — createComment
- [x] `GET /api/v1/videos/:id/comments` — listComments
- [x] `PATCH /api/v1/videos/:id/comments/:commentId` — updateComment
- [x] `DELETE /api/v1/videos/:id/comments/:commentId` — deleteComment
- [x] `GET /api/v1/tags` — listTags
- [x] `GET /api/v1/tags/:tag/videos` — listTagVideos
- [x] `GET /api/v1/feed/subscriptions` — feedSubscriptions

### Uploads

- [x] `POST /api/v1/videos/upload` — uploadVideo (multipart)
- [x] `GET /api/v1/videos/import/status` — importStatus

### Me / library

- [x] `PATCH /api/v1/me` — updateMe
- [x] `GET /api/v1/me/settings` — getMeSettings
- [x] `GET /api/v1/me/videos` — listMyVideos
- [x] `GET /api/v1/me/likes` — listMyLikes
- [x] `GET /api/v1/me/likes-playlist` — getMyLikesPlaylist
- [x] `GET /api/v1/me/subscriptions` — listMySubscriptions
- [x] `GET /api/v1/me/subscribers` — listMySubscribers
- [x] `GET /api/v1/me/playlists` — listMyPlaylists
- [x] `GET /api/v1/me/notification-preferences` — getNotificationPreferences
- [x] `PATCH /api/v1/me/notification-preferences` — updateNotificationPreferences
- [x] `GET /api/v1/me/history` — listMyHistory
- [x] `DELETE /api/v1/me/history` — clearMyHistory
- [x] `DELETE /api/v1/me/history/:id` — deleteHistoryEntry

Future

- [ ] `GET /api/v1/videos/:id/reaction` — getVideoReaction
- [ ] `DELETE /api/v1/videos/:id/reaction` — clearVideoReaction

### Me / API Keys

- [x] `GET /api/v1/me/api-keys` — listMyApiKeys
- [x] `POST /api/v1/me/api-keys` — createMyApiKey
- [x] `PATCH /api/v1/me/api-keys/:id` — updateMyApiKey
- [x] `DELETE /api/v1/me/api-keys/:id` — revokeMyApiKey

### Users / channels / engagement

- [x] `GET /api/v1/users` — listUsers
- [x] `GET /api/v1/users/:username` — getUserChannel
- [x] `GET /api/v1/users/:username/videos` — listUserVideos
- [x] `GET /api/v1/users/:username/playlists` — listUserPlaylists
- [x] `POST /api/v1/users/:id/subscribe` — subscribeToUser
- [x] `DELETE /api/v1/users/:id/subscribe` — unsubscribeFromUser
- [x] `GET /api/v1/users/:id/subscription` — getSubscriptionState
- [x] `POST /api/v1/users/:id/ban` — banUser
- [x] `DELETE /api/v1/users/:id/ban` — unbanUser
- [x] `PATCH /api/v1/users/:id/profile` — updateUserProfile (displayName/bio; owner, moderator, or admin)

### Avatars

- [x] `POST /api/v1/me/avatar` — updateMyAvatar
- [x] `DELETE /api/v1/me/avatar` — deleteMyAvatar
- [x] `GET /api/v1/users/:username/avatar` — getUserAvatar
- [x] `POST /api/v1/users/:id/avatar` — updateUserAvatar (owner, moderator, or admin)
- [x] `DELETE /api/v1/users/:id/avatar` — deleteUserAvatar (owner, moderator, or admin)

### Banners

- [x] `POST /api/v1/users/:id/banner` — updateUserBanner (owner, moderator, or admin)
- [x] `DELETE /api/v1/users/:id/banner` — deleteUserBanner (owner, moderator, or admin)
- [x] `GET /api/v1/users/:username/banner` — getUserBanner

### Playlists

- [x] `POST /api/v1/playlists` — createPlaylist
- [x] `GET /api/v1/playlists` — listPlaylists
- [x] `GET /api/v1/playlists/:id` — getPlaylist
- [x] `PATCH /api/v1/playlists/:id` — updatePlaylist
- [x] `DELETE /api/v1/playlists/:id` — deletePlaylist
- [x] `POST /api/v1/playlists/:id/items` — addPlaylistItem
- [x] `DELETE /api/v1/playlists/:id/items/:videoId` — removePlaylistItem

- [x] `GET /api/v1/playlists/:id/access` — listPlaylistAccess
- [x] `POST /api/v1/playlists/:id/access` — addPlaylistAccess
- [x] `DELETE /api/v1/playlists/:id/access/:userId` — removePlaylistAccess

### Livestreaming

The webapi application layer (stream keys, the `LIVESTREAMS` model, the
public routes, and the internal ingest callbacks) is implemented, and a real
RTMP/HLS ingest component now sits in front of webapi: the `streaming`
service (`streaming/`), a Dockerized MediaMTX instance. OBS pushes to it
using a per-user stream key (`STREAM_KEYS` table, same hash/prefix/revoke
pattern as `USER_API_KEYS` but scoped to publish-only so a leaked key can't
be used to call the rest of the API) — OBS's "Server" field is the same
`RTMP_INGEST_URL` for every user, and its "Stream Key" field is the raw
secret, since OBS always concatenates the two into one publish path. MediaMTX
validates each publish attempt against `POST
/internal/livestreams/mediamtx-auth` (its `authHTTPAddress` webhook — see
`streaming/mediamtx.yml`), then calls the `/internal/livestreams/*` lifecycle
callbacks below via `streaming/scripts/on-{publish,unpublish}.sh`, the same
way `processing` calls `/internal/file-versions/*`. Those scripts also
dynamically add/remove a stable `live/{userId}` MediaMTX path (via MediaMTX's
own control API) that re-pulls the just-published stream, so
`getLivestreamPlayback` can build a playback URL from `userId` alone without
ever needing the raw stream key.

- [x] `GET /api/v1/me/stream-key` — getMyStreamKey
- [x] `POST /api/v1/me/stream-key/rotate` — rotateMyStreamKey (invalidates the old key; also find-or-creates the caller's LIVESTREAMS row)
- [x] `DELETE /api/v1/me/stream-key` — revokeMyStreamKey
- [x] `GET /api/v1/me/livestream` — getMyLivestream (not in the original design; added so the Go Live page can load/edit stream details before any ingest server exists to create the row via `/internal/livestreams/authorize`)

- [x] `GET /api/v1/livestreams` — listLivestreams (currently-live public streams)
- [x] `GET /api/v1/livestreams/:id` — getLivestream (status, viewer count, playback info)
- [x] `PATCH /api/v1/livestreams/:id` — updateLivestream (title/description/visibility)
- [x] `GET /api/v1/livestreams/:id/playback` — getLivestreamPlayback (HLS playbackUrl when live, derived from `HLS_BASE_URL` + userId; null when offline)
- [x] `GET /api/v1/users/:username/live` — getUserLiveStatus (channel-page "LIVE" badge)

Internal (ingest server callbacks; Bearer `INTERNAL_SERVICE_TOKEN`, mirrors the processing-callback pattern above):

- [x] `POST /internal/livestreams/authorize` — livestreamAuthorize (on-publish webhook: validates the stream key, finds/creates the LIVESTREAMS row)
- [x] `POST /internal/livestreams/mediamtx-auth` — livestreamMediamtxAuth (MediaMTX's `authHTTPAddress` publish-time gate; query-string-token auth since MediaMTX can't send an Authorization header)
- [x] `POST /internal/livestreams/:id/start` — livestreamStart
- [x] `POST /internal/livestreams/:id/stop` — livestreamStop (recording handoff to `processing` for VOD is still future work)

### CAST (FUTURE)

- [ ] `POST /api/v1/cast` — createCastSpace
- [ ] `POST /api/v1/cast/join` — joinCastSpace
- [ ] `GET /api/v1/cast/:id` — getCastSpace
- [ ] `POST /api/v1/cast/:id/playlist` — addCastPlaylistItem
- [ ] `DELETE /api/v1/cast/:id/playlist/:videoId` — removeCastPlaylistItem
- [ ] `GET /api/v1/cast/:id/members` — listCastMembers
- [ ] `GET /api/v1/cast/:id/display` — getCastDisplay
- [ ] `GET /api/v1/cast/:id/sync` — castSyncWebSocket

### Notifications & pages

- [x] `GET /api/v1/notifications` — listNotifications
- [x] `POST /api/v1/notifications/read` — markNotificationsRead
- [x] `GET /api/v1/pages/about` — getAboutPage
- [x] `GET /api/v1/pages/rules` — getRulesPage

### Admin

- [x] `GET /api/v1/admin/api-keys` — adminListApiKeys
- [x] `DELETE /api/v1/admin/api-keys/:id` — adminRevokeApiKey
- [x] `GET /api/v1/admin/users` — adminListUsers
- [x] `PATCH /api/v1/admin/users/:id` — adminUpdateUser
- [x] `POST /api/v1/admin/users/:id/password` — adminResetUserPassword
- [x] `POST /api/v1/admin/users/:id/resend-verification` — adminResendUserVerification
- [x] `GET /api/v1/admin/transcode-profiles` — adminListTranscodeProfiles
- [x] `POST /api/v1/admin/transcode-profiles` — adminCreateTranscodeProfile
- [x] `PATCH /api/v1/admin/transcode-profiles/:id` — adminUpdateTranscodeProfile
- [x] `DELETE /api/v1/admin/transcode-profiles/:id` — adminDeleteTranscodeProfile
- [x] `GET /api/v1/admin/config` — adminListSystemConfig
- [x] `GET /api/v1/admin/config/:name` — adminGetSystemConfig
- [x] `PUT /api/v1/admin/config/:name` — adminUpsertSystemConfig
- [x] `DELETE /api/v1/admin/config/:name` — adminDeleteSystemConfig
- [x] `POST /api/v1/admin/notifications/broadcast` — adminBroadcastNotification

### Reports

- [x] `POST /api/v1/reports` — createReport
- [x] `GET /api/v1/reports/mine` — listMyReports
- [x] `GET /api/v1/reports` — listReports (moderator/admin, filterable by resolved)
- [x] `GET /api/v1/reports/:id` — getReport (moderator/admin)
- [x] `PATCH /api/v1/reports/:id` — updateReport (owner: description, one-way close)
- [x] `PATCH /api/v1/reports/:id/moderate` — moderateReport (moderator/admin: resolved + comment)
- [x] `DELETE /api/v1/reports/:id` — deleteReport (admin only)

### Themes

- [x] `GET /api/v1/themes` — listThemes
- [x] `POST /api/v1/themes` — createTheme
- [x] `PATCH /api/v1/themes/:id` — updateTheme
- [x] `DELETE /api/v1/themes/:id` — deleteTheme
- [x] `GET /api/v1/themes/:id/images/:slot` — getThemeImage
- [x] `PUT /api/v1/me/theme` — selectMyTheme
- [x] `GET /api/v1/users/:id/theme` — getUserTheme

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
