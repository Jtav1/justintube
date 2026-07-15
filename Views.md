# Front-end Features

## Login screen

- Auth (SSO optional?)
  - RBAC — Admin / Moderator / Uploader / View only (allow liking, commenting, etc) / Locked
  - User based with email collection and verification. Can't be uploader without verified email
  - SSO link to user accounts. Register acct, link to SSO acct. Allow logins with both.
- Login section: username / password / SSO

## All Pages

- Top bar
  - Sidebar expansion button
  - Search bar
    - Search suggestions based on title, description, username, tags
  - Upload button
  - Notification system
    - Notifications for my video interactions or subscribed channel uploads
    - Notifications tray
    - Email notification option
  - User button
- Left side panel with filters (on all pages)
  - Home
  - Featured
  - Newest
  - Tags
  - My Subscriptions
  - My Media
  - My Playlists
  - CAST Playlist
    - Create or join shared space
      - Creation of shared space provides key or password to join shared space
    - Add videos to shared space playlist
    - Play / pause / forward / backward controls and scrub bar
    - List of users in the shared space
    - Shared space playlist listing
    - Browser cast option
    - Separate page for just the shared space video display, for casting entire tab
  - History
  - Liked
  - About / Contact
  - Rules
  - Admin
- Unified video thumbnail view with time / title / author / views / date

## Home page

- Featured video carousel at top
- All videos
  - Don't show private inaccessible videos
  - Don't show unlisted videos
  - Don't show hidden videos
  - Unified video thumbnails
  - Paginated? Infinite scroll / lazy loading?
  - Select sort order: Newest first? Recommended? Liked?

## Search screen

- Results, sorted by relevance
- Unified video thumbnails

## Video screen

- Video player
- Video quality
- Details section
  - Uploader, date, views
- Like / Dislike / Follow section
  - Like / Dislike button (++/--??)
  - Subscribe button (receive notification on new video by user)
- (If my video or admin) Edit / Delete buttons
- (If moderator) De-list video

## User settings

- Show username
- Display name
- Email
- Password
- SSO link
- Account metadata
  - Creation date
  - Videos uploaded
  - Role
  - Like history
    - My likes
    - Others liking my videos
  - Subscriptions list
  - Subscribers #
    - Subscribers list

## User channel

- All videos
  - Unified thumbnail
  - Sortable by date asc/desc, likes, views, alpha
- (Mine / admin) Edit / Delete buttons with each thumbnail
- (If admin / moderator) Ban user

## Upload / Edit page

- Select file (upload mode only)
  - yt-dlp integration: option to paste a link to attempt to clone video
- Name
- Description
- Tags
- Add to playlists
- Visibility
  - Public
  - Private (grant access by username)
  - Hidden (no public screens, yes playlists)
  - Unlisted (only shows up at direct link)
- Admin-only options
  - Set featured
  - Force transcode

## Admin functions

- View users
  - All attributes
  - Role assignment
- Transcode profiles

## API Docs

- Scalar docs

---

# Additional backend-only features

- On upload, transcode video to smaller formats (480p, 720p) if resolution is higher
  - Should use ffmpeg, with configurable HW accel, and profiles stored in table
- Store transcoded versions of videos with original
