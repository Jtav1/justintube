import { Buffer } from "node:buffer";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedTranscodeProfile,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";
import { logger } from "../../lib/logger.js";

/**
 * HTTP contract tests for the implemented raw upload endpoint
 * (`POST /videos/upload`). These are GREEN: the route exists in
 * `routes/uploads.js` and persists to ORIGINAL_UPLOADS / FILE_VERSIONS.
 * Requires an authenticated user with the `uploader` flag (or admin).
 */
describe("POST /videos/upload (ORIGINAL_UPLOADS)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;
  /** @type {{id: number} & Record<string, unknown>} */
  let uploaderUser;
  /** @type {string} */
  const uploaderKey = "jt_test_uploader_key";

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

  /**
   * Seeds an uploader-flagged user (stored on `uploaderUser`) with an API
   * key. Callers build the actual request themselves afterward — a Supertest
   * `Test` is thenable, so returning one from this helper and `await`-ing the
   * call would resolve straight to the *response* instead of the request
   * builder, breaking further chaining (e.g. `.attach(...)`).
   *
   * @returns {Promise<void>} Resolves once the uploader user + key exist.
   */
  async function seedUploaderCreds() {
    uploaderUser = await seedUser({ uploader: true, emailVerified: true });
    await seedUserApiKey(uploaderUser.id, uploaderKey);
  }

  /**
   * Starts an authenticated `POST /videos/upload` request as `uploaderUser`.
   * Call {@link seedUploaderCreds} first.
   *
   * @returns {import('supertest').Test} Request builder (not yet awaited).
   */
  function uploadRequest() {
    return client.post("/api/v1/videos/upload").set("Authorization", `Bearer ${uploaderKey}`);
  }

  /**
   * Builds a `fetch` mock that answers `POST /transcode` by accepting every
   * job in the request (thumbnail + any rendition jobs) unconditionally —
   * the shape `finalizeUploadTranscodes` always sends now, even with zero
   * transcode profiles.
   *
   * @returns {jest.Mock} Mock matching the `globalThis.fetch` contract.
   */
  function acceptAllJobsFetchMock() {
    return jest.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body));
      return {
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          jobs: body.jobs.map((job) => ({
            jobId: job.jobId,
            outputFilename: job.outputFilename,
            profileId: job.profile?.id ?? null,
          })),
        }),
      };
    });
  }

  test("rejects an unauthenticated request", async () => {
    const res = await client
      .post("/api/v1/videos/upload")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects an authenticated user without the uploader flag", async () => {
    const viewer = await seedUser({ uploader: false, emailVerified: true });
    await seedUserApiKey(viewer.id, "jt_test_non_uploader_key");

    const res = await client
      .post("/api/v1/videos/upload")
      .set("Authorization", "Bearer jt_test_non_uploader_key")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("rejects an uploader-flagged user with an unverified email", async () => {
    const unverified = await seedUser({ uploader: true, emailVerified: false });
    await seedUserApiKey(unverified.id, "jt_test_unverified_uploader_key");

    const res = await client
      .post("/api/v1/videos/upload")
      .set("Authorization", "Bearer jt_test_unverified_uploader_key")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("accepts a valid video file and persists an ORIGINAL_UPLOADS row", async () => {
    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await uploadRequest()
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      originalFilename: "clip.mp4",
      fileExtension: "mp4",
      status: "uploaded",
      userId: uploaderUser.id,
    });
    expect(typeof res.body.videoId).toBe("string");
    expect(res.body.videoId).toHaveLength(6);
    expect(res.body.storagePath).toMatch(
      /^original\/\d+\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.mp4$/,
    );
    expect(res.body.storagePath).toContain(`/${uploaderUser.id}/`);
    expect(res.body.fileVersions).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const rows = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE video_id = :videoId",
      { videoId: res.body.videoId },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].original_filename).toBe("clip.mp4");
    expect(rows[0].file_extension).toBe("mp4");
    expect(rows[0].status).toBe("uploaded");
  });

  test("creates a VIDEO_METADATA row with a default title and private visibility", async () => {
    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await uploadRequest()
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);

    const rows = await queryRows(
      "SELECT * FROM VIDEO_METADATA WHERE original_upload_id = :id",
      { id: res.body.id },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("clip");
    expect(rows[0].visibility).toBe("private");
  });

  test("a freshly uploaded video can immediately be patched (no 404 from a missing VIDEO_METADATA row)", async () => {
    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const uploadRes = await uploadRequest()
      .attach("file", Buffer.from("tiny"), "clip.mp4");
    expect(uploadRes.status).toBe(201);

    const patchRes = await client
      .patch(`/api/v1/videos/${uploadRes.body.id}`)
      .set("Authorization", `Bearer ${uploaderKey}`)
      .send({ title: "New Title" });

    expect(patchRes.status).toBe(200);
    expect(patchRes.body.title).toBe("New Title");
  });

  test("always enqueues a thumbnail job, even when no transcode profiles exist", async () => {
    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await uploadRequest()
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0]).toMatchObject({
      jobId: res.body.videoId,
      outputFilename: `${uploaderUser.id}/${res.body.videoId}.webp`,
      kind: "thumbnail",
      timestampSeconds: null,
    });
  });

  test("classifies an uploaded audio file as mediaType audio and never contacts processing", async () => {
    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await uploadRequest()
      .attach("file", Buffer.from("id3-ish"), "clip.mp3");

    expect(res.status).toBe(201);
    expect(res.body.mediaType).toBe("audio");
    expect(res.body.fileVersions).toEqual([]);
    // No audio transcode profiles are configured by default, so there's
    // nothing to send to processing at all - not even a thumbnail job.
    expect(fetchMock).not.toHaveBeenCalled();

    const rows = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE video_id = :videoId",
      { videoId: res.body.videoId },
    );
    expect(rows[0].media_type).toBe("audio");

    const thumbRows = await queryRows(
      "SELECT * FROM VIDEO_THUMBNAIL WHERE original_upload_id = :id",
      { id: res.body.id },
    );
    expect(thumbRows).toHaveLength(0);
  });

  test("classifies an uploaded video file as mediaType video", async () => {
    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await uploadRequest()
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body.mediaType).toBe("video");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("only applies audio-flagged transcode profiles to an audio upload", async () => {
    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedTranscodeProfile({ resolutionName: "720p", mediaType: "video" });
    await seedTranscodeProfile({
      resolutionName: "240p",
      mediaType: "audio",
      outputContainer: "m4a",
      videoCodec: "none",
      audioCodec: "aac",
    });

    await seedUploaderCreds();
    const res = await uploadRequest()
      .attach("file", Buffer.from("id3-ish"), "clip.mp3");

    expect(res.status).toBe(201);
    expect(res.body.fileVersions).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    // Only the rendition job for the audio-flagged profile - no thumbnail job.
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0].kind).toBe("rendition");
  });

  test("persists thumbnailTimestamp and forwards it to processing as seconds", async () => {
    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await uploadRequest()
      .field("thumbnailTimestamp", "12.34")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    // 12.34s rounds to the nearest tenth (12.3) both in storage and in what's
    // forwarded to processing.
    expect(payload.jobs[0].timestampSeconds).toBe(12.3);

    const rows = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE video_id = :videoId",
      { videoId: res.body.videoId },
    );
    expect(Number(rows[0].thumbnail_timestamp_tenths)).toBe(123);
  });

  test("rejects a negative thumbnailTimestamp with 400 invalid_body", async () => {
    await seedUploaderCreds();
    const res = await uploadRequest()
      .field("thumbnailTimestamp", "-5")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("rejects a non-numeric thumbnailTimestamp with 400 invalid_body", async () => {
    await seedUploaderCreds();
    const res = await uploadRequest()
      .field("thumbnailTimestamp", "soon")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("skipThumbnail omits the thumbnail job, keeping any rendition jobs", async () => {
    await seedTranscodeProfile({ resolutionName: "720p", mediaType: "video" });
    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await uploadRequest()
      .field("skipThumbnail", "true")
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.jobs.every((job) => job.kind !== "thumbnail")).toBe(true);
    expect(payload.jobs).toHaveLength(1);
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

    const fetchMock = acceptAllJobsFetchMock();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await uploadRequest()
      .attach("file", Buffer.from("tiny"), "clip.mp4");

    expect(res.status).toBe(201);
    expect(res.body.status).toBe("processing");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "http://processing.test:3001/transcode",
    );

    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(payload.filename).toMatch(
      /^\d+\/[0-9a-f-]{36}\.mp4$/,
    );
    expect(payload.filename).toContain(`${uploaderUser.id}/`);
    // One thumbnail job + one job per rendition profile.
    expect(payload.jobs).toHaveLength(3);
    expect(payload.jobs.filter((j) => j.kind === "thumbnail")).toHaveLength(1);
    const renditionJobs = payload.jobs.filter((j) => j.kind === "rendition");
    expect(renditionJobs.map((j) => j.profile.id).sort()).toEqual(
      [profileA.id, profileB.id].sort(),
    );

    expect(res.body.fileVersions).toHaveLength(2);
    for (const fv of res.body.fileVersions) {
      expect(fv.status).toBe("processing");
      expect(fv.jobId).toBe(fv.uuidName);
      expect(fv.storagePath).toBe(`transcoded/${uploaderUser.id}/${fv.uuidName}.mp4`);
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
      const accepted = body.jobs.filter(
        (job) => job.kind === "thumbnail" || job.profile.id === profileA.id,
      );
      const skipped = body.jobs
        .filter((job) => job.kind === "rendition" && job.profile.id === profileB.id)
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
            profileId: job.profile?.id ?? null,
          })),
          skipped,
          source: { videoWidth: 1280, videoHeight: 720, durationSeconds: 42 },
        }),
      };
    });
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await uploadRequest()
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
    expect(res.body.durationSeconds).toBe(42);

    const versionRows = await queryRows(
      "SELECT * FROM FILE_VERSIONS WHERE original_upload_id = :id",
      { id: res.body.id },
    );
    expect(versionRows).toHaveLength(1);
    expect(Number(versionRows[0].transcode_profile_id)).toBe(profileA.id);
  });

  test("returns 201 with failures when processing rejects enqueue", async () => {
    await seedTranscodeProfile();
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});

    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ success: false, error: "queue unavailable" }),
    }));

    await seedUploaderCreds();
    const res = await uploadRequest()
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
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});

    globalThis.fetch = jest.fn(async () => {
      throw new Error("fetch failed");
    });

    await seedUploaderCreds();
    const res = await uploadRequest()
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
    await seedUploaderCreds();
    const res = await uploadRequest();

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("missing_file");
  });

  test("returns 400 unsupported_file_type for a disallowed extension", async () => {
    await seedUploaderCreds();
    const res = await uploadRequest()
      .attach("file", Buffer.from("nope"), "notes.txt");

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("unsupported_file_type");
    expect(Array.isArray(res.body.allowed)).toBe(true);
    expect(res.body.allowed).toEqual(expect.arrayContaining(["mp4"]));
  });

  describe("FILETYPES_CONVERTIBLE uploads (auto remux/transcode to H.264/AAC MP4)", () => {
    // tests/setup/env.js sets FILETYPES_CONVERTIBLE=mov,wma - neither is in
    // FILETYPES_ALLOWED (mp4,webm,mkv,mp3,wav), so these exercise the
    // accept-but-normalize tier rather than the reject or store-as-is tiers.

    test("accepts a convertible video extension, marks the upload 'converting', and enqueues a normalize job", async () => {
      const fetchMock = jest.fn(async (_url, options) => {
        const body = JSON.parse(String(options.body));
        return {
          ok: true,
          status: 202,
          json: async () => ({
            success: true,
            jobs: body.jobs.map((job) => ({ jobId: job.jobId, outputFilename: job.outputFilename })),
          }),
        };
      });
      globalThis.fetch = fetchMock;

      await seedUploaderCreds();
      const res = await uploadRequest().attach("file", Buffer.from("tiny"), "clip.mov");

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("converting");
      expect(res.body.fileVersions).toEqual([]);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      expect(fetchMock.mock.calls[0][0]).toBe("http://processing.test:3001/transcode");
      const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(payload.filename).toMatch(new RegExp(`^${uploaderUser.id}/[0-9a-f-]{36}\\.mov$`));
      expect(payload.jobs).toHaveLength(1);
      expect(payload.jobs[0]).toMatchObject({
        jobId: `normalize-${res.body.videoId}`,
        kind: "normalize",
      });
      // Normalize output gets a fresh uuid (distinct from the raw source's),
      // nested under the same per-user subfolder.
      expect(payload.jobs[0].outputFilename).toMatch(
        new RegExp(`^${uploaderUser.id}/[0-9a-f-]{36}\\.mp4$`),
      );

      const rows = await queryRows(
        "SELECT * FROM ORIGINAL_UPLOADS WHERE video_id = :videoId",
        { videoId: res.body.videoId },
      );
      expect(rows[0].status).toBe("converting");
      expect(rows[0].file_extension).toBe("mov");
    });

    test("targets an M4A output for a convertible audio-only extension", async () => {
      const fetchMock = jest.fn(async () => ({
        ok: true,
        status: 202,
        json: async () => ({ success: true, jobs: [] }),
      }));
      globalThis.fetch = fetchMock;

      await seedUploaderCreds();
      const res = await uploadRequest().attach("file", Buffer.from("tiny"), "clip.wma");

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("converting");

      const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(payload.jobs[0].outputFilename).toMatch(
        new RegExp(`^${uploaderUser.id}/[0-9a-f-]{36}\\.m4a$`),
      );
    });

    test("marks the upload failed when the normalize enqueue call itself fails", async () => {
      globalThis.fetch = jest.fn(async () => {
        throw new Error("processing unreachable");
      });

      await seedUploaderCreds();
      const res = await uploadRequest().attach("file", Buffer.from("tiny"), "clip.mov");

      expect(res.status).toBe(201);
      expect(res.body.status).toBe("failed");
      expect(res.body.failures).toEqual([
        { profileId: null, message: "processing unreachable" },
      ]);

      const rows = await queryRows(
        "SELECT * FROM ORIGINAL_UPLOADS WHERE video_id = :videoId",
        { videoId: res.body.videoId },
      );
      expect(rows[0].status).toBe("failed");
    });
  });

  test("returns 413 file_too_large when the file exceeds the size limit", async () => {
    // MAX_UPLOAD_SIZE_BYTES is set to 1024 in tests/setup/env.js.
    await seedUploaderCreds();
    const res = await uploadRequest()
      .attach("file", Buffer.alloc(4096, 0x61), "big.mp4");

    expect(res.status).toBe(413);
    expect(res.body.error).toBe("file_too_large");
  });
});

