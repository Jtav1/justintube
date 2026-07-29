import { Buffer } from "node:buffer";
import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedMetadata,
  seedUpload,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";

/**
 * HTTP contract tests for `POST /videos/:id/thumbnail` — lets the video
 * owner (or an admin) upload a custom thumbnail image, replacing whatever
 * VIDEO_THUMBNAIL row/file already exists (auto-generated or otherwise).
 */
describe("POST /videos/:id/thumbnail", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  /**
   * Seeds an owner user (with an API key) plus an upload+metadata row they
   * own.
   *
   * @returns {Promise<{ ownerKey: string, ownerId: number, uploadId: number }>}
   */
  async function seedOwnedVideo() {
    const owner = await seedUser({ emailVerified: true });
    const ownerKey = `jt_test_${owner.id}_thumb_key`;
    await seedUserApiKey(owner.id, ownerKey);
    const upload = await seedUpload({ userId: owner.id });
    await seedMetadata(upload.id, { title: "Owned video" });
    return { ownerKey, ownerId: owner.id, uploadId: upload.id };
  }

  test("rejects an unauthenticated request", async () => {
    const { uploadId } = await seedOwnedVideo();
    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .attach("file", Buffer.from("fake-image-bytes"), "thumb.jpg");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects a user who is not the owner or an admin", async () => {
    const { uploadId } = await seedOwnedVideo();
    const stranger = await seedUser({ emailVerified: true });
    const strangerKey = "jt_test_stranger_thumb_key";
    await seedUserApiKey(stranger.id, strangerKey);

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail`)
      .set("Authorization", `Bearer ${strangerKey}`)
      .attach("file", Buffer.from("fake-image-bytes"), "thumb.jpg");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("returns 404 for an unknown video id", async () => {
    const owner = await seedUser({ emailVerified: true });
    const ownerKey = "jt_test_unknown_video_thumb_key";
    await seedUserApiKey(owner.id, ownerKey);

    const res = await client
      .post("/api/v1/videos/999999/thumbnail")
      .set("Authorization", `Bearer ${ownerKey}`)
      .attach("file", Buffer.from("fake-image-bytes"), "thumb.jpg");

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("returns 400 invalid_body when no file is sent", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail`)
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 400 unsupported_file_type for a disallowed extension", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .attach("file", Buffer.from("nope"), "notes.txt");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_file_type");
    expect(res.body.allowed).toEqual(expect.arrayContaining(["jpg"]));
  });

  test("owner can upload a thumbnail, creating a VIDEO_THUMBNAIL row", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .attach("file", Buffer.from("fake-image-bytes"), "thumb.jpg");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ thumbnailUrl: `/api/v1/videos/${uploadId}/thumbnail` });

    const rows = await queryRows(
      "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
      { id: uploadId },
    );
    expect(rows).toHaveLength(1);
    expect(String(rows[0].thumbnail_filename)).toMatch(/\.jpg$/);
  });

  test("re-uploading replaces the existing thumbnail (single row, old file removed)", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();

    const first = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .attach("file", Buffer.from("fake-image-bytes-one"), "thumb1.png");
    expect(first.status).toBe(200);

    const firstRows = await queryRows(
      "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
      { id: uploadId },
    );
    const firstFilename = firstRows[0].thumbnail_filename;

    const second = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .attach("file", Buffer.from("fake-image-bytes-two"), "thumb2.webp");
    expect(second.status).toBe(200);

    const secondRows = await queryRows(
      "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
      { id: uploadId },
    );
    expect(secondRows).toHaveLength(1);
    expect(secondRows[0].thumbnail_filename).not.toBe(firstFilename);
    expect(String(secondRows[0].thumbnail_filename)).toMatch(/\.webp$/);
  });

  test("the uploaded thumbnail can immediately be fetched back via GET", async () => {
    const { ownerKey, uploadId } = await seedOwnedVideo();

    const uploadRes = await client
      .post(`/api/v1/videos/${uploadId}/thumbnail`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .attach("file", Buffer.from("fake-image-bytes"), "thumb.jpg");
    expect(uploadRes.status).toBe(200);

    const getRes = await client.get(`/api/v1/videos/${uploadId}/thumbnail`);
    expect(getRes.status).toBe(200);
    expect(getRes.headers["content-type"]).toBe("image/jpeg");
  });
});
