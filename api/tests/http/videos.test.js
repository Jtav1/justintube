import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedMetadata,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";

/**
 * HTTP contract tests for the video metadata CRUD endpoints backed by
 * VIDEO_METADATA (joined to ORIGINAL_UPLOADS). These are RED / TDD specs: the
 * routes are currently 501 stubs, so they define the intended behavior for a
 * future implementation.
 */
describe("Video metadata endpoints (VIDEO_METADATA + ORIGINAL_UPLOADS)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("GET /videos/{id} (getVideo)", () => {
    test("returns 200 with watch metadata for an existing video", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, {
        title: "Watchable",
        description: "A described clip",
        visibility: "public",
        commentsEnabled: 1,
      });

      const res = await client.get(`/api/v1/videos/${upload.id}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        title: "Watchable",
        description: "A described clip",
        visibility: "public",
        commentsEnabled: true,
      });
    });

    test("returns 404 for an unknown video id", async () => {
      const res = await client.get("/api/v1/videos/999999");

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /videos/{id} (updateVideo)", () => {
    test("updates editable metadata and returns 200 with the new values", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id, {
        title: "Before",
        visibility: "private",
        commentsEnabled: 1,
      });

      const res = await client.patch(`/api/v1/videos/${upload.id}`).send({
        title: "After",
        visibility: "unlisted",
        commentsEnabled: false,
      });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        title: "After",
        visibility: "unlisted",
        commentsEnabled: false,
      });

      const rows = await queryRows(
        "SELECT * FROM VIDEO_METADATA WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(rows[0].title).toBe("After");
      expect(rows[0].visibility).toBe("unlisted");
      expect(rows[0].comments_enabled).toBe(0);
    });
  });

  describe("DELETE /videos/{id} (deleteVideo)", () => {
    test("returns 204 and removes the upload (and its metadata via cascade)", async () => {
      const upload = await seedUpload();
      await seedMetadata(upload.id);

      const res = await client.delete(`/api/v1/videos/${upload.id}`);

      expect(res.status).toBe(204);

      const uploads = await queryRows(
        "SELECT * FROM ORIGINAL_UPLOADS WHERE id = :id",
        { id: upload.id },
      );
      expect(uploads).toHaveLength(0);

      const metadata = await queryRows(
        "SELECT * FROM VIDEO_METADATA WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(metadata).toHaveLength(0);
    });
  });

  describe("GET /videos (listVideos)", () => {
    test("returns 200 VideoList excluding non-public videos for public viewers", async () => {
      const publicUpload = await seedUpload({ originalFilename: "public.mp4" });
      await seedMetadata(publicUpload.id, {
        title: "Public one",
        visibility: "public",
      });
      const privateUpload = await seedUpload({
        originalFilename: "private.mp4",
      });
      await seedMetadata(privateUpload.id, {
        title: "Private one",
        visibility: "private",
      });

      const res = await client.get("/api/v1/videos");

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.items)).toBe(true);
      const titles = res.body.items.map((item) => item.title);
      expect(titles).toContain("Public one");
      expect(titles).not.toContain("Private one");
    });
  });
});
