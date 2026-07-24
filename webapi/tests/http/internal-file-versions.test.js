import { afterEach, beforeAll, describe, expect, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedFileVersion,
  seedUpload,
  setupSchema,
} from "../helpers/db.js";

const TOKEN = "test-internal-token";

/**
 * HTTP tests for processing → API file-version lifecycle callbacks.
 */
describe("POST /internal/file-versions/:uuid", () => {
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
    const version = await seedFileVersion(upload.id, {
      status: "processing",
      uuidName: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });

    const res = await client
      .post(`/internal/file-versions/${version.uuidName}/complete`)
      .send({ fileSizeBytes: 100 });

    expect(res.status).toBe(401);
  });

  test("completes a file version and rolls upload up to ready", async () => {
    const upload = await seedUpload({ status: "processing" });
    const version = await seedFileVersion(upload.id, {
      status: "processing",
      uuidName: "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee",
      storagePath: "transcoded/bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.mp4",
    });

    const res = await client
      .post(`/internal/file-versions/${version.uuidName}/complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        fileSizeBytes: 2048,
        videoWidth: 1280,
        videoHeight: 720,
        resolution: "720p",
        storagePath: version.storagePath,
        mimeType: "video/mp4",
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      status: "complete",
      uuidName: version.uuidName,
    });

    const versions = await queryRows(
      "SELECT * FROM FILE_VERSIONS WHERE id = :id",
      { id: version.id },
    );
    expect(versions[0].status).toBe("complete");
    expect(Number(versions[0].file_size_bytes)).toBe(2048);

    const uploads = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE id = :id",
      { id: upload.id },
    );
    expect(uploads[0].status).toBe("ready");
  });

  test("marks a file version failed", async () => {
    const upload = await seedUpload({ status: "processing" });
    const version = await seedFileVersion(upload.id, {
      status: "processing",
      uuidName: "cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee",
    });

    const res = await client
      .post(`/internal/file-versions/${version.uuidName}/fail`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg exploded" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("failed");

    const versions = await queryRows(
      "SELECT * FROM FILE_VERSIONS WHERE id = :id",
      { id: version.id },
    );
    expect(versions[0].status).toBe("failed");

    const uploads = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE id = :id",
      { id: upload.id },
    );
    expect(uploads[0].status).toBe("failed");
  });
});
