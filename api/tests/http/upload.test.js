import { Buffer } from "node:buffer";
import { createTestClient } from "../helpers/app.js";
import { queryRows, resetTables, setupSchema } from "../helpers/db.js";

/**
 * HTTP contract tests for the implemented raw upload endpoint
 * (`POST /videos/upload`). These are GREEN: the route exists in
 * `routes/uploads.js` and persists to ORIGINAL_UPLOADS.
 */
describe("POST /videos/upload (ORIGINAL_UPLOADS)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  test("accepts a valid video file and persists an ORIGINAL_UPLOADS row", async () => {
    const res = await client
      .post("/api/v1/videos/upload")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      originalFilename: "clip.mp4",
      fileExtension: "mp4",
      status: "uploaded",
      userId: null,
    });
    expect(typeof res.body.uuidName).toBe("string");
    expect(res.body.uuidName).toHaveLength(36);
    expect(res.body.storagePath).toContain(res.body.uuidName);

    const rows = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE uuid_name = :uuidName",
      { uuidName: res.body.uuidName },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].original_filename).toBe("clip.mp4");
    expect(rows[0].file_extension).toBe("mp4");
    expect(rows[0].status).toBe("uploaded");
  });

  test("returns 400 missing_file when no file field is sent", async () => {
    const res = await client.post("/api/v1/videos/upload");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_file");
  });

  test("returns 400 unsupported_file_type for a disallowed extension", async () => {
    const res = await client
      .post("/api/v1/videos/upload")
      .attach("file", Buffer.from("nope"), "notes.txt");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_file_type");
    expect(Array.isArray(res.body.allowed)).toBe(true);
    expect(res.body.allowed).toEqual(expect.arrayContaining(["mp4"]));
  });

  test("returns 413 file_too_large when the file exceeds the size limit", async () => {
    // MAX_UPLOAD_SIZE_BYTES is set to 1024 in tests/setup/env.js.
    const res = await client
      .post("/api/v1/videos/upload")
      .attach("file", Buffer.alloc(4096, 0x61), "big.mp4");

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("file_too_large");
  });
});
