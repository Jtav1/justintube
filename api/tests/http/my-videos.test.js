import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";

/**
 * HTTP contract tests for `GET /me/videos`, which lists the current user's
 * uploads via the USER_VIDEOS view (ORIGINAL_UPLOADS LEFT JOIN VIDEO_METADATA).
 * These are RED / TDD specs: the route is currently a 501 stub.
 */
describe("GET /me/videos (USER_VIDEOS view)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("returns 200 and lists uploads with metadata when present", async () => {
    const upload = await seedUpload({ userId: 1, originalFilename: "mine.mp4" });
    await seedMetadata(upload.id, { title: "My titled clip" });

    const res = await client.get("/api/v1/me/videos");

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.items)).toBe(true);
    const titles = res.body.items.map((item) => item.title);
    expect(titles).toContain("My titled clip");
  });

  test("returns 200 and still lists an upload that has no metadata yet", async () => {
    await seedUpload({ userId: 1, originalFilename: "raw-only.mp4" });

    const res = await client.get("/api/v1/me/videos");

    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThanOrEqual(1);
  });
});
