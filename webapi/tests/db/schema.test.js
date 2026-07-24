import { execute } from "../../lib/db.js";
import {
  queryRows,
  resetTables,
  seedContentTag,
  seedFeaturedVideo,
  seedFileVersion,
  seedMetadata,
  seedPlaylist,
  seedSsoProvider,
  seedSystemConfig,
  seedTranscodeProfile,
  seedUpload,
  seedUser,
  seedUserIdentity,
  seedVideoLike,
  seedVideoThumbnail,
  setupSchema,
} from "../helpers/db.js";

/**
 * Lower-level database tests exercising the SQLite schema directly (no HTTP).
 * These are GREEN: they assert the schema created by `ensureSchema` behaves as
 * documented (existence, defaults, CHECK/UNIQUE constraints, cascades).
 */
describe("Video-upload schema (SQLite)", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("object existence", () => {
    test("creates all auth and video tables", async () => {
      const rows = await queryRows(
        `SELECT name, type FROM sqlite_master
          WHERE name IN (
            'ROLES','USERS','USER_API_KEYS','EMAIL_VERIFICATION_TOKENS',
            'SSO_PROVIDERS','USER_IDENTITIES',
            'ORIGINAL_UPLOADS','VIDEO_METADATA','VIDEO_THUMBNAIL',
            'TRANSCODE_PROFILES','FILE_VERSIONS',
            'USER_PLAYLISTS','PLAYLIST_ITEMS','VIDEO_LIKES',
            'CONTENT_TAGS','FEATURED_VIDEOS','SYSTEM_CONFIG'
          )`,
      );
      const byName = Object.fromEntries(rows.map((r) => [r.name, r.type]));

      expect(byName.ROLES).toBe("table");
      expect(byName.USERS).toBe("table");
      expect(byName.USER_API_KEYS).toBe("table");
      expect(byName.EMAIL_VERIFICATION_TOKENS).toBe("table");
      expect(byName.SSO_PROVIDERS).toBe("table");
      expect(byName.USER_IDENTITIES).toBe("table");
      expect(byName.ORIGINAL_UPLOADS).toBe("table");
      expect(byName.VIDEO_METADATA).toBe("table");
      expect(byName.VIDEO_THUMBNAIL).toBe("table");
      expect(byName.TRANSCODE_PROFILES).toBe("table");
      expect(byName.FILE_VERSIONS).toBe("table");
      expect(byName.USER_PLAYLISTS).toBe("table");
      expect(byName.PLAYLIST_ITEMS).toBe("table");
      expect(byName.VIDEO_LIKES).toBe("table");
      expect(byName.CONTENT_TAGS).toBe("table");
      expect(byName.FEATURED_VIDEOS).toBe("table");
      expect(byName.SYSTEM_CONFIG).toBe("table");
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

    test("VIDEO_LIKES.created_at defaults to a timestamp", async () => {
      const upload = await seedUpload();
      const user = await seedUser();
      const like = await seedVideoLike(upload.id, {
        userId: user.id,
        likeValue: 1,
      });
      const rows = await queryRows("SELECT * FROM VIDEO_LIKES WHERE id = :id", {
        id: like.id,
      });
      expect(rows[0].like_value).toBe(1);
      expect(rows[0].created_at).toBeTruthy();
    });

    test("CONTENT_TAGS.created_at defaults to a timestamp", async () => {
      const upload = await seedUpload();
      const tag = await seedContentTag(upload.id, { tag: "music" });
      const rows = await queryRows("SELECT * FROM CONTENT_TAGS WHERE id = :id", {
        id: tag.id,
      });
      expect(rows[0].tag).toBe("music");
      expect(rows[0].created_at).toBeTruthy();
    });

    test("VIDEO_THUMBNAIL.created_at defaults to a timestamp", async () => {
      const upload = await seedUpload();
      const thumbnail = await seedVideoThumbnail(upload.id, {
        thumbnailFilename: "thumb.jpg",
      });
      const rows = await queryRows(
        "SELECT * FROM VIDEO_THUMBNAIL WHERE id = :id",
        { id: thumbnail.id },
      );
      expect(rows[0].thumbnail_filename).toBe("thumb.jpg");
      expect(rows[0].created_at).toBeTruthy();
      expect(rows[0].updated_at).toBeTruthy();
    });

    test("TRANSCODE_PROFILES.created_at defaults to a timestamp", async () => {
      const profile = await seedTranscodeProfile({
        outputHeight: 480,
        outputWidth: 854,
      });
      const rows = await queryRows(
        "SELECT * FROM TRANSCODE_PROFILES WHERE id = :id",
        { id: profile.id },
      );
      expect(rows[0].output_height).toBe(480);
      expect(rows[0].output_width).toBe(854);
      expect(rows[0].created_at).toBeTruthy();
      expect(rows[0].updated_at).toBeTruthy();
    });

    test("FEATURED_VIDEOS.created_at defaults to a timestamp", async () => {
      const upload = await seedUpload();
      const featured = await seedFeaturedVideo(upload.id);
      const rows = await queryRows(
        "SELECT * FROM FEATURED_VIDEOS WHERE id = :id",
        { id: featured.id },
      );
      expect(rows[0].created_at).toBeTruthy();
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

    test("rejects a like_value other than 1 or -1 on VIDEO_LIKES", async () => {
      const upload = await seedUpload();
      await expect(
        seedVideoLike(upload.id, { likeValue: 0 }),
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
      const profile = await seedTranscodeProfile();
      await seedFileVersion(upload.id, { transcodeProfileId: profile.id });
      await expect(
        seedFileVersion(upload.id, { transcodeProfileId: profile.id }),
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

    test("VIDEO_LIKES is unique per (user, upload)", async () => {
      const upload = await seedUpload();
      const user = await seedUser();
      await seedVideoLike(upload.id, { userId: user.id });
      await expect(
        seedVideoLike(upload.id, { userId: user.id, likeValue: -1 }),
      ).rejects.toThrow();
    });

    test("CONTENT_TAGS is unique per (upload, tag)", async () => {
      const upload = await seedUpload();
      await seedContentTag(upload.id, { tag: "gaming" });
      await expect(
        seedContentTag(upload.id, { tag: "gaming" }),
      ).rejects.toThrow();
    });

    test("FEATURED_VIDEOS allows an upload to be featured only once", async () => {
      const upload = await seedUpload();
      await seedFeaturedVideo(upload.id);
      await expect(seedFeaturedVideo(upload.id)).rejects.toThrow();
    });

    test("VIDEO_THUMBNAIL allows only one row per upload", async () => {
      const upload = await seedUpload();
      await seedVideoThumbnail(upload.id);
      await expect(seedVideoThumbnail(upload.id)).rejects.toThrow();
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

    test("deleting an upload cascades to likes, tags and featured entries", async () => {
      const upload = await seedUpload();
      const user = await seedUser();
      await seedVideoLike(upload.id, { userId: user.id });
      await seedContentTag(upload.id, { tag: "cascade" });
      await seedFeaturedVideo(upload.id);
      await seedVideoThumbnail(upload.id);

      await execute("DELETE FROM ORIGINAL_UPLOADS WHERE id = :id", {
        id: upload.id,
      });

      expect(
        await queryRows(
          "SELECT * FROM VIDEO_LIKES WHERE original_upload_id = :id",
          { id: upload.id },
        ),
      ).toHaveLength(0);
      expect(
        await queryRows(
          "SELECT * FROM CONTENT_TAGS WHERE original_upload_id = :id",
          { id: upload.id },
        ),
      ).toHaveLength(0);
      expect(
        await queryRows(
          "SELECT * FROM FEATURED_VIDEOS WHERE original_upload_id = :id",
          { id: upload.id },
        ),
      ).toHaveLength(0);
      expect(
        await queryRows(
          "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
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

  describe("ROLES seeding and constraints", () => {
    test("seeds the standard roles on schema creation", async () => {
      const rows = await queryRows(
        "SELECT name FROM ROLES ORDER BY name",
      );
      const names = rows.map((r) => r.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "admin",
          "moderator",
          "uploader",
          "viewer",
          "locked",
        ]),
      );
    });

    test("seeded roles are enabled by default", async () => {
      const rows = await queryRows(
        "SELECT enabled FROM ROLES WHERE name = :name",
        { name: "viewer" },
      );
      expect(rows[0].enabled).toBe(1);
    });

    test("ROLES.name is unique", async () => {
      await expect(
        execute("INSERT INTO ROLES (name) VALUES ('viewer')"),
      ).rejects.toThrow();
    });
  });

  describe("USERS constraints and defaults", () => {
    test("USERS.email_verified defaults to 0 and created_at is set", async () => {
      const user = await seedUser();
      const rows = await queryRows("SELECT * FROM USERS WHERE id = :id", {
        id: user.id,
      });
      expect(rows[0].email_verified).toBe(0);
      expect(rows[0].created_at).toBeTruthy();
    });

    test("new users default to the seeded viewer role", async () => {
      const user = await seedUser();
      const rows = await queryRows(
        `SELECT r.name AS role_name
           FROM USERS u JOIN ROLES r ON r.id = u.role_id
          WHERE u.id = :id`,
        { id: user.id },
      );
      expect(rows[0].role_name).toBe("viewer");
    });

    test("USERS.username is unique", async () => {
      await seedUser({ username: "dupe_user" });
      await expect(seedUser({ username: "dupe_user" })).rejects.toThrow();
    });

    test("USERS.email is unique", async () => {
      await seedUser({ email: "dupe@example.com" });
      await expect(seedUser({ email: "dupe@example.com" })).rejects.toThrow();
    });

    test("rejects a role_id that does not reference a role", async () => {
      await expect(seedUser({ roleId: 999999 })).rejects.toThrow();
    });

    test("deleting a role sets referencing users' role_id to NULL", async () => {
      const role = await execute(
        "INSERT INTO ROLES (name) VALUES ('temp-role')",
      );
      const user = await seedUser({ roleId: role.insertId });

      await execute("DELETE FROM ROLES WHERE id = :id", { id: role.insertId });

      const rows = await queryRows(
        "SELECT role_id FROM USERS WHERE id = :id",
        { id: user.id },
      );
      expect(rows[0].role_id).toBeNull();
    });
  });

  describe("SSO_PROVIDERS constraints and defaults", () => {
    test("SSO_PROVIDERS.enabled defaults to 1", async () => {
      const provider = await seedSsoProvider();
      const rows = await queryRows(
        "SELECT enabled FROM SSO_PROVIDERS WHERE id = :id",
        { id: provider.id },
      );
      expect(rows[0].enabled).toBe(1);
    });

    test("SSO_PROVIDERS.provider_key is unique", async () => {
      await seedSsoProvider({ providerKey: "google" });
      await expect(
        seedSsoProvider({ providerKey: "google" }),
      ).rejects.toThrow();
    });
  });

  describe("USER_IDENTITIES constraints and cascades", () => {
    test("is unique per (provider, provider_user_id)", async () => {
      const provider = await seedSsoProvider();
      const userA = await seedUser();
      const userB = await seedUser();
      await seedUserIdentity(userA.id, provider.id, { providerUserId: "sub-1" });
      await expect(
        seedUserIdentity(userB.id, provider.id, { providerUserId: "sub-1" }),
      ).rejects.toThrow();
    });

    test("is unique per (user, provider)", async () => {
      const provider = await seedSsoProvider();
      const user = await seedUser();
      await seedUserIdentity(user.id, provider.id);
      await expect(
        seedUserIdentity(user.id, provider.id),
      ).rejects.toThrow();
    });

    test("rejects an identity for a non-existent user", async () => {
      const provider = await seedSsoProvider();
      await expect(
        seedUserIdentity(999999, provider.id),
      ).rejects.toThrow();
    });

    test("deleting a user cascades to their identities", async () => {
      const provider = await seedSsoProvider();
      const user = await seedUser();
      await seedUserIdentity(user.id, provider.id);

      await execute("DELETE FROM USERS WHERE id = :id", { id: user.id });

      expect(
        await queryRows(
          "SELECT * FROM USER_IDENTITIES WHERE user_id = :id",
          { id: user.id },
        ),
      ).toHaveLength(0);
    });

    test("deleting a provider cascades to its identities", async () => {
      const provider = await seedSsoProvider();
      const user = await seedUser();
      await seedUserIdentity(user.id, provider.id);

      await execute("DELETE FROM SSO_PROVIDERS WHERE id = :id", {
        id: provider.id,
      });

      expect(
        await queryRows(
          "SELECT * FROM USER_IDENTITIES WHERE provider_id = :id",
          { id: provider.id },
        ),
      ).toHaveLength(0);
    });
  });

  describe("user foreign keys on content tables", () => {
    test("rejects an upload with a non-existent user_id", async () => {
      await expect(seedUpload({ userId: 999999 })).rejects.toThrow();
    });

    test("rejects a playlist with a non-existent user_id", async () => {
      await expect(seedPlaylist({ userId: 999999 })).rejects.toThrow();
    });

    test("rejects a like with a non-existent user_id", async () => {
      const upload = await seedUpload();
      await expect(
        seedVideoLike(upload.id, { userId: 999999 }),
      ).rejects.toThrow();
    });

    test("deleting a user sets their uploads' user_id to NULL", async () => {
      const user = await seedUser();
      const upload = await seedUpload({ userId: user.id });

      await execute("DELETE FROM USERS WHERE id = :id", { id: user.id });

      const rows = await queryRows(
        "SELECT user_id FROM ORIGINAL_UPLOADS WHERE id = :id",
        { id: upload.id },
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].user_id).toBeNull();
    });

    test("deleting a user cascades to their playlists and likes", async () => {
      const user = await seedUser();
      const playlist = await seedPlaylist({ userId: user.id });
      const upload = await seedUpload();
      await seedVideoLike(upload.id, { userId: user.id });

      await execute("DELETE FROM USERS WHERE id = :id", { id: user.id });

      expect(
        await queryRows("SELECT * FROM USER_PLAYLISTS WHERE id = :id", {
          id: playlist.id,
        }),
      ).toHaveLength(0);
      expect(
        await queryRows("SELECT * FROM VIDEO_LIKES WHERE user_id = :id", {
          id: user.id,
        }),
      ).toHaveLength(0);
    });
  });

  describe("SYSTEM_CONFIG constraints", () => {
    test("SYSTEM_CONFIG.name is unique", async () => {
      await seedSystemConfig({ name: "site_title", value: "one" });
      await expect(
        seedSystemConfig({ name: "site_title", value: "two" }),
      ).rejects.toThrow();
    });

    test("SYSTEM_CONFIG stores name and value", async () => {
      const config = await seedSystemConfig({
        name: "max_upload_mb",
        value: "512",
      });
      const rows = await queryRows(
        "SELECT name, value FROM SYSTEM_CONFIG WHERE id = :id",
        { id: config.id },
      );
      expect(rows[0].name).toBe("max_upload_mb");
      expect(rows[0].value).toBe("512");
    });
  });
});
