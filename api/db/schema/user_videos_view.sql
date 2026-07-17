-- ============================================================================
-- USER_VIDEOS (view)
--
-- Lists each owning user_id alongside the videos they own. It reads from
-- ORIGINAL_UPLOADS and LEFT JOINs VIDEO_METADATA so title/visibility/view_count
-- are included when present but rows still appear before metadata is created.
--
-- This is the MySQL definition (CREATE OR REPLACE VIEW). The SQLite runtime uses
-- CREATE VIEW IF NOT EXISTS since SQLite has no CREATE OR REPLACE VIEW. Runtime
-- DDL lives in `api/lib/schema.mysql.js` and `api/lib/schema.sqlite.js` and MUST
-- be kept in sync with this file.
-- ============================================================================

CREATE OR REPLACE VIEW USER_VIDEOS AS
SELECT
  ou.user_id           AS user_id,
  ou.id                AS video_id,
  ou.uuid_name         AS uuid_name,
  ou.original_filename AS original_filename,
  ou.status            AS status,
  ou.resolution        AS resolution,
  ou.uploaded_at       AS uploaded_at,
  vm.title             AS title,
  vm.visibility        AS visibility,
  vm.view_count        AS view_count,
  vm.comments_enabled  AS comments_enabled
FROM ORIGINAL_UPLOADS ou
LEFT JOIN VIDEO_METADATA vm ON vm.original_upload_id = ou.id;
