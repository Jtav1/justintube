import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedFileVersion,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";

/**
 * HTTP contract tests for the transcode endpoints backed by FILE_VERSIONS.
 * These are RED / TDD specs: the routes are currently 501 stubs, so they define
 * the intended behavior for a future implementation.
 */
describe("Transcode endpoints (FILE_VERSIONS)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("GET /videos/{id}/transcode (getVideoTranscode)", () => {
    test("returns 200 TranscodeJob reporting the available variants", async () => {
      const upload = await seedUpload();
      await seedFileVersion(upload.id, {
        resolution: "480p",
        transcodeProfileId: 1,
      });
      await seedFileVersion(upload.id, {
        resolution: "720p",
        transcodeProfileId: 2,
      });

      const res = await client.get(`/api/v1/videos/${upload.id}/transcode`);

      expect(res.status).toBe(200);
      expect(res.body.videoId).toBeDefined();
      expect(["queued", "processing", "success", "failed"]).toContain(
        res.body.status,
      );
      expect(res.body.variants).toEqual(
        expect.arrayContaining(["480p", "720p"]),
      );
    });

    test("returns 404 for an unknown video id", async () => {
      const res = await client.get("/api/v1/videos/999999/transcode");

      expect(res.status).toBe(404);
    });
  });

  describe("POST /videos/{id}/transcode (forceVideoTranscode)", () => {
    test("enqueues a re-transcode and returns 202 TranscodeJob", async () => {
      const upload = await seedUpload();

      const res = await client.post(`/api/v1/videos/${upload.id}/transcode`);

      expect(res.status).toBe(202);
      expect(res.body.videoId).toBeDefined();
      expect(["queued", "processing", "success", "failed"]).toContain(
        res.body.status,
      );
    });
  });
});
