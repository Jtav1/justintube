import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedFileVersion,
  seedUpload,
  seedUser,
  seedUserApiKey,
  seedVideoSubtitle,
  seedVideoThumbnail,
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

describe("GET /api/v1/admin/files/uploads/:identifier", () => {
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
    const res = await client.get("/api/v1/admin/files/uploads/1");
    expect(res.status).toBe(401);
  });

  test("rejects a non-admin", async () => {
    const rawKey = "jt_test_admin_files_viewer";
    await seedUserWithRoleAndKey("viewer", rawKey);

    const res = await client
      .get("/api/v1/admin/files/uploads/1")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("returns 404 for an unknown identifier", async () => {
    const rawKey = "jt_test_admin_files_missing";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .get("/api/v1/admin/files/uploads/999999")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("resolves by pkid and lists all associated files", async () => {
    const rawKey = "jt_test_admin_files_pkid";
    await seedUserWithRoleAndKey("admin", rawKey);
    const upload = await seedUpload();
    const fileVersion = await seedFileVersion(upload.id);
    const thumbnail = await seedVideoThumbnail(upload.id);
    const subtitle = await seedVideoSubtitle(upload.id, { source: "auto" });

    const res = await client
      .get(`/api/v1/admin/files/uploads/${upload.id}`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.upload).toMatchObject({
      id: upload.id,
      videoId: upload.videoId,
      uuid: upload.uuid,
    });
    expect(res.body.files.original).toMatchObject({
      kind: "original",
      relativePath: upload.storagePath,
    });
    expect(res.body.files.original.existsOnDisk).toBe(false);
    expect(res.body.files.thumbnail).toMatchObject({ id: thumbnail.id, kind: "thumbnail" });
    expect(res.body.files.subtitle).toMatchObject({
      id: subtitle.id,
      kind: "subtitle",
      source: "auto",
      relativePath: `subtitles/${subtitle.subtitleFilename}`,
    });
    expect(res.body.files.subtitle.existsOnDisk).toBe(false);
    expect(res.body.files.transcoded).toHaveLength(1);
    expect(res.body.files.transcoded[0]).toMatchObject({
      id: fileVersion.id,
      uuidName: fileVersion.uuidName,
    });
  });

  test("omits subtitle when the upload has no subtitle track", async () => {
    const rawKey = "jt_test_admin_files_no_subtitle";
    await seedUserWithRoleAndKey("admin", rawKey);
    const upload = await seedUpload();

    const res = await client
      .get(`/api/v1/admin/files/uploads/${upload.id}`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.files.subtitle).toBeNull();
  });

  test("resolves by internal uuid", async () => {
    const rawKey = "jt_test_admin_files_uuid";
    await seedUserWithRoleAndKey("admin", rawKey);
    const upload = await seedUpload();

    const res = await client
      .get(`/api/v1/admin/files/uploads/${upload.uuid}`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.upload.id).toBe(upload.id);
  });

  test("resolves by public videoId", async () => {
    const rawKey = "jt_test_admin_files_videoid";
    await seedUserWithRoleAndKey("admin", rawKey);
    const upload = await seedUpload();

    const res = await client
      .get(`/api/v1/admin/files/uploads/${upload.videoId}`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.upload.id).toBe(upload.id);
  });
});

describe("GET /api/v1/admin/files/lookup/:uuid", () => {
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
    const res = await client.get("/api/v1/admin/files/lookup/some-uuid");
    expect(res.status).toBe(401);
  });

  test("returns 404 for an unknown uuid", async () => {
    const rawKey = "jt_test_admin_lookup_missing";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .get("/api/v1/admin/files/lookup/does-not-exist")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("traces an original upload's own uuid", async () => {
    const rawKey = "jt_test_admin_lookup_original";
    await seedUserWithRoleAndKey("admin", rawKey);
    const upload = await seedUpload();

    const res = await client
      .get(`/api/v1/admin/files/lookup/${upload.uuid}`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.matchedAs).toBe("original");
    expect(res.body.matchedFileVersionId).toBeNull();
    expect(res.body.upload.id).toBe(upload.id);
  });

  test("traces a transcoded file version's uuid back to its upload", async () => {
    const rawKey = "jt_test_admin_lookup_transcoded";
    await seedUserWithRoleAndKey("admin", rawKey);
    const upload = await seedUpload();
    const fileVersion = await seedFileVersion(upload.id);

    const res = await client
      .get(`/api/v1/admin/files/lookup/${fileVersion.uuidName}`)
      .set("Authorization", `Bearer ${rawKey}`);

    expect(res.status).toBe(200);
    expect(res.body.matchedAs).toBe("transcoded");
    expect(res.body.matchedFileVersionId).toBe(fileVersion.id);
    expect(res.body.upload.id).toBe(upload.id);
    expect(res.body.files.transcoded).toHaveLength(1);
  });
});

describe("GET /api/v1/admin/files/tree/:category", () => {
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
    const res = await client.get("/api/v1/admin/files/tree/original");
    expect(res.status).toBe(401);
  });

  test("rejects an unknown category", async () => {
    const rawKey = "jt_test_admin_tree_invalid";
    await seedUserWithRoleAndKey("admin", rawKey);

    const res = await client
      .get("/api/v1/admin/files/tree/bogus")
      .set("Authorization", `Bearer ${rawKey}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_category");
  });

  test("lists each valid category without erroring", async () => {
    const rawKey = "jt_test_admin_tree_valid";
    await seedUserWithRoleAndKey("admin", rawKey);

    for (const category of ["original", "transcoded", "thumbnails", "subtitles"]) {
      const res = await client
        .get(`/api/v1/admin/files/tree/${category}`)
        .set("Authorization", `Bearer ${rawKey}`);
      expect(res.status).toBe(200);
      expect(res.body.category).toBe(category);
      expect(Array.isArray(res.body.children)).toBe(true);
    }
  });
});
