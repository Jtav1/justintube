# migration-tools

One-off scripts for migrating data into justintube from other platforms. Not part of the
deployed stack — run manually, locally, against a live justintube instance.

## `migrate-user-videos.js` (MediaCMS -> justintube)

Migrates one MediaCMS user's videos/audio into one justintube user's account via justintube's
public API (`POST /videos/upload` -> `POST /videos/:id/thumbnail` -> `PATCH /videos/:id`), so the
normal upload/validation/transcode pipeline runs exactly as it would for a live user upload.

Reads video metadata directly from the MediaCMS Postgres database (read-only) and the original
media files from MediaCMS's `MEDIA_ROOT` on disk; writes into justintube only through its
documented API.

### Field mapping

| MediaCMS (`files_media`) | justintube |
| --- | --- |
| `media_file` | uploaded as the video/audio file |
| `uploaded_thumbnail` (falls back to `thumbnail`) | uploaded as the video thumbnail, if the file exists on disk — otherwise justintube auto-generates one from the video itself, same as a normal upload with no thumbnail attached |
| `title` | `title` (falls back to `"Untitled"`) |
| `description` | `description` |
| `state` (`public`/`unlisted`/`friends`/`private`) | `visibility` (`public`/`unlisted`/`private`/`private`) — MediaCMS's `friends` has no justintube equivalent and maps to the more restrictive `private` |
| `enable_comments` | `commentsEnabled` |
| tags (via `files_media_tags`/`files_tag`) | `tags`, truncated to 50 |
| `add_date` | `createdAt`, when parseable — otherwise left unset (video still migrates, just with a "now" `createdAt`) |

Only `files_media` rows with `media_type` of `video` or `audio` are considered. A row is skipped
(not failed) when its `media_file` doesn't exist under `MEDIACMS_MEDIA_ROOT`.

### Setup

```bash
cd migration-tools
cp .env.example .env   # fill in the values below
npm install
```

| Env var | Purpose |
| --- | --- |
| `JUSTINTUBE_API_BASE_URL` | Full base URL of the justintube public API, no trailing slash. |
| `JUSTINTUBE_API_KEY` | `jt_...` API key belonging to the justintube user videos are imported into. Needs `content_edit` or `full_access` scope; its owning user must have `uploader=true` and a verified email, same as any normal upload. |
| `MEDIACMS_DB_HOST` / `MEDIACMS_DB_PORT` / `MEDIACMS_DB_NAME` / `MEDIACMS_DB_USER` / `MEDIACMS_DB_PASSWORD` | MediaCMS's Postgres connection (read-only credentials recommended). `MEDIACMS_DB_PORT` defaults to `5432`. |
| `MEDIACMS_MEDIA_ROOT` | Local filesystem path mounted to MediaCMS's `MEDIA_ROOT` (a Windows UNC path to a network share also works). |

Justintube has no admin/on-behalf-of upload path — the API key must belong to the exact user
being migrated into. The script verifies this against `--justintube-user-id` before doing
anything else and aborts if they don't match, or if that user isn't an uploader.

### Usage

```bash
npm run migrate:mediacms -- --justintube-user-id <id> --mediacms-user-id <id> [--dry-run] [--retry-from <path>]
```

| Flag | Required | Purpose |
| --- | --- | --- |
| `--justintube-user-id <id>` | yes | The justintube user id the API key must belong to and that videos are uploaded as. |
| `--mediacms-user-id <id>` | yes | The MediaCMS `auth_user.id` whose `files_media` rows to migrate. |
| `--dry-run` | no | Prints what would be migrated (id, title, mapped visibility, tag count) without uploading or writing state. |
| `--retry-from <path>` | no | Re-runs only the MediaCMS video ids listed in a previous failure log (see below) instead of every row for the user. |

### State and failure tracking

Each `--justintube-user-id`/`--mediacms-user-id` pair gets its own progress file at
`state/<justintubeUserId>-<mediacmsUserId>.json`, keyed by MediaCMS video id, tracking each
video's status (`pending` -> `uploaded` -> `thumbnail_set` -> `metadata_set` -> `done`, or
`skipped`/`failed`). The script is safe to re-run: already-`done`/`skipped` videos are skipped on
subsequent runs, and a video that failed partway through resumes from its last completed step
rather than re-uploading.

Failures are also appended to a JSON-Lines log at
`logs/<justintubeUserId>-<mediacmsUserId>-failures.jsonl` (MediaCMS video id, title, failed step,
error message, timestamp), which is pruned as videos succeed. If a run ends with outstanding
failures, the script prints the exact `--retry-from <path>` command to rerun just those videos.

State and log files are gitignored (except `.gitkeep`) — they're per-migration-run artifacts, not
something to commit.
