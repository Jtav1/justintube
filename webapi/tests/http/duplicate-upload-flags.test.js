import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { DuplicateUploadFlag, OriginalUpload, Role } from "../../lib/models/index.js";
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
 * Seeds a user with the given role name and an API key for Bearer auth.
 *
 * @param {string} roleName Role name (`admin`, `moderator`, `viewer`, …).
 * @param {string} rawKey Plaintext API key for Authorization headers.
 * @param {object} [overrides] Extra `seedUser` overrides.
 * @returns {Promise<{id: number} & Record<string, unknown>>} Seeded user record.
 */
async function seedUserWithRoleAndKey(roleName, rawKey, overrides = {}) {
  const role = await Role.findOne({ where: { name: roleName } });
  const user = await seedUser({ roleId: role?.id ?? null, emailVerified: true, ...overrides });
  await seedUserApiKey(user.id, rawKey);
  return user;
}

/**
 * Seeds a pending DuplicateUploadFlag with both sides fully materialized
 * (upload + metadata).
 *
 * @returns {Promise<{ flag: object, newUpload: object, existingUpload: object }>}
 *   Seeded flag and its two upload sides.
 */
async function seedPendingFlag() {
  const newUpload = await seedUpload({ status: "uploaded", contentHash: "sha256:shared" });
  await seedMetadata(newUpload.id, { title: "New upload" });
  const existingUpload = await seedUpload({ status: "uploaded", contentHash: "sha256:shared" });
  await seedMetadata(existingUpload.id, { title: "Existing video" });

  const flag = await DuplicateUploadFlag.create({
    newOriginalUploadId: newUpload.id,
    existingOriginalUploadId: existingUpload.id,
    contentHash: "sha256:shared",
    status: "pending",
  });

  return { flag, newUpload, existingUpload };
}

describe("GET/PATCH /api/v1/admin/duplicate-uploads", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects an unauthenticated request", async () => {
    const res = await client.get("/api/v1/admin/duplicate-uploads");
    expect(res.status).toBe(401);
  });

  test("rejects a non-moderator", async () => {
    const rawKey = "jt_test_dup_flags_viewer";
    await seedUserWithRoleAndKey("viewer", rawKey);

    const res = await client
      .get("/api/v1/admin/duplicate-uploads")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("lists a pending flag with both sides' video-card summaries", async () => {
    const rawKey = "jt_test_dup_flags_list";
    await seedUserWithRoleAndKey("moderator", rawKey);
    const { flag, newUpload, existingUpload } = await seedPendingFlag();

    const res = await client
      .get("/api/v1/admin/duplicate-uploads")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    const item = res.body.items[0];
    expect(item.id).toBe(flag.id);
    expect(item.status).toBe("pending");
    expect(item.newUpload).toMatchObject({ videoId: newUpload.videoId, title: "New upload" });
    expect(item.existingUpload).toMatchObject({ videoId: existingUpload.videoId, title: "Existing video" });
  });

  test("filters by status", async () => {
    const rawKey = "jt_test_dup_flags_filter";
    await seedUserWithRoleAndKey("moderator", rawKey);
    await seedPendingFlag();

    const res = await client
      .get("/api/v1/admin/duplicate-uploads?status=resolved")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(0);
    expect(res.body.total).toBe(0);
  });

  test("gets a single flag by id", async () => {
    const rawKey = "jt_test_dup_flags_get";
    await seedUserWithRoleAndKey("moderator", rawKey);
    const { flag } = await seedPendingFlag();

    const res = await client
      .get(`/api/v1/admin/duplicate-uploads/${flag.id}`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(flag.id);
  });

  test("returns 404 for an unknown flag", async () => {
    const rawKey = "jt_test_dup_flags_404";
    await seedUserWithRoleAndKey("moderator", rawKey);

    const res = await client
      .get("/api/v1/admin/duplicate-uploads/999999")
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("moderate kept_new: leaves both (already-live) uploads untouched and resolves the flag", async () => {
    const rawKey = "jt_test_dup_flags_kept_new";
    const mod = await seedUserWithRoleAndKey("moderator", rawKey);
    const { flag, newUpload } = await seedPendingFlag();

    const res = await client
      .patch(`/api/v1/admin/duplicate-uploads/${flag.id}/moderate`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolution: "kept_new", comment: "not actually a duplicate" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("resolved");
    expect(res.body.resolution).toBe("kept_new");
    expect(res.body.moderatorUserId).toBe(mod.id);
    expect(res.body.moderatorComment).toBe("not actually a duplicate");
    expect(res.body.newUpload).not.toBeNull();

    const reloadedUpload = await OriginalUpload.findByPk(newUpload.id);
    expect(reloadedUpload.status).toBe("uploaded");

    const reloadedFlag = await DuplicateUploadFlag.findByPk(flag.id);
    expect(reloadedFlag.status).toBe("resolved");
    expect(reloadedFlag.resolvedAt).not.toBeNull();
  });

  test("moderate kept_existing: hard-deletes the new upload and keeps the existing one", async () => {
    const rawKey = "jt_test_dup_flags_kept_existing";
    await seedUserWithRoleAndKey("moderator", rawKey);
    const { flag, newUpload, existingUpload } = await seedPendingFlag();

    const res = await client
      .patch(`/api/v1/admin/duplicate-uploads/${flag.id}/moderate`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolution: "kept_existing" });

    expect(res.status).toBe(200);
    expect(res.body.resolution).toBe("kept_existing");
    expect(res.body.newUpload).toBeNull();
    expect(res.body.existingUpload).not.toBeNull();

    expect(await OriginalUpload.findByPk(newUpload.id)).toBeNull();
    expect(await OriginalUpload.findByPk(existingUpload.id)).not.toBeNull();
  });

  test("rejects an invalid resolution value", async () => {
    const rawKey = "jt_test_dup_flags_invalid";
    await seedUserWithRoleAndKey("moderator", rawKey);
    const { flag } = await seedPendingFlag();

    const res = await client
      .patch(`/api/v1/admin/duplicate-uploads/${flag.id}/moderate`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolution: "maybe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 409 when moderating an already-resolved flag", async () => {
    const rawKey = "jt_test_dup_flags_already_resolved";
    await seedUserWithRoleAndKey("moderator", rawKey);
    const { flag } = await seedPendingFlag();
    await flag.update({ status: "resolved", resolution: "kept_new", resolvedAt: new Date() });

    const res = await client
      .patch(`/api/v1/admin/duplicate-uploads/${flag.id}/moderate`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolution: "kept_existing" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("already_resolved");
  });

  test("non-moderator cannot moderate a flag", async () => {
    const rawKey = "jt_test_dup_flags_moderate_forbidden";
    await seedUserWithRoleAndKey("viewer", rawKey);
    const { flag } = await seedPendingFlag();

    const res = await client
      .patch(`/api/v1/admin/duplicate-uploads/${flag.id}/moderate`)
      .set("Authorization", `Bearer ${rawKey}`)
      .send({ resolution: "kept_new" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });
});
