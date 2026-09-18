import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedUpload,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";

/**
 * Seeds a user with the given role name and an API key for Bearer auth,
 * mirroring the identical helper in tests/http/cast.test.js.
 *
 * @param {string} roleName Role name (`admin`, `viewer`, `moderator`, …).
 * @param {string} rawKey Plaintext API key for Authorization headers.
 * @param {object} [overrides] Extra `seedUser` overrides.
 * @returns {Promise<{id: number} & Record<string, unknown>>} Seeded user record.
 */
async function seedUserWithRoleAndKey(roleName, rawKey, overrides = {}) {
  const role = await Role.findOne({ where: { name: roleName } });
  const user = await seedUser({
    roleId: role?.id ?? null,
    emailVerified: true,
    ...overrides,
  });
  await seedUserApiKey(user.id, rawKey);
  return user;
}

/**
 * Seeds a viewable ORIGINAL_UPLOADS + VIDEO_METADATA pair.
 *
 * @param {object} [metadataOverrides] Overrides passed to seedMetadata.
 * @returns {Promise<{id: number} & Record<string, unknown>>} The seeded upload.
 */
async function seedVideo(metadataOverrides = {}) {
  const upload = await seedUpload();
  await seedMetadata(upload.id, metadataOverrides);
  return upload;
}

/**
 * HTTP contract tests for the admin-only CAST management surface
 * (routes/admin-cast.js): listing every active session and ending any of them
 * regardless of ownership.
 */
describe("Admin CAST endpoints (routes/admin-cast.js)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  describe("GET /admin/cast/sessions (adminListCastSessions)", () => {
    test("401s without authentication", async () => {
      const res = await client.get("/api/v1/admin/cast/sessions");
      expect(res.status).toBe(401);
    });

    test("403s for a signed-in non-admin", async () => {
      await seedUserWithRoleAndKey("viewer", "admin-cast-list-1");

      const res = await client
        .get("/api/v1/admin/cast/sessions")
        .set("Authorization", "Bearer admin-cast-list-1");

      expect(res.status).toBe(403);
      expect(res.body.error).toBe("forbidden");
    });

    test("lists active sessions owned by other users, with owner and member count", async () => {
      const owner = await seedUserWithRoleAndKey("viewer", "admin-cast-list-2");
      await seedUserWithRoleAndKey("admin", "admin-cast-list-2-admin");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer admin-cast-list-2")
        .send({ sourceType: "empty" });
      expect(createRes.status).toBe(201);

      const res = await client
        .get("/api/v1/admin/cast/sessions")
        .set("Authorization", "Bearer admin-cast-list-2-admin");

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items).toHaveLength(1);
      const [item] = res.body.items;
      expect(item.id).toBe(createRes.body.session.id);
      expect(item.code).toBe(createRes.body.session.code);
      expect(item.status).toBe("active");
      expect(item.owner).toMatchObject({ userId: owner.id, username: owner.username });
      expect(item.memberCount).toBe(1);
      expect(item.nowPlayingTitle).toBeNull();
      expect(res.body).toMatchObject({ limit: expect.any(Number), offset: 0 });
    });

    test("reports the now-playing title for a session started from a video", async () => {
      await seedUserWithRoleAndKey("viewer", "admin-cast-list-3");
      await seedUserWithRoleAndKey("admin", "admin-cast-list-3-admin");
      const upload = await seedVideo({ title: "Now Playing Clip" });
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer admin-cast-list-3")
        .send({ sourceType: "video", videoId: String(upload.id) });
      expect(createRes.status).toBe(201);

      const res = await client
        .get("/api/v1/admin/cast/sessions")
        .set("Authorization", "Bearer admin-cast-list-3-admin");

      expect(res.status).toBe(200);
      expect(res.body.items[0].nowPlayingTitle).toBe("Now Playing Clip");
    });

    test("omits ended sessions", async () => {
      await seedUserWithRoleAndKey("viewer", "admin-cast-list-4");
      await seedUserWithRoleAndKey("admin", "admin-cast-list-4-admin");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer admin-cast-list-4")
        .send({ sourceType: "empty" });
      await client
        .post(`/api/v1/cast/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer admin-cast-list-4");

      const res = await client
        .get("/api/v1/admin/cast/sessions")
        .set("Authorization", "Bearer admin-cast-list-4-admin");

      expect(res.status).toBe(200);
      expect(res.body.total).toBe(0);
      expect(res.body.items).toEqual([]);
    });

    test("400s on an invalid limit", async () => {
      await seedUserWithRoleAndKey("admin", "admin-cast-list-5");

      const res = await client
        .get("/api/v1/admin/cast/sessions?limit=0")
        .set("Authorization", "Bearer admin-cast-list-5");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_query");
    });
  });

  describe("POST /admin/cast/sessions/:id/end (adminEndCastSession)", () => {
    test("an admin ends a session owned by someone else", async () => {
      await seedUserWithRoleAndKey("viewer", "admin-cast-end-1");
      await seedUserWithRoleAndKey("admin", "admin-cast-end-1-admin");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer admin-cast-end-1")
        .send({ sourceType: "empty" });

      const endRes = await client
        .post(`/api/v1/admin/cast/sessions/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer admin-cast-end-1-admin");

      expect(endRes.status).toBe(204);
      expect(endRes.body).toEqual({});

      const getRes = await client
        .get(`/api/v1/cast/${createRes.body.session.id}`)
        .set("Authorization", "Bearer admin-cast-end-1");
      expect(getRes.body.session.status).toBe("ended");
    });

    test("403s for a signed-in non-admin", async () => {
      await seedUserWithRoleAndKey("viewer", "admin-cast-end-2");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer admin-cast-end-2")
        .send({ sourceType: "empty" });

      const res = await client
        .post(`/api/v1/admin/cast/sessions/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer admin-cast-end-2");

      expect(res.status).toBe(403);
    });

    test("404s for an unknown session", async () => {
      await seedUserWithRoleAndKey("admin", "admin-cast-end-3");

      const res = await client
        .post("/api/v1/admin/cast/sessions/999999/end")
        .set("Authorization", "Bearer admin-cast-end-3");

      expect(res.status).toBe(404);
      expect(res.body.error).toBe("not_found");
    });

    test("400s on a non-numeric id", async () => {
      await seedUserWithRoleAndKey("admin", "admin-cast-end-4");

      const res = await client
        .post("/api/v1/admin/cast/sessions/abc/end")
        .set("Authorization", "Bearer admin-cast-end-4");

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("invalid_id");
    });

    test("409s ending an already-ended session", async () => {
      await seedUserWithRoleAndKey("viewer", "admin-cast-end-5");
      await seedUserWithRoleAndKey("admin", "admin-cast-end-5-admin");
      const createRes = await client
        .post("/api/v1/cast")
        .set("Authorization", "Bearer admin-cast-end-5")
        .send({ sourceType: "empty" });
      await client
        .post(`/api/v1/admin/cast/sessions/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer admin-cast-end-5-admin");

      const res = await client
        .post(`/api/v1/admin/cast/sessions/${createRes.body.session.id}/end`)
        .set("Authorization", "Bearer admin-cast-end-5-admin");

      expect(res.status).toBe(409);
      expect(res.body.error).toBe("session_ended");
    });
  });
});
