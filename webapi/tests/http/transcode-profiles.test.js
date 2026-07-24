import {
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
} from "@jest/globals";
import { Role, TranscodeProfile } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedTranscodeProfile,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";

/**
 * Seeds a user with the given role name and an API key for Bearer auth.
 *
 * @param {string} roleName Role name (`admin`, `viewer`, …).
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
 * Minimal valid create payload for a transcode profile.
 *
 * @param {object} [overrides] Field overrides.
 * @returns {Record<string, unknown>} Create body.
 */
function validCreateBody(overrides = {}) {
  return {
    resolutionName: "720p",
    outputHeight: 720,
    outputWidth: 1280,
    outputContainer: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    description: "default 720p",
    ...overrides,
  };
}

describe("admin transcode profiles", () => {
  beforeAll(async () => {
    await setupSchema();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects unauthenticated list", async () => {
    const client = createTestClient();
    const res = await client.get("/api/v1/admin/transcode-profiles");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects non-admin create", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_viewer_tp_create";
    await seedUserWithRoleAndKey("viewer", rawKey);

    const res = await client
      .post("/api/v1/admin/transcode-profiles")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validCreateBody());

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("lists, creates, updates, and deletes profiles", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_tp_crud";
    const admin = await seedUserWithRoleAndKey("admin", rawKey);

    await seedTranscodeProfile({
      resolutionName: "480p",
      outputHeight: 480,
      outputWidth: 854,
      description: "seeded",
    });

    const list = await client
      .get("/api/v1/admin/transcode-profiles")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      resolutionName: "480p",
      outputHeight: 480,
      outputWidth: 854,
      description: "seeded",
    });
    expect(list.body.items[0]).toHaveProperty("createdAt");
    expect(list.body.items[0]).toHaveProperty("updatedAt");

    const created = await client
      .post("/api/v1/admin/transcode-profiles")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validCreateBody({ description: "created by admin" }));

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      resolutionName: "720p",
      outputHeight: 720,
      outputWidth: 1280,
      outputContainer: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
      description: "created by admin",
      creatorUserId: admin.id,
    });

    const updated = await client
      .patch(`/api/v1/admin/transcode-profiles/${created.body.id}`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({
        resolutionName: "1080p",
        outputHeight: 1080,
        outputWidth: 1920,
        description: "updated",
      });

    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      id: created.body.id,
      resolutionName: "1080p",
      outputHeight: 1080,
      outputWidth: 1920,
      description: "updated",
      videoCodec: "h264",
    });

    const deleted = await client
      .delete(`/api/v1/admin/transcode-profiles/${created.body.id}`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(deleted.status).toBe(204);
    expect(await TranscodeProfile.findByPk(created.body.id)).toBeNull();

    const listAfter = await client
      .get("/api/v1/admin/transcode-profiles")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(listAfter.status).toBe(200);
    expect(listAfter.body.items).toHaveLength(1);
  });

  test("rejects invalid resolutionName on create", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_tp_bad_res";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .post("/api/v1/admin/transcode-profiles")
      .set("Authorization", `Bearer ${rawKey}`)
      .send(validCreateBody({ resolutionName: "9001p" }));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 404 for unknown profile on update and delete", async () => {
    const client = createTestClient();
    const rawKey = "jt_test_admin_tp_404";
    await seedUserWithRoleAndKey("admin", rawKey);

    const patch = await client
      .patch("/api/v1/admin/transcode-profiles/999999")
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ description: "nope" });
    expect(patch.status).toBe(404);
    expect(patch.body.error).toBe("not_found");

    const del = await client
      .delete("/api/v1/admin/transcode-profiles/999999")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(del.status).toBe(404);
    expect(del.body.error).toBe("not_found");
  });
});
