import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { resetTables, seedStaticPage, setupSchema } from "../helpers/db.js";

describe("static pages routes", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("GET /api/v1/pages/about", () => {
    test("returns the about page case-insensitively, no auth required", async () => {
      await seedStaticPage({ description: "About", contents: "<p>About us.</p>" });

      const client = createTestClient();
      const res = await client.get("/api/v1/pages/about");
      expect(res.status).toBe(200);
      expect(res.body.contents).toBe("<p>About us.</p>");
      expect(res.body.description).toBe("About");
    });

    test("returns 404 when no about page is configured", async () => {
      const client = createTestClient();
      const res = await client.get("/api/v1/pages/about");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });

  describe("GET /api/v1/pages/rules", () => {
    test("returns the rules page case-insensitively, no auth required", async () => {
      await seedStaticPage({ description: "RULES", contents: "<p>Be nice.</p>" });

      const client = createTestClient();
      const res = await client.get("/api/v1/pages/rules");
      expect(res.status).toBe(200);
      expect(res.body.contents).toBe("<p>Be nice.</p>");
      expect(res.body.description).toBe("RULES");
    });

    test("returns 404 when no rules page is configured", async () => {
      const client = createTestClient();
      const res = await client.get("/api/v1/pages/rules");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });
});
