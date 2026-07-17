import { execute } from "../../lib/db.js";
import {
  queryRows,
  resetTables,
  seedFileVersion,
  seedMetadata,
  seedPlaylist,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";

/**
 * Lower-level database tests exercising the SQLite schema directly (no HTTP).
 * These are GREEN: they assert the schema created by `ensureSchema` behaves as
 * documented (existence, defaults, CHECK/UNIQUE constraints, cascades, view).
 */
describe("Video-upload schema (SQLite)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("object existence", () => {
    test("creates all five tables and the USER_VIDEOS view", async () => {
      const rows = await queryRows(
        `SELECT name, type FROM sqlite_master
          WHERE name IN (
            'ORIGINAL_UPLOADS','VIDEO_METADATA','FILE_VERSIONS',
            'USER_PLAYLISTS','PLAYLIST_ITEMS','USER_VIDEOS'
          )`,
      );
      const byName = Object.fromEntries(rows.map((r) => [r.name, r.type]));

      expect(byName.ORIGINAL_UPLOADS).toBe("table");
      expect(byName.VIDEO_METADATA).toBe("table");
      expect(byName.FILE_VERSIONS).toBe("table");
      expect(byName.USER_PLAYLISTS).toBe("table");
      expect(byName.PLAYLIST_ITEMS).toBe("table");
      expect(byName.USER_VIDEOS).toBe("view");
    });
  });

  describe("column defaults", () => {
    test("ORIGINAL_UPLOADS.status defaults to 'uploaded'", async () => {
      const result = await execute(
        `INSERT INTO ORIGINAL_UPLOADS
           (original_filename, uuid_name, file_extension, storage_path)
         VALUES ('a.mp4', 'uuid-defaults-1', 'mp4', 'uuid-defaults-1.mp4')`,
      );
      const rows = await queryRows(
        "SELECT * FROM ORIGINAL_UPLOADS WHERE id = :id",
        { id: result.insertId },
      );
      expect(rows[0].status).toBe("uploaded");
    });

    test("VIDEO_METADATA has visibility/view_count/comments_enabled defaults", async () => {
      const upload = await seedUpload();
      const result = await execute(
        `INSERT INTO VIDEO_METADATA (original_upload_id, title)
         VALUES (:id, 'defaults check')`,
        { id: upload.id },
      );
      const rows = await queryRows(
        "SELECT * FROM VIDEO_METADATA WHERE id = :id",
        { id: result.insertId },
      );
      expect(rows[0].visibility).toBe("private");
      expect(rows[0].view_count).toBe(0);
      expect(rows[0].comments_enabled).toBe(1);
    });
  });

  describe("CHECK constraints", () => {
    test("rejects an invalid resolution on ORIGINAL_UPLOADS", async () => {
      await expect(
        seedUpload({ resolution: "9001p" }),
      ).rejects.toThrow();
    });

    test("rejects an invalid resolution on FILE_VERSIONS", async () => {
      const upload = await seedUpload();
      await expect(
        seedFileVersion(upload.id, { resolution: "9001p" }),
      ).rejects.toThrow();
    });

    test("rejects an invalid visibility on VIDEO_METADATA", async () => {
      const upload = await seedUpload();
      await expect(
        seedMetadata(upload.id, { visibility: "secret" }),
      ).rejects.toThrow();
    });

    test("rejects an invalid visibility on USER_PLAYLISTS", async () => {
      await expect(
        seedPlaylist({ visibility: "secret" }),
      ).rejects.toThrow();
    });
  });

  describe("UNIQUE constraints", () => {
    test("ORIGINAL_UPLOADS.uuid_name is unique", async () => {
      await seedUpload({ uuidName: "dupe-uuid" });
      await expect(seedUpload({ uuidName: "dupe-uuid" })).rejects.toThrow();
    });

    test("VIDEO_METADATA allows only one row per upload", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id);
      await expect(seedMetadata(upload.id)).rejects.toThrow();
    });

    test("FILE_VERSIONS is unique per (upload, transcode profile)", async () => {
      const upload = await seedUpload();
      await seedFileVersion(upload.id, { transcodeProfileId: 7 });
      await expect(
        seedFileVersion(upload.id, { transcodeProfileId: 7 }),
      ).rejects.toThrow();
    });

    test("PLAYLIST_ITEMS is unique per (playlist, upload)", async () => {
      const playlist = await seedPlaylist();
      const upload = await seedUpload();
      await execute(
        `INSERT INTO PLAYLIST_ITEMS (playlist_id, original_upload_id)
         VALUES (:playlistId, :uploadId)`,
        { playlistId: playlist.id, uploadId: upload.id },
      );
      await expect(
        execute(
          `INSERT INTO PLAYLIST_ITEMS (playlist_id, original_upload_id)
           VALUES (:playlistId, :uploadId)`,
          { playlistId: playlist.id, uploadId: upload.id },
        ),
      ).rejects.toThrow();
    });
  });

  describe("cascade deletes", () => {
    test("deleting an upload cascades to metadata, file versions and playlist items", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id);
      await seedFileVersion(upload.id);
      const playlist = await seedPlaylist();
      await execute(
        `INSERT INTO PLAYLIST_ITEMS (playlist_id, original_upload_id)
         VALUES (:playlistId, :uploadId)`,
        { playlistId: playlist.id, uploadId: upload.id },
      );

      await execute("DELETE FROM ORIGINAL_UPLOADS WHERE id = :id", {
        id: upload.id,
      });

      expect(
        await queryRows(
          "SELECT * FROM VIDEO_METADATA WHERE original_upload_id = :id",
          { id: upload.id },
        ),
      ).toHaveLength(0);
      expect(
        await queryRows(
          "SELECT * FROM FILE_VERSIONS WHERE original_upload_id = :id",
          { id: upload.id },
        ),
      ).toHaveLength(0);
      expect(
        await queryRows(
          "SELECT * FROM PLAYLIST_ITEMS WHERE original_upload_id = :id",
          { id: upload.id },
        ),
      ).toHaveLength(0);
    });

    test("deleting a playlist cascades to its items", async () => {
      const playlist = await seedPlaylist();
      const upload = await seedUpload();
      await execute(
        `INSERT INTO PLAYLIST_ITEMS (playlist_id, original_upload_id)
         VALUES (:playlistId, :uploadId)`,
        { playlistId: playlist.id, uploadId: upload.id },
      );

      await execute("DELETE FROM USER_PLAYLISTS WHERE id = :id", {
        id: playlist.id,
      });

      expect(
        await queryRows(
          "SELECT * FROM PLAYLIST_ITEMS WHERE playlist_id = :id",
          { id: playlist.id },
        ),
      ).toHaveLength(0);
    });
  });

  describe("USER_VIDEOS view", () => {
    test("surfaces an upload even when it has no metadata (LEFT JOIN)", async () => {
      const upload = await seedUpload({ userId: 5 });

      const rows = await queryRows(
        "SELECT * FROM USER_VIDEOS WHERE video_id = :id",
        { id: upload.id },
      );

      expect(rows).toHaveLength(1);
      expect(rows[0].title).toBeNull();
      expect(rows[0].user_id).toBe(5);
    });

    test("includes metadata columns when present", async () => {
      const upload = await seedUpload({ userId: 5 });
      await seedMetadata(upload.id, {
        title: "Joined title",
        visibility: "public",
        viewCount: 12,
      });

      const rows = await queryRows(
        "SELECT * FROM USER_VIDEOS WHERE video_id = :id",
        { id: upload.id },
      );

      expect(rows[0].title).toBe("Joined title");
      expect(rows[0].visibility).toBe("public");
      expect(rows[0].view_count).toBe(12);
    });
  });
});
