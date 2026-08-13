import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { DuplicateUploadFlag, Notification, OriginalUpload, Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedUpload,
  seedUser,
  setupSchema,
} from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * Seeds a user with the given role name.
 *
 * @param {string} roleName Role name (`admin`, `moderator`, `viewer`, …).
 * @param {object} [overrides] Extra `seedUser` overrides.
 * @returns {Promise<{id: number} & Record<string, unknown>>} Seeded user record.
 */
async function seedUserWithRole(roleName, overrides = {}) {
  const role = await Role.findOne({ where: { name: roleName } });
  return seedUser({ roleId: role?.id ?? null, emailVerified: true, ...overrides });
}

/**
 * HTTP tests for processing -> API duplicate-upload content-hash callbacks.
 * The upload is always already live/finalized by the time these callbacks
 * fire (hashing runs entirely in the background after the upload response
 * has already been sent) — so these only ever record the hash and, on a
 * match, create a review flag + notification. Neither callback ever alters
 * an upload's status.
 */
describe("POST /internal/original-uploads/:jobId/hash-complete and hash-failed", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("rejects missing bearer token", async () => {
    const upload = await seedUpload({ status: "uploaded" });
    const res = await client
      .post(`/internal/original-uploads/hash-${upload.videoId}/hash-complete`)
      .send({ contentHash: "sha256:abc" });
    expect(res.status).toBe(401);
  });

  test("returns 404 for an unknown videoId", async () => {
    const res = await client
      .post("/internal/original-uploads/hash-zzzzzz/hash-complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ contentHash: "sha256:abc" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("no match: records the hash and leaves the upload's status untouched", async () => {
    const upload = await seedUpload({ status: "uploaded" });
    await seedMetadata(upload.id);

    const res = await client
      .post(`/internal/original-uploads/hash-${upload.videoId}/hash-complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ contentHash: "sha256:unique-hash" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: "no_duplicate" });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.status).toBe("uploaded");
    expect(reloaded.contentHash).toBe("sha256:unique-hash");

    expect(await DuplicateUploadFlag.count()).toBe(0);
  });

  test("match found: creates a flag and notifies admins/moderators only, without touching either upload's status", async () => {
    const existing = await seedUpload({ status: "uploaded", contentHash: "sha256:shared-hash-value" });
    await seedMetadata(existing.id, { title: "Original video" });

    const newUpload = await seedUpload({ status: "processing" });
    await seedMetadata(newUpload.id, { title: "Possible duplicate" });

    const admin = await seedUserWithRole("admin");
    const moderator = await seedUserWithRole("moderator");
    const viewer = await seedUserWithRole("viewer");

    const res = await client
      .post(`/internal/original-uploads/hash-${newUpload.videoId}/hash-complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ contentHash: "sha256:shared-hash-value" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, status: "duplicate_flagged" });
    expect(typeof res.body.flagId).toBe("number");

    const reloaded = await OriginalUpload.findByPk(newUpload.id);
    expect(reloaded.status).toBe("processing");

    const flag = await DuplicateUploadFlag.findByPk(res.body.flagId);
    expect(flag).not.toBeNull();
    expect(flag.newOriginalUploadId).toBe(newUpload.id);
    expect(flag.existingOriginalUploadId).toBe(existing.id);
    expect(flag.status).toBe("pending");

    const adminNotifications = await Notification.findAll({ where: { userId: admin.id } });
    const modNotifications = await Notification.findAll({ where: { userId: moderator.id } });
    const viewerNotifications = await Notification.findAll({ where: { userId: viewer.id } });
    expect(adminNotifications.length).toBeGreaterThanOrEqual(1);
    expect(modNotifications.length).toBeGreaterThanOrEqual(1);
    expect(viewerNotifications).toHaveLength(0);
    expect(adminNotifications[0].message).toContain(newUpload.videoId);
    expect(adminNotifications[0].message).toContain(existing.videoId);
  });

  test("does not match against a failed or still-downloading upload", async () => {
    const failed = await seedUpload({ status: "failed", contentHash: "sha256:shared-hash-value" });
    await seedMetadata(failed.id);
    const downloading = await seedUpload({ status: "downloading", contentHash: "sha256:shared-hash-value" });
    await seedMetadata(downloading.id);

    const newUpload = await seedUpload({ status: "uploaded" });
    await seedMetadata(newUpload.id);

    const res = await client
      .post(`/internal/original-uploads/hash-${newUpload.videoId}/hash-complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ contentHash: "sha256:shared-hash-value" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("no_duplicate");
  });

  test("hash-failed just logs: leaves the upload untouched", async () => {
    const upload = await seedUpload({ status: "processing" });
    await seedMetadata(upload.id);

    const res = await client
      .post(`/internal/original-uploads/hash-${upload.videoId}/hash-failed`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg crashed" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.status).toBe("processing");
    expect(reloaded.contentHash).toBeNull();
  });
});
