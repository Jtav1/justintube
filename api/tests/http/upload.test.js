import { Buffer } from "node:buffer";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedTranscodeProfile,
  setupSchema,
} from "../helpers/db.js";

/**
 * HTTP contract tests for the implemented raw upload endpoint
 * (`POST /videos/upload`). These are GREEN: the route exists in
 * `routes/uploads.js` and persists to ORIGINAL_UPLOADS / FILE_VERSIONS.
 */
describe("POST /videos/upload (ORIGINAL_UPLOADS)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  test("accepts a valid video file and persists an ORIGINAL_UPLOADS row", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

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
    expect(res.body.storagePath).toBe(`original/${res.body.uuidName}.mp4`);
    expect(res.body.fileVersions).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    const rows = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE uuid_name = :uuidName",
      { uuidName: res.body.uuidName },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].original_filename).toBe("clip.mp4");
    expect(rows[0].file_extension).toBe("mp4");
    expect(rows[0].status).toBe("uploaded");
  });

  test("does not call processing when no transcode profiles exist", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    const res = await client
      .post("/api/v1/videos/upload")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("batch-enqueues jobs and creates pending FILE_VERSIONS", async () => {
    const profileA = await seedTranscodeProfile({
      outputHeight: 720,
      outputWidth: 1280,
      outputContainer: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
    });
    const profileB = await seedTranscodeProfile({
      outputHeight: 1080,
      outputWidth: 1920,
      outputContainer: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
    });

    const fetchMock = jest.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body));
      return {
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          jobs: body.jobs.map((job) => ({
            jobId: job.jobId,
            outputFilename: job.outputFilename,
            profileId: job.profile.id,
          })),
        }),
      };
    });
    globalThis.fetch = fetchMock;

    const res = await client
      .post("/api/v1/videos/upload")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("processing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://processing.test:3001/transcode",
    );

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.filename).toBe(`${res.body.uuidName}.mp4`);
    expect(payload.jobs).toHaveLength(2);
    expect(payload.jobs.map((j) => j.profile.id).sort()).toEqual(
      [profileA.id, profileB.id].sort(),
    );

    expect(res.body.fileVersions).toHaveLength(2);
    for (const fv of res.body.fileVersions) {
      expect(fv.status).toBe("processing");
      expect(fv.jobId).toBe(fv.uuidName);
      expect(fv.storagePath).toBe(`transcoded/${fv.uuidName}.mp4`);
    }

    const versionRows = await queryRows(
      "SELECT * FROM FILE_VERSIONS WHERE original_upload_id = :id",
      { id: res.body.id },
    );
    expect(versionRows).toHaveLength(2);
    expect(
      versionRows.every((row) =>
        String(row.storage_path).startsWith("transcoded/"),
      ),
    ).toBe(true);
  });

  test("drops FILE_VERSIONS for profiles skipped as larger than source", async () => {
    const profileA = await seedTranscodeProfile({
      outputHeight: 720,
      outputWidth: 1280,
      outputContainer: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
    });
    const profileB = await seedTranscodeProfile({
      outputHeight: 1080,
      outputWidth: 1920,
      outputContainer: "mp4",
      videoCodec: "h264",
      audioCodec: "aac",
    });

    const fetchMock = jest.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body));
      const accepted = body.jobs.filter((job) => job.profile.id === profileA.id);
      const skipped = body.jobs
        .filter((job) => job.profile.id === profileB.id)
        .map((job) => ({
          jobId: job.jobId,
          profileId: job.profile.id,
          reason: "profile_exceeds_source_resolution",
        }));
      return {
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          jobs: accepted.map((job) => ({
            jobId: job.jobId,
            outputFilename: job.outputFilename,
            profileId: job.profile.id,
          })),
          skipped,
          source: { videoWidth: 1280, videoHeight: 720 },
        }),
      };
    });
    globalThis.fetch = fetchMock;

    const res = await client
      .post("/api/v1/videos/upload")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("processing");
    expect(res.body.fileVersions).toHaveLength(1);
    expect(res.body.fileVersions[0].transcodeProfileId).toBe(profileA.id);
    expect(res.body.skippedProfiles).toEqual([
      {
        profileId: profileB.id,
        jobId: expect.any(String),
        reason: "profile_exceeds_source_resolution",
      },
    ]);
    expect(res.body.videoWidth).toBe(1280);
    expect(res.body.videoHeight).toBe(720);

    const versionRows = await queryRows(
      "SELECT * FROM FILE_VERSIONS WHERE original_upload_id = :id",
      { id: res.body.id },
    );
    expect(versionRows).toHaveLength(1);
    expect(Number(versionRows[0].transcode_profile_id)).toBe(profileA.id);
  });

  test("returns 201 with failures when processing rejects enqueue", async () => {
    await seedTranscodeProfile();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: "queue unavailable" }),
    }));

    const res = await client
      .post("/api/v1/videos/upload")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body.id).toEqual(expect.any(Number));
    expect(res.body.failures).toEqual([
      { profileId: null, message: "queue unavailable" },
    ]);
    expect(res.body.fileVersions).toHaveLength(1);
    expect(res.body.fileVersions[0].status).toBe("failed");
    expect(errorSpy).toHaveBeenCalled();

    const rows = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE id = :id",
      { id: res.body.id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");

    errorSpy.mockRestore();
  });

  test("returns 201 with failures when processing is unreachable", async () => {
    await seedTranscodeProfile();
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

    globalThis.fetch = jest.fn(async () => {
      throw new Error("fetch failed");
    });

    const res = await client
      .post("/api/v1/videos/upload")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body.failures).toEqual([
      { profileId: null, message: "fetch failed" },
    ]);
    expect(res.body.fileVersions[0].status).toBe("failed");
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
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