describe("GET /videos/import/status (processing health check)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;
  /** @type {string} */
  const uploaderKey = "jt_test_import_status_key";

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

  async function seedUploaderCreds() {
    const uploaderUser = await seedUser({ uploader: true, emailVerified: true });
    await seedUserApiKey(uploaderUser.id, uploaderKey);
  }

  test("rejects an unauthenticated request", async () => {
    const res = await client.get("/api/v1/videos/import/status");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("returns available: true when processing reports healthy", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "ok", redis: "configured" }),
    }));

    await seedUploaderCreds();
    const res = await client
      .get("/api/v1/videos/import/status")
      .set("Authorization", `Bearer ${uploaderKey}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: true });
  });

  test("returns available: false when processing responds with a non-2xx status", async () => {
    globalThis.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "boom" }),
    }));

    await seedUploaderCreds();
    const res = await client
      .get("/api/v1/videos/import/status")
      .set("Authorization", `Bearer ${uploaderKey}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });

  test("returns available: false when processing is unreachable", async () => {
    globalThis.fetch = jest.fn(async () => {
      throw new Error("fetch failed");
    });

    await seedUploaderCreds();
    const res = await client
      .get("/api/v1/videos/import/status")
      .set("Authorization", `Bearer ${uploaderKey}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ available: false });
  });
});
