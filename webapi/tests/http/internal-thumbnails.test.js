import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedMetadata,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * HTTP tests for the processing → API thumbnail-generation callback.
 */
describe("POST /internal/thumbnails/:uploadUuid/complete", () => {
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
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/thumbnails/${upload.videoId}/complete`)
      .send({ thumbnailFilename: `${upload.videoId}.webp` });

    expect(res.status).toBe(401);
  });

  test("returns 400 when thumbnailFilename is missing", async () => {
    const upload = await seedUpload();

    const res = await client
      .post(`/internal/thumbnails/${upload.videoId}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 404 for an unknown upload videoId", async () => {
    const res = await client
      .post("/internal/thumbnails/000000/complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename: "whatever.webp" });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("creates a VIDEO_THUMBNAIL row on first success", async () => {
    const upload = await seedUpload();
    const thumbnailFilename = `${upload.videoId}.webp`;

    const res = await client
      .post(`/internal/thumbnails/${upload.videoId}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      videoId: upload.videoId,
      status: "complete",
    });

    const rows = await queryRows(
      "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].thumbnail_filename).toBe(thumbnailFilename);
  });

  test("updates the existing row instead of duplicating on re-run", async () => {
    const upload = await seedUpload();
    const firstFilename = `${upload.videoId}.webp`;
    const secondFilename = `${upload.videoId}-2.webp`;

    const first = await client
      .post(`/internal/thumbnails/${upload.videoId}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename: firstFilename });
    expect(first.status).toBe(200);

    const second = await client
      .post(`/internal/thumbnails/${upload.videoId}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename: secondFilename });
    expect(second.status).toBe(200);

    const rows = await queryRows(
      "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
      { id: upload.id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].thumbnail_filename).toBe(secondFilename);
  });

  test("reflects the new thumbnail in GET /videos/:id", async () => {
    const upload = await seedUpload();
    await seedMetadata(upload.id, { visibility: "public" });
    const thumbnailFilename = `${upload.videoId}.webp`;

    const complete = await client
      .post(`/internal/thumbnails/${upload.videoId}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ thumbnailFilename });
    expect(complete.status).toBe(200);

    const res = await client.get(`/api/v1/videos/${upload.id}`);
    expect(res.status).toBe(200);
    expect(res.body.thumbnailUrl).toBe(`/api/v1/videos/${upload.id}/thumbnail`);
  });
});
