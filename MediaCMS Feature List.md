# Self-Hosted Media Platform — Development Feature List

A MediaCMS-style platform: YouTube-like frontend, multi-format media support, self-hosted transcoding pipeline. Organized roughly in build order.

---

## Phase 1 — Core Media Pipeline (MVP backbone)

### Upload & Ingest

- Chunked/resumable uploads (tus protocol or multipart) — large files over flaky connections
- Drag-and-drop + file picker, multi-file queue with per-file progress
- Server-side validation:
  - MIME sniffing (not extension-based)
  - Max size limits
  - Duplicate detection via checksum (SHA-256)
- Supported types:
  - Video: mp4, mkv, webm, mov, avi
  - Audio: mp3, flac, ogg, m4a
  - Images: jpg, png, webp, gif
  - PDF
- Upload-while-metadata-edit: user fills in title/description/tags while the file transfers
- Background job queue for all post-upload processing (Celery/BullMQ/Sidekiq-style — pick per stack)

### Transcoding Pipeline

- FFmpeg-based worker pool, decoupled from web app (separate container, scalable)
- Ladder encoding: 240p / 360p / 480p / 720p / 1080p / source (skip rungs above source resolution)
- HLS output (segmented `.m3u8` + `.ts` or fMP4) for adaptive bitrate streaming; optionally DASH
- H.264 baseline for compatibility, optional H.265/AV1 profiles behind config flag
- Hardware acceleration support (NVENC/QSV/VAAPI) as a config option — big deal for self-hosters
- Audio normalization pass (`loudnorm`) optional
- Thumbnail generation:
  - Poster frame (user-selectable timestamp)
  - Sprite sheets for scrub preview
  - Animated hover preview (short webp/gif)
- Waveform generation for audio files
- PDF: page-count extraction, first-page thumbnail
- Job states: queued → processing → success/failed, with retry + failure reason surfaced in UI
- Priority queue (short videos jump ahead of 4-hour uploads)

### Storage

- Pluggable storage backend: local filesystem first, S3-compatible (MinIO) second
- Separate originals from derived assets (encodings, thumbs) — originals optionally purgeable after encode
- Per-user and global storage quota accounting

---

## Phase 2 — Playback System

### Player (video.js or Vidstack as base)

- Adaptive bitrate (HLS.js), manual quality selector with "Auto" default
- Playback speed 0.25x–2x
- Keyboard shortcuts:
  - Space — play/pause
  - ← / → — seek
  - ↑ / ↓ — volume
  - `f` — fullscreen
  - `m` — mute
  - `0`–`9` — seek %
  - `<` / `>` — speed
- Scrub bar with sprite-sheet thumbnail previews
- Volume persistence + quality preference persistence (`localStorage`)
- Theater mode, fullscreen, mini-player (persistent corner player while browsing)
- Picture-in-Picture
- Resume playback ("continue watching") — server-side watch position sync
- Autoplay next (playlist/related), with countdown + cancel
- Loop toggle
- Embed mode:
  - iframe-safe player page with start-time param
  - Minimal chrome
  - oEmbed endpoint
- Captions/subtitles: WebVTT upload, multi-language tracks, styling options
- Chapters:
  - Timestamped chapters (from description parsing and/or dedicated editor)
  - Chapter markers on scrub bar
- Audio player variant: waveform display, album art
- Image viewer: zoom/pan, gallery navigation
- PDF viewer: paginated inline viewer
- 360°/VR video support (stretch goal)

### Delivery

- HTTP range requests + segment serving via nginx/Caddy directly (bypass app server)
- Signed/expiring URLs for private media
- Optional CDN/edge-cache friendly cache headers
- Bandwidth throttling per stream (optional, protects small servers)

---

## Phase 3 — YouTube-Like Frontend

### Layout & Navigation

- Persistent left sidebar: Home, Trending/Popular, Subscriptions, Library (History, Watch Later, Playlists, Liked)
- Collapsible sidebar → icon rail on smaller widths
- Top bar: logo, search with typeahead suggestions, upload button, notifications bell, avatar menu
- Dark/light theme, system-follow default
- Fully responsive: grid collapses 4 → 3 → 2 → 1 columns; mobile bottom nav
- Infinite scroll with virtualized lists on index pages

### Pages

- **Home** — recommendation rows / latest grid, category chips filter bar
- **Watch page** — player, title, view count + date, like/dislike, share, save-to-playlist, download (if allowed), channel row with subscribe button, collapsible description, comments, related sidebar
- **Channel page** — banner, avatar, tabs (Videos, Playlists, About), sort controls, subscriber count
- **Search results** — filters (type, duration, date, sort by relevance/date/views)
- **Category/tag pages**
- **Library pages** — history (with search + clear), watch later, liked, playlists
- **Upload/Studio dashboard** — media manager table (status, visibility, views, comments), edit metadata, analytics per video, bulk actions
- **Playlist page** — reorderable list, play-all, shuffle

