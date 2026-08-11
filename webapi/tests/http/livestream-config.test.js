import { afterEach, beforeAll, describe, expect, it } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import { resetTables, setupSchema } from "../helpers/db.js";

describe("ENABLE_LIVESTREAM gate", () => {
  beforeAll(setupSchema);
  afterEach(async () => {
    delete process.env.ENABLE_LIVESTREAM;
    await resetTables();
  });

  describe("GET /api/v1/config", () => {
    it("reports livestreamEnabled: true when ENABLE_LIVESTREAM=true", async () => {
      process.env.ENABLE_LIVESTREAM = "true";
      const res = await createTestClient().get("/api/v1/config");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ livestreamEnabled: true });
    });

    it("reports livestreamEnabled: false when ENABLE_LIVESTREAM is unset", async () => {
      delete process.env.ENABLE_LIVESTREAM;
      const res = await createTestClient().get("/api/v1/config");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ livestreamEnabled: false });
    });
  });

  describe("when ENABLE_LIVESTREAM is unset", () => {
    it("returns 404 for public livestream routes", async () => {
      delete process.env.ENABLE_LIVESTREAM;
      const client = createTestClient();
      const res = await client.get("/api/v1/livestreams");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    it("returns 404 for the stream-key routes", async () => {
      delete process.env.ENABLE_LIVESTREAM;
      const client = createTestClient();
      const res = await client.get("/api/v1/me/stream-key");
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    it("returns 404 for the internal livestream callbacks", async () => {
      delete process.env.ENABLE_LIVESTREAM;
      const client = createTestClient();
      const res = await client
        .post("/internal/livestreams/authorize")
        .set("Authorization", `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`)
        .send({ streamKey: "whatever" });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });
  });
});
