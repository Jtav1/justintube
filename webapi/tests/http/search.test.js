import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import { resetBasicIndexForTests, syncVideoIndex } from "../../lib/search.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedUpload,
  seedUser,
  setupSchema,
} from "../helpers/db.js";

/**
 * HTTP contract tests for GET /search and GET /search/suggest. Covers the
 * default (in-process basic) backend end-to-end over HTTP, plus the
 * degraded-mode response when advanced search is enabled but Meilisearch is
 * unreachable. The basic backend's own eligibility/filter/sort logic is
 * covered in more depth in tests/db/basic-search.test.js; the Meilisearch
 * eligibility logic is covered in tests/db/search.test.js against a mocked
 * client.
 */
describe("Search endpoints (GET /search, GET /search/suggest)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    // resetTables() wipes rows directly, bypassing the sync hooks that would
    // otherwise keep the default backend's in-process index consistent.
    await resetTables();
    resetBasicIndexForTests();
  });

  describe("when ENABLE_ADVANCED_SEARCH is unset (default backend)", () => {
    test("GET /search finds a seeded public video by title", async () => {
      const user = await seedUser({ username: "alice" });
      const upload = await seedUpload({ status: "ready", userId: user.id });
      await seedMetadata(upload.id, { title: "Cats of the Internet", visibility: "public" });
      // No route creates VIDEO_METADATA outside test fixtures yet, so sync
      // directly — this is the same pattern tests/db/search.test.js uses.
      await syncVideoIndex(upload.id);

      const res = await client.get("/api/v1/search?q=cats");

      expect(res.status).toBe(200);
      expect(res.body.items.map((item) => item.id)).toContain(upload.id);
    });

    test("GET /search returns description: null for a video with no description, matching other video routes", async () => {
      const upload = await seedUpload({ status: "ready" });
      await seedMetadata(upload.id, {
        title: "No Description Here",
        description: null,
        visibility: "public",
      });
      await syncVideoIndex(upload.id);

      const res = await client.get("/api/v1/search?q=No+Description");

      expect(res.status).toBe(200);
      const hit = res.body.items.find((item) => item.id === upload.id);
      expect(hit).toBeDefined();
      expect(hit.description).toBeNull();
    });

    test("GET /search/suggest finds a seeded public video by title prefix", async () => {
      const upload = await seedUpload({ status: "ready" });
      await seedMetadata(upload.id, { title: "Suggestible Video", visibility: "public" });
      await syncVideoIndex(upload.id);

      const res = await client.get("/api/v1/search/suggest?q=Sugg");

      expect(res.status).toBe(200);
      expect(res.body.items.map((item) => item.id)).toContain(upload.id);
    });

    test("GET /search omits a private video from results", async () => {
      const upload = await seedUpload({ status: "ready" });
      await seedMetadata(upload.id, { title: "Secret Clip", visibility: "private" });
      await syncVideoIndex(upload.id);

      const res = await client.get("/api/v1/search?q=Secret");

      expect(res.status).toBe(200);
      expect(res.body.items.map((item) => item.id)).not.toContain(upload.id);
    });
  });

  describe("when ENABLE_ADVANCED_SEARCH=true but Meilisearch is unreachable", () => {
    beforeAll(() => {
      process.env.ENABLE_ADVANCED_SEARCH = "true";
      // Loopback + a port nothing listens on: fails fast (ECONNREFUSED)
      // instead of hanging on a DNS lookup.
      process.env.MEILI_HOST = "http://127.0.0.1:1";
    });

    afterAll(() => {
      delete process.env.ENABLE_ADVANCED_SEARCH;
      delete process.env.MEILI_HOST;
    });

    test("GET /search returns 503 search_unavailable", async () => {
      const res = await client.get("/api/v1/search?q=test");
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: "search_unavailable" });
    });

    test("GET /search/suggest returns 503 search_unavailable", async () => {
      const res = await client.get("/api/v1/search/suggest?q=test");
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({ error: "search_unavailable" });
    });

    test("GET /search rejects an invalid sort value with 400 before contacting the backend", async () => {
      const res = await client.get("/api/v1/search?sort=bogus");
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: "invalid_query" });
    });
  });
});
