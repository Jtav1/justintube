import { afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { resetTables, setupSchema } from "../helpers/db.js";

describe("ENABLE_CAST gate", () => {
  beforeAll(setupSchema);
  afterEach(async () => {
    delete process.env.ENABLE_CAST;
    await resetTables();
  });

  describe("GET /api/v1/config", () => {
    it("reports castEnabled: true when ENABLE_CAST is unset (defaults on)", async () => {
      delete process.env.ENABLE_CAST;
      const res = await createTestClient().get("/api/v1/config");
      expect(res.status).toBe(200);
      expect(res.body.castEnabled).toBe(true);
    });

    it("reports castEnabled: false when ENABLE_CAST=false", async () => {
      process.env.ENABLE_CAST = "false";
      const res = await createTestClient().get("/api/v1/config");
      expect(res.status).toBe(200);
      expect(res.body.castEnabled).toBe(false);
    });
  });

  describe("when ENABLE_CAST=false", () => {
    it("returns 404 for the cast routes", async () => {
      process.env.ENABLE_CAST = "false";
      const client = createTestClient();
      const res = await client.get("/api/v1/cast/1");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });
});
