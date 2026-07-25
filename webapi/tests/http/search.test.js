import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { resetTables, setupSchema } from "../helpers/db.js";

/**
 * HTTP contract tests for GET /search and GET /search/suggest. Exercises the
 * two degraded-mode responses (disabled by config vs. backend unreachable)
 * without needing a live Meilisearch instance in CI. The happy-path
 * upsert/eligibility behavior is covered in tests/db/search.test.js against a
 * mocked Meilisearch client.
 */
describe("Search endpoints (GET /search, GET /search/suggest)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("when ENABLE_ADVANCED_SEARCH is unset (default)", () => {
    test("GET /search returns 403 search_disabled", async () => {
      const res = await client.get("/api/v1/search?q=test");
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "search_disabled" });
    });

    test("GET /search/suggest returns 403 search_disabled", async () => {
      const res = await client.get("/api/v1/search/suggest?q=test");
      expect(res.status).toBe(403);
      expect(res.body).toMatchObject({ error: "search_disabled" });
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