### Media Cards

- Thumbnail with duration badge, hover animated preview, progress bar for partially watched
- Title (2-line clamp), channel name + avatar, views · age
- Context menu (⋮): watch later, add to playlist, share, report

---

## Phase 4 — Users, Auth & Permissions

### Accounts

- Email/password with verification, password reset
- OIDC/SAML SSO support (huge for the self-host crowd — Authelia/Authentik/Keycloak)
- Optional registration modes: open / invite-only / closed / admin-approval
- Profiles: avatar, banner, bio, links
- Per-user notification preferences

### Roles & Access Control

- Roles: admin, manager/editor, trusted user, user, anonymous
- RBAC groups: categories restricted to groups, per-media view/edit grants
- Visibility levels per media:
  - Public
  - Unlisted
  - Private
  - Restricted (password or group)
- Upload permission gating (e.g., only trusted+ can publish without review)
- Per-role limits: max file size, daily upload quota, allowed media types

### Moderation Workflow

- Optional review queue: uploads held until approved
- Reporting system (media + comments) with mod queue
- User suspension/ban, media takedown with reason logging
- Audit log of admin actions

---

## Phase 5 — Organization & Discovery

- Categories (admin-managed) + free-form tags (user)
- Playlists: public/unlisted/private, collaborative flag (stretch)
- Channels (one per user, or multi-channel per account — decide early, schema impact)
- Full-text search (Postgres FTS to start; Meilisearch/Elasticsearch when it hurts) across titles, descriptions, tags, channel names, captions text
- Related media: tag/category similarity + same-channel fallback
- Trending/popular algorithms: view-velocity windows (day/week/month)
- Subscriptions + subscription feed
- RSS/Atom feeds per channel/category
- Sitemap generation, per-page OpenGraph/Twitter cards, schema.org VideoObject markup

---

## Phase 6 — Engagement

- Comments: threaded (1-level replies is enough), edit/delete, markdown-lite, timestamps auto-link to player seek
- Comment moderation: per-video disable, hold-for-review, blocked-words list
- Likes/dislikes (dislike count visibility configurable)
- View counting with debounce/dedupe rules (e.g., 30s watched or 50% for shorts, IP+session window)
- Share: copy link at timestamp, embed code snippet
- Notifications: new subscription uploads, replies to comments, mentions; in-app + optional email digest
- Watch history + "continue watching" row

---

## Phase 7 — Admin & Operations

- Admin dashboard: totals (media, users, storage, bandwidth), encode queue health, failed jobs, recent signups
- Site configuration UI: branding (logo, name, colors), registration mode, default visibility, encode profiles, feature flags (comments on/off, downloads on/off, etc.)
- Per-video and per-channel analytics: views over time, watch time, traffic sources, quality distribution
- Bulk media management: re-encode, change visibility, transfer ownership, delete
- Storage management: orphan cleanup, original-file purge policy
- Backup story: DB dump + media manifest; documented restore path
- Prometheus metrics endpoint + healthchecks
- Structured logging

---

## Phase 8 — API & Extensibility

- REST API covering everything the frontend does (frontend should be an API consumer — dogfood it)
- Token auth (per-user API keys) + OAuth2 for third-party apps
- Webhooks: `media.published`, `media.encoded`, `comment.created`, `user.registered`
- Whisper integration for auto-captions (local model or API), queued as an encode-pipeline job
- Import tools: yt-dlp-based URL import, bulk import from directory
- Plugin/theming hooks (even just CSS overrides + template slots at first)

---

## Suggested Stack (opinionated, self-host friendly)

| Layer | Pick | Why |
| --- | --- | --- |
| Backend | Django + DRF **or** Node (NestJS) | MediaCMS itself is Django; batteries included, admin for free |
| Jobs | Celery + Redis / BullMQ | Encode queue is the heart of the system |
| DB | PostgreSQL | FTS, JSONB, boring and correct |
| Frontend | React or Vue SPA (or HTMX if you want to stay lean) | YouTube-like UI = heavy client interactivity |
| Player | video.js + hls.js (or Vidstack) | Same base MediaCMS uses; plugin ecosystem |
| Media | FFmpeg + NVENC | You already have the GPU for it |
| Serving | nginx for segments/static, app behind it | Never stream through the app server |
| Deploy | Docker Compose: web, worker, db, redis, nginx | Fits an Unraid stack cleanly |

---

## Build Order Reality Check

1. Upload → encode → HLS playback of a single video (vertical slice, no auth)
2. Auth + media CRUD + visibility levels
3. Watch page + home grid + search
4. Channels, subscriptions, playlists
5. Comments, likes, notifications
6. RBAC, moderation, admin dashboard
7. Analytics, API polish, captions/chapters, importers

The encode pipeline and player are 60% of the real engineering. Everything in Phases 3–6 is standard CRUD wearing a YouTube costume.
