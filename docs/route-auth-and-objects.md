# Route auth audit

Every implemented route in `webapi/` and `processing/`, with its auth requirement. Stub routes (`routes/stubs.js`, `routes/internal-livestreams.js`) are excluded — they 501 unconditionally and don't enforce auth yet.

## Legend

**Roles** (`ROLES` table, seeded in `lib/seed.js`): `admin`, `moderator`, `uploader`, `viewer`, `locked` (rejected at `requireAuth`/`optionalAuth` — a locked user is treated as unauthenticated). Email verification is a separate `USERS.emailVerified` boolean, not a role — any role can be verified or unverified independently.

**Auth mechanisms:**
- **None** — no `requireAuth`/`optionalAuth` at all.
- **Optional** (`optionalAuth`) — populates `req.user`/`req.authRole` when a session cookie or Bearer API key is present, but never rejects. Used by discovery routes that must also apply per-resource visibility.
- **Required** (`requireAuth`) — 401s without a valid session cookie or Bearer API key.
- **Required + role** — `requireAuth` plus `requireAdmin` (403 unless `role.name === "admin"`) or `requireModerator` (403 unless admin or moderator).
- **Owner/admin** — `requireAuth` plus an in-handler `isOwnerOrAdmin(user, role, resource)` check (true for the resource's `userId` or any admin).
- **Visibility gate** — `canViewVideo`/`canViewPlaylist` (`lib/video-access.js`, `lib/playlist-access.js`). The owner (and admins) may always view their own resource regardless of visibility. Otherwise: `public`/`unlisted` are viewable by anyone; `private`/`hidden` require a per-resource grant row (`VIDEO_ACCESS` / `PLAYLIST_ACCESS`, looked up by the authenticated user's id). `hidden` is stricter than `unlisted` — unlike `unlisted`, it is not openly viewable by id, only via owner/admin/grant.
- **CSRF** — all mutating (`POST`/`PUT`/`PATCH`/`DELETE`) routes on a router that calls `router.use(csrfProtection)` additionally require an `X-CSRF-Token` header matching `req.session.csrfToken` — but only for cookie-session callers; a Bearer API key request skips this. Noted once per router below rather than per row.
- **Uploader flag** — `requireUploader` (`lib/auth/require-uploader.js`): 403s unless `req.user.uploader === true` or the caller is an admin.

---

## Web API (`webapi/`) — `/api/v1` unless noted

### Auth (`routes/auth.js`) — CSRF enforced on the whole router

| Route | operationId | Auth |
|---|---|---|
| `GET /auth/csrf` | authCsrf | None (issues/reads the session CSRF token) |
| `POST /auth/register` | authRegister | None |
| `POST /auth/login` | authLogin | None |
| `POST /auth/logout` | authLogout | Required |
| `GET /auth/me` | authMe | Required |
| `POST /auth/verify-email` | authVerifyEmail | None (token in body is the credential) |
| `POST /auth/resend-verification` | authResendVerification | Required |
| `POST /auth/password` | authChangePassword | Required — additionally rejects `req.authMethod !== "session"` (API keys can't change the password) |

### Search & discovery (`routes/search.js`, `routes/videos.js`)

| Route | operationId | Auth | Notes |
|---|---|---|---|
| `GET /search` | searchVideos | Optional | Only ever indexes public+ready videos (`loadEligibleDocument`); nothing private is searchable |
| `GET /search/suggest` | searchSuggest | Optional | Same as above |
| `GET /videos` | listVideos | Optional | Public, + the caller's own `unlisted`/`hidden` videos (`listPublicVideos`) |
| `GET /videos/featured` | listFeaturedVideos | Optional | Public, + the caller's own `unlisted`/`hidden` videos |
| `GET /videos/newest` | listNewestVideos | Optional | Public, + the caller's own `unlisted`/`hidden` videos |
| `GET /videos/:id` | getVideo | Optional | **Visibility gate** |
| `GET /videos/:id/stream` | getVideoStream | Optional | **Visibility gate** |
| `GET /videos/:id/thumbnail` | getVideoThumbnail | Optional | **Visibility gate** |
| `PATCH /videos/:id` | updateVideo | **Owner/admin** | CSRF (router-level); transitioning `visibility` to `hidden` wipes any existing `VIDEO_ACCESS` grants — any other transition (including back to `private`) preserves them |
| `DELETE /videos/:id` | deleteVideo | **Owner/admin** | CSRF |
| `POST /videos/:id/delist` | delistVideo | Required + moderator | Sets visibility to `unlisted`; CSRF |
| `GET /videos/:id/access` | listVideoAccess | **Owner/admin** | Lists `VIDEO_ACCESS` grantees, regardless of current visibility |
| `PUT /videos/:id/access` | setVideoAccess | **Owner/admin** | Replace-all grant list by username; CSRF; only allowed while the video is currently `private` (`400 invalid_state` otherwise) |
| `POST /videos/:id/view` | recordVideoView | Optional | **Visibility gate** (404s instead of counting a view on a video you can't see) |
| `POST /videos/:id/like` | likeVideo | Required | **Visibility gate**; CSRF |
| `POST /videos/:id/dislike` | dislikeVideo | Required | **Visibility gate**; CSRF |
| `GET /tags` | listTags | Optional | Public only |
| `GET /tags/:tag/videos` | listTagVideos | Optional | Public, + the caller's own `unlisted`/`hidden` videos |
| `GET /feed/subscriptions` | feedSubscriptions | Required | Public videos (+ the caller's own `unlisted`/`hidden`, in the unusual case of self-subscription) from channels the caller subscribes to |

### Uploads (`routes/uploads.js`) — CSRF enforced on both routes

| Route | operationId | Auth |
|---|---|---|
| `POST /videos/upload` | uploadVideo | Required + uploader flag (`req.user.uploader === true`, or admin) |
| `POST /videos/import` | importVideo | Required + uploader flag (or admin) |

### Me / library (`routes/me.js`) — CSRF enforced on the whole router

| Route | operationId | Auth |
|---|---|---|
| `PATCH /me` | updateMe | Required |
| `GET /me/settings` | getMeSettings | Required |
| `GET /me/videos` | listMyVideos | Required |
| `GET /me/likes` | listMyLikes | Required — filters to videos the caller can currently see, via `canViewVideo` (owner/admin always; public/unlisted always; private/hidden only with a grant) |
| `GET /me/subscriptions` | listMySubscriptions | Required |
| `GET /me/subscribers` | listMySubscribers | Required |
| `GET /me/playlists` | listMyPlaylists | Required |
| `GET /me/notification-preferences` | getNotificationPreferences | Required |
| `PATCH /me/notification-preferences` | updateNotificationPreferences | Required |
| `POST /me/avatar` | updateMyAvatar | Required |
| `DELETE /me/avatar` | deleteMyAvatar | Required |

### Me / API keys (`routes/api-keys.js`) — CSRF enforced on the whole router

| Route | operationId | Auth |
|---|---|---|
| `GET /me/api-keys` | listMyApiKeys | Required |
| `POST /me/api-keys` | createMyApiKey | Required |
| `PATCH /me/api-keys/:id` | updateMyApiKey | Required — implicitly owner-scoped (`where: { id, userId: req.user.id }`) |
| `DELETE /me/api-keys/:id` | revokeMyApiKey | Required — same owner scoping |
| `GET /admin/api-keys` | adminListApiKeys | Required + admin |
| `DELETE /admin/api-keys/:id` | adminRevokeApiKey | Required + admin |

### Users / channels / engagement (`routes/users.js`) — CSRF enforced on the whole router

| Route | operationId | Auth | Notes |
|---|---|---|---|
| `GET /users/:username` | getUserChannel | Optional | Public profile fields; video page is public, + the caller's own `unlisted`/`hidden` videos when viewing their own channel |
| `GET /users/:username/videos` | listUserVideos | Optional | Public, + the caller's own `unlisted`/`hidden` videos when viewing their own channel |
| `POST /users/:id/subscribe` | subscribeToUser | Required | |
| `DELETE /users/:id/subscribe` | unsubscribeFromUser | Required | |
| `GET /users/:id/subscription` | getSubscriptionState | Required | |
| `POST /users/:id/ban` | banUser | Required + admin | Sets target role to `locked`; blocks self-ban |
| `DELETE /users/:id/ban` | unbanUser | Required + admin | Sets target role to `viewer` |
| `GET /users/:username/avatar` | getUserAvatar | None | Public image |

### Playlists (`routes/playlists.js`) — CSRF enforced on the whole router

| Route | operationId | Auth | Notes |
|---|---|---|---|
| `POST /playlists` | createPlaylist | Required | |
| `GET /playlists/:id` | getPlaylist | Optional | **Visibility gate** on the playlist itself (`canViewPlaylist` + `PLAYLIST_ACCESS` grant), **plus** per-item filtering via `filterViewablePlaylistItems`: `hidden` videos are always dropped, `private` videos only kept for their owner/admin/a `VIDEO_ACCESS` grantee |
| `PATCH /playlists/:id` | updatePlaylist | **Owner/admin** | |
| `DELETE /playlists/:id` | deletePlaylist | **Owner/admin** | |
| `POST /playlists/:id/items` | addPlaylistItem | **Owner/admin** (of the playlist) | Adding an item to a playlist is unrestricted by the target video's own visibility — intentional; see below re: read-time filtering |
| `DELETE /playlists/:id/items/:videoId` | removePlaylistItem | **Owner/admin** | |
| `GET /playlists/:id/access` | listPlaylistAccess | **Owner/admin** | Lists `PLAYLIST_ACCESS` grantees |
| `POST /playlists/:id/access` | addPlaylistAccess | **Owner/admin** | By username |
| `DELETE /playlists/:id/access/:userId` | removePlaylistAccess | **Owner/admin** | |

### Notifications & pages (`routes/notifications.js`, `routes/notification-preferences.js`, `routes/pages.js`)

| Route | operationId | Auth |
|---|---|---|
| `GET /notifications` | listNotifications | Required |
| `POST /notifications/read` | markNotificationsRead | Required; CSRF (router-level) |
| `GET /pages/about` | getAboutPage | None |
| `GET /pages/rules` | getRulesPage | None |

### Admin (`routes/transcode-profiles.js`, `routes/system-config.js`, `routes/admin-users.js`) — CSRF enforced on each router

| Route | operationId | Auth |
|---|---|---|
| `GET /admin/users` | adminListUsers | Required + admin |
| `PATCH /admin/users/:id` | adminUpdateUser | Required + admin |
| `POST /admin/users/:id/password` | adminResetUserPassword | Required + admin |
| `GET /admin/transcode-profiles` | adminListTranscodeProfiles | Required + admin |
| `POST /admin/transcode-profiles` | adminCreateTranscodeProfile | Required + admin |
| `PATCH /admin/transcode-profiles/:id` | adminUpdateTranscodeProfile | Required + admin |
| `DELETE /admin/transcode-profiles/:id` | adminDeleteTranscodeProfile | Required + admin |
| `GET /admin/config` | adminListSystemConfig | Required + admin |
| `GET /admin/config/:name` | adminGetSystemConfig | Required + admin |
| `PUT /admin/config/:name` | adminUpsertSystemConfig | Required + admin |
| `DELETE /admin/config/:name` | adminDeleteSystemConfig | Required + admin |

### Internal (`routes/internal-file-versions.js`) — service-to-service

| Route | operationId | Auth |
|---|---|---|
| `POST /internal/file-versions/:uuid/complete` | fileVersionComplete | Bearer `INTERNAL_SERVICE_TOKEN` |
| `POST /internal/file-versions/:uuid/fail` | fileVersionFail | Bearer `INTERNAL_SERVICE_TOKEN` |

### Service / infrastructure

| Route | Auth |
|---|---|
| `GET /health` | None |
| `GET /openapi.json` | None |
| `GET /docs` | None |

---

## Processing API (`processing/`)

Meant to be reachable only by `webapi` over the private Docker network — see `docker-compose.yml` (no `ports:` mapping published for `processing`). `/download` and `/transcode` are additionally gated by `requireInternalToken` (`processing/lib/require-internal-token.js`) as defense-in-depth, using the same `INTERNAL_SERVICE_TOKEN` shared secret both services already carry for the reverse direction (`webapi/lib/processing-client.js` sends it on every outbound call).

| Route | Auth |
|---|---|
| `GET /health` | None (liveness probe) |
| `POST /download` | Bearer `INTERNAL_SERVICE_TOKEN` |
| `POST /transcode` | Bearer `INTERNAL_SERVICE_TOKEN` |
| `GET /transcode/:jobId` | Bearer `INTERNAL_SERVICE_TOKEN` |
| `DELETE /transcode/:jobId` | Bearer `INTERNAL_SERVICE_TOKEN` |

---

## Findings

All three issues originally found by this audit have been fixed:

1. ~~`POST /videos/upload` and `POST /videos/import` have no auth at all~~ — **fixed**. Both now require `requireAuth` + `requireUploader` (the `uploader` flag on `USERS`, or admin) + CSRF, and persist `userId: req.user.id` instead of `null`. New `lib/auth/require-uploader.js` middleware. Tests updated in `tests/http/upload.test.js` / `tests/http/import.test.js` to seed an uploader-flagged user and assert 401 (unauthenticated) / 403 (authenticated, non-uploader).

2. ~~`processing/` has no authentication on any route~~ — **fixed**. `/download` and `/transcode` now require `Authorization: Bearer INTERNAL_SERVICE_TOKEN` (`processing/lib/require-internal-token.js`), and `docker-compose.yml` no longer publishes `processing`'s port to the host — it's reachable only via the compose network as `http://processing:3001`, which is how `webapi` already addressed it. `webapi/lib/processing-client.js` now sends the token on every outbound call.

3. ~~`addPlaylistItem` doesn't check the target video's visibility~~ — **fixed at read time**, per explicit product decision: adding a limited-visibility video to a playlist is fine, but `GET /playlists/:id` now filters items through `filterViewablePlaylistItems` (`routes/playlists.js`) before serializing. `hidden` videos are always dropped (even for the playlist owner — hidden is a moderation/delist state, not a personal-visibility one); `private` videos are kept only for their owner, an admin, or a `VIDEO_ACCESS` grantee, batch-checked in one query per request. `itemCount` in the response now reflects the filtered count, not the raw row count. Covered by a new test in `tests/http/playlists.test.js`.

4. Everything else lines up cleanly: every mutating route that isn't public-by-design sits behind `requireAuth`, ownership/admin checks are consistent (`isOwnerOrAdmin`), private-resource visibility is enforced identically for videos and playlists via the same grant-table pattern, and CSRF is applied uniformly per-router for cookie sessions while correctly bypassed for Bearer API key callers.

A follow-up pass tightened video visibility/auth further:

5. `authLogout` now requires `requireAuth` — it used to silently 204 for anonymous callers instead of rejecting them.
6. `authResendVerification` was already fixed to require `requireAuth` in a prior pass; this doc simply had a stale "None" entry.
7. `canViewVideo` (`lib/video-access.js`) was rewritten so the owner (and admins) can always reach their own video regardless of visibility, checked before any visibility branch; `hidden` was split out from `unlisted` and now requires a `VIDEO_ACCESS` grant just like `private` (previously it was openly viewable by id like `public`/`unlisted`). `GET /me/likes` (`routes/me.js`) had its own hand-rolled, slightly-diverging copy of this logic replaced with a direct call to `canViewVideo`.
8. `delistVideo` now sets `unlisted` instead of `hidden` — delisting removes a video from discovery/browse lists without making it inaccessible to anyone with the link, whereas `hidden` is now reserved for a stricter takedown state.
9. Bulk browse/discovery lists (`listVideos`, `listFeaturedVideos`, `listNewestVideos`, `listTagVideos`, `feedSubscriptions`, `listUserVideos`) never surface `unlisted`/`hidden` videos except the caller's own — implemented via `listPublicVideos`'s new `viewerUserId` option (`routes/videos.js`) and an `isSelf` flag on `loadUserPublicVideosPage` (`routes/users.js`). `GET /playlists/:id` and `GET /search`/`/search/suggest` were deliberately left out of scope (playlists already have their own item-level filtering from a prior pass; search's index is a single global, non-personalized store).
10. `VIDEO_ACCESS` grants are now tied to visibility: `PUT /videos/:id/access` requires the video to currently be `private` (`400 invalid_state` otherwise); `PATCH /videos/:id` wipes all grants for a video the moment its visibility becomes `hidden`, while any other transition (including back to `private`) preserves them.

---

## Video object field consistency

Every route that returns video data, and exactly which fields it includes. Goal: confirm a video looks the same whether it comes back as part of a bulk list or a single-video fetch. Four distinct shapes are in use.

### Shape reference

**A. `serializeVideo(upload, metadata, options)`** (`routes/videos.js`) — the canonical shape, built from `ORIGINAL_UPLOADS` + `VIDEO_METADATA` (+ `User`, `VideoThumbnail`):

| Field | Type | Notes |
|---|---|---|
| `id` | number | `ORIGINAL_UPLOADS.id` |
| `title` | string | `VIDEO_METADATA.title` |
| `description` | string \| `null` | `null` when unset |
| `visibility` | string | `public` / `unlisted` / `private` / `hidden` |
| `commentsEnabled` | boolean | |
| `viewCount` | number | |
| `uploader` | `{userId, username, displayName}` | via `serializeUserRef` (`lib/serialize-user-ref.js`) |
| `tags` | `string[]` | This video's `CONTENT_TAGS`, batch-loaded via `loadTagsByUploadId` (`routes/videos.js`) — always present, `[]` when the video has none |
| `durationSeconds` | number \| `null` | |
| `thumbnailUrl` | string \| `null` | `/api/v1/videos/{id}/thumbnail` if a thumbnail exists, else `null` |
| `createdAt` | ISO date | `VIDEO_METADATA.createdAt` |
| `updatedAt` | ISO date | `VIDEO_METADATA.updatedAt` |
| `renditions` | array (optional) | `[{resolution, width, height}]` for complete transcodes — attached by the three single-video routes (`getVideo`, `updateVideo`, `delistVideo`); the key is absent (not `null`) on every bulk-list route |

**B. `serializeHit(hit)`** (`routes/search.js`) — maps a search-index document, not a live DB row. Same fields as shape A except it never attaches `renditions` (search hits don't carry transcode state). `description` now consistently normalizes to `null` when unset, matching shape A (see Fixes below).

**C. Search suggest** (`routes/search.js`, inline, no shared helper) — deliberately minimal for typeahead: `{ id, title, uploader }` only. No `description`, `visibility`, `viewCount`, `durationSeconds`, `thumbnailUrl`, `createdAt`/`updatedAt`, or `tags`.

**D. Upload/import response** (`uploadResponseBody(upload)`, `routes/uploads.js`) — an `ORIGINAL_UPLOADS`-only shape returned at creation time, before `VIDEO_METADATA` exists: `{ id, originalFilename, uuidName, fileExtension, mimeType, fileSizeBytes, storagePath, status, userId, videoWidth, videoHeight, resolution, durationSeconds }`, plus `fileVersions`/`failures`/`skippedProfiles` when relevant. No `title`, `description`, `visibility`, `commentsEnabled`, `viewCount`, `uploader` object, `tags`, or `thumbnailUrl` — none of shape A's catalog fields exist yet at this point in the flow.

### Route → shape

| Route | operationId | Shape | Notes |
|---|---|---|---|
| `GET /videos/:id` | getVideo | A (+ `renditions`) | |
| `PATCH /videos/:id` | updateVideo | A (+ `renditions`) | |
| `POST /videos/:id/delist` | delistVideo | A (+ `renditions`) | |
| `GET /videos` | listVideos | A | |
| `GET /videos/featured` | listFeaturedVideos | A | |
| `GET /videos/newest` | listNewestVideos | A | |
| `GET /tags/:tag/videos` | listTagVideos | A | |
| `GET /feed/subscriptions` | feedSubscriptions | A | |
| `GET /me/videos` | listMyVideos | A | |
| `GET /me/likes` | listMyLikes | A | |
| `GET /users/:username` | getUserChannel | A | Under `videos.items` |
| `GET /users/:username/videos` | listUserVideos | A | |
| `GET /playlists/:id` | getPlaylist | A | Under `items`, post-`filterViewablePlaylistItems` |
| `GET /search` | searchVideos | B | |
| `GET /search/suggest` | searchSuggest | C | `{id, title, uploader}` only |
| `POST /videos/upload` | uploadVideo | D | Pre-metadata upload record |
| `POST /videos/import` | importVideo | D | Same |

**Not a video representation** (listed for completeness, not a gap): `GET /videos/:id/stream` and `GET /videos/:id/thumbnail` stream binary media, not JSON. `POST /videos/:id/view` returns `{viewCount}`, `POST /videos/:id/like` / `dislike` return `{liked}`, `DELETE /videos/:id` returns `200 { success: true }` (see "Zero-data response audit" below), and `GET`/`PUT /videos/:id/access` return access-grant lists, not video fields.

### Fixes applied

1. ~~`renditions` is missing from `updateVideo` and `delistVideo`~~ — **fixed**. Both now run the same complete-`FileVersion` query as `getVideo` and pass the result as `options.renditions`, so every single-video route returns the identical shape.
2. ~~`tags` only ever appears on `GET /search` results~~ — **fixed**. `serializeVideo` now always includes `tags` (defaulting to `[]`), sourced from a new `loadTagsByUploadId(originalUploadIds)` helper (`routes/videos.js`) that batch-loads `CONTENT_TAGS` in one query per response rather than per video. Wired into every shape-A call site: `listPublicVideos`, `getVideo`, `updateVideo`, `delistVideo`, `listMyVideos`, `listMyLikes`, `getPlaylist`, and `loadUserPublicVideosPage`.
3. ~~`description` defaults differ (`null` vs `""`)~~ — **fixed**. `serializeHit` (`routes/search.js`) now normalizes with `hit.description || null` instead of `hit.description ?? null` — the search index stores an unset description as `""`, which `??` never catches (it's not nullish) but `||` does.

Remaining, deliberately out of scope: shapes C (search suggest) and D (upload/import) stay minimal/different for their use cases (typeahead performance; pre-metadata creation response) — not bugs, just the only two "video-returning" routes that don't share `serializeVideo`/`serializeHit`.

---

## Zero-data response audit

Reviewed every route in both services for responses that carry no data at all, regardless of status code (i.e. beyond the standard `{error, message}` shape on 4xx/5xx). Two categories turned up, both now fixed:

**12 routes returned bare `204 No Content`.** All are now `200` with `{ success: true }` on success (and `success: false` added alongside the existing `error`/`message` fields on that same handler's own local error branches — not touched on shared middleware like `requireAuth`/`requireAdmin`/`csrfProtection`, which stay `{error, message}` for every route uniformly):

| Route | operationId |
|---|---|
| `POST /auth/logout` | authLogout |
| `POST /auth/resend-verification` | authResendVerification |
| `POST /auth/password` | authChangePassword |
| `DELETE /me/api-keys/:id` | revokeMyApiKey |
| `DELETE /me/avatar` | deleteMyAvatar |
| `POST /admin/users/:id/password` | adminResetUserPassword |
| `DELETE /admin/api-keys/:id` | adminRevokeApiKey |
| `DELETE /admin/config/:name` | adminDeleteSystemConfig |
| `DELETE /admin/transcode-profiles/:id` | adminDeleteTranscodeProfile |
| `DELETE /playlists/:id` | deletePlaylist |
| `DELETE /videos/:id` | deleteVideo |
| `POST /notifications/read` | markNotificationsRead |

`processing/` has no 204 endpoints — every route there already returns at least `{success, ...}`.

**`POST /internal/thumbnails/:uploadUuid/complete` returned only `{ success: true }`**, unlike its sibling `POST /internal/file-versions/:uuid/complete` (`{success, uuidName, status}`). Brought in line: now returns `{ success: true, uploadUuid, status: "complete" }`, matching the identifying-key-plus-status shape of the file-version callback.

---

## Remaining open item (pre-existing, unrelated to this audit)

- [ ] Create standard response-object shapes for thumbnail and video-stream-page payloads (carried over from the original note in this file; not addressed here).
