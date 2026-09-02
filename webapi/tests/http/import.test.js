import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { createTestClient } from "../helpers/app.js";
import {
  queryRows,
  resetTables,
  seedTranscodeProfile,
  seedUpload,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";
import { continueImport, originalDir } from "../../routes/uploads.js";
import { OriginalUpload } from "../../lib/models/index.js";
import { userStorageSegment } from "../../lib/media-meta.js";

/**
 * HTTP contract + unit tests for the URL-import flow (`POST /videos/import`
 * plus `continueImport`, the background continuation it kicks off).
 *
 * `POST /videos/import` only creates a placeholder ORIGINAL_UPLOADS/
 * VIDEO_METADATA row (status "downloading") and responds immediately — the
 * actual yt-dlp download, rename, and transcode-enqueue happen afterward in
 * `continueImport`, called without awaiting it (fire-and-forget) so the
 * client's HTTP request never blocks on yt-dlp. Most scenario coverage below
 * therefore calls `continueImport` directly (seeding a "downloading"
 * placeholder row first, mirroring what the route creates) rather than
 * racing the fire-and-forget call through the HTTP layer — deterministic,
 * and avoids a background promise from one test still running (and possibly
 * throwing on a row `resetTables()` already deleted) during the next test.
 * Requires an authenticated user with the `uploader` flag (or admin).
 */
describe("POST /videos/import (ORIGINAL_UPLOADS via URL download)", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;
  /** @type {{id: number} & Record<string, unknown>} */
  let uploaderUser;
  /** @type {string} */
  const uploaderKey = "jt_test_importer_key";

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
    mkdirSync(originalDir, { recursive: true });
  });

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  /**
   * Writes a fixture file into `original/` to stand in for the file
   * processing would have written there via yt-dlp.
   *
   * @param {string} name Basename to create under `original/`.
   * @returns {void}
   */
  function writeDownloadedFixture(name) {
    writeFileSync(join(originalDir, name), Buffer.from("fake-video"));
  }

  /**
   * Seeds an uploader-flagged user (stored on `uploaderUser`) with an API
   * key. Callers build the actual request themselves afterward — a Supertest
   * `Test` is thenable, so returning one from this helper and `await`-ing the
   * call would resolve straight to the *response* instead of the request
   * builder, breaking further chaining (e.g. `.send(...)`).
   *
   * @returns {Promise<void>} Resolves once the uploader user + key exist.
   */
  async function seedUploaderCreds() {
    uploaderUser = await seedUser({ uploader: true, emailVerified: true });
    await seedUserApiKey(uploaderUser.id, uploaderKey);
  }

  /**
   * Starts an authenticated `POST /videos/import` request as `uploaderUser`.
   * Call {@link seedUploaderCreds} first.
   *
   * @returns {import('supertest').Test} Request builder (not yet awaited).
   */
  function importRequest() {
    return client.post("/api/v1/videos/import").set("Authorization", `Bearer ${uploaderKey}`);
  }

  /**
   * Seeds a placeholder ORIGINAL_UPLOADS/VIDEO_METADATA-less row matching
   * what `importVideo` creates before handing off to `continueImport` — a
   * real Sequelize instance (not the plain-object shape `seedUpload`
   * returns), since `continueImport` calls `.update()` on it directly.
   *
   * @param {object} [overrides] Passed through to `seedUpload`.
   * @returns {Promise<import('sequelize').Model>} The placeholder row.
   */
  async function seedDownloadingUpload(overrides = {}) {
    const seeded = await seedUpload({
      originalFilename: "",
      fileExtension: "",
      storagePath: "",
      status: "downloading",
      userId: uploaderUser?.id ?? null,
      ...overrides,
    });
    return OriginalUpload.findByPk(seeded.id);
  }

  /**
   * Builds a `fetch` mock that answers `POST /download` with a fixed
   * downloaded filename and `POST /transcode` by accepting every job in the
   * request (thumbnail + any rendition jobs) unconditionally — the shape
   * `finalizeUploadTranscodes` always sends now, even with zero transcode
   * profiles.
   *
   * @param {string} downloadedFilename Filename processing "downloaded".
   * @param {boolean} [hasVideo] When provided, included in the mocked
   *   `/download` response (processing's ffprobe-based signal). Omitted by
   *   default so existing tests keep exercising the extension-based
   *   classification fallback.
   * @returns {jest.Mock} Mock matching the `globalThis.fetch` contract.
   */
  function downloadThenAcceptAllJobsFetchMock(downloadedFilename, hasVideo) {
    return jest.fn(async (url, options) => {
      if (url === "http://processing.test:3001/download") {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            filename: downloadedFilename,
            ...(hasVideo !== undefined ? { hasVideo } : {}),
          }),
        };
      }
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
      .post("/api/v1/videos/import")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects an authenticated user without the uploader flag", async () => {
    const viewer = await seedUser({ uploader: false, emailVerified: true });
    await seedUserApiKey(viewer.id, "jt_test_non_uploader_import_key");

    const res = await client
      .post("/api/v1/videos/import")
      .set("Authorization", "Bearer jt_test_non_uploader_import_key")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("rejects an uploader-flagged user with an unverified email", async () => {
    const unverified = await seedUser({ uploader: true, emailVerified: false });
    await seedUserApiKey(unverified.id, "jt_test_unverified_importer_key");

    const res = await client
      .post("/api/v1/videos/import")
      .set("Authorization", "Bearer jt_test_unverified_importer_key")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("returns 400 invalid_body when url is missing", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await importRequest().send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("returns 400 invalid_body when url is not http(s)", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await importRequest()
      .send({ url: "ftp://example.com/video.mp4" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects a negative thumbnailTimestamp with 400 invalid_body", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await importRequest()
      .send({ url: "https://example.com/watch?v=abc", thumbnailTimestamp: -5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("rejects a non-numeric thumbnailTimestamp with 400 invalid_body", async () => {
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await importRequest()
      .send({ url: "https://example.com/watch?v=abc", thumbnailTimestamp: "soon" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("responds immediately with a downloading placeholder, then finishes in the background", async () => {
    writeDownloadedFixture("1737900000.mp4");
    const fetchMock = downloadThenAcceptAllJobsFetchMock("1737900000.mp4");
    globalThis.fetch = fetchMock;

    await seedUploaderCreds();
    const res = await importRequest()
      .send({ url: "https://example.com/watch?v=abc" });

    // The fast path: no network/DB work beyond creating the placeholder row.
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      originalFilename: "",
      fileExtension: "",
      storagePath: "",
      status: "downloading",
      statusMessage: null,
      userId: uploaderUser.id,
    });
    expect(typeof res.body.videoId).toBe("string");
    expect(res.body.videoId).toHaveLength(6);
    expect(res.body.fileVersions).toEqual([]);

    // Let the fire-and-forget continueImport() call settle before the test
    // (and afterEach's resetTables()) moves on, so it can't race a later test.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const rows = await queryRows(
      "SELECT * FROM ORIGINAL_UPLOADS WHERE video_id = :videoId",
      { videoId: res.body.videoId },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].original_filename).toBe("1737900000.mp4");
    expect(rows[0].status).toBe("uploaded");
    const segment = userStorageSegment(rows[0].user_id);
    expect(
      existsSync(join(originalDir, segment, `${rows[0].uuid}.mp4`)),
    ).toBe(true);
    expect(existsSync(join(originalDir, "1737900000.mp4"))).toBe(false);
  });

  describe("continueImport", () => {
    test("downloads, renames, and finalizes a video with no transcode profiles", async () => {
      writeDownloadedFixture("1737900010.mp4");
      const fetchMock = downloadThenAcceptAllJobsFetchMock("1737900010.mp4");
      globalThis.fetch = fetchMock;

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();

      await continueImport(upload, "https://example.com/watch?v=abc", {});
      await upload.reload();

      expect(upload.originalFilename).toBe("1737900010.mp4");
      expect(upload.fileExtension).toBe("mp4");
      expect(upload.status).toBe("uploaded");
      const segment = userStorageSegment(upload.userId);
      expect(upload.storagePath).toBe(`original/${segment}/${upload.uuid}.mp4`);
      expect(existsSync(join(originalDir, segment, `${upload.uuid}.mp4`))).toBe(true);
      expect(existsSync(join(originalDir, "1737900010.mp4"))).toBe(false);

      // /download, then /transcode for the auto-generated thumbnail job
      // (video uploads always get one regardless of transcode profiles).
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe("http://processing.test:3001/download");
      const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body));
      expect(payload.url).toBe("https://example.com/watch?v=abc");
    });

    test("classifies an audio-only download (hasVideo: false) as mediaType audio and still enqueues a thumbnail job", async () => {
      writeDownloadedFixture("1737900011.m4a");
      const fetchMock = downloadThenAcceptAllJobsFetchMock("1737900011.m4a", false);
      globalThis.fetch = fetchMock;

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();

      await continueImport(upload, "https://example.com/track/abc", {});
      await upload.reload();

      expect(upload.mediaType).toBe("audio");
      // No audio transcode profiles configured by default, but a thumbnail
      // job (embedded-art extraction) is still sent alongside /download.
      // Nothing embed-related is enqueued eagerly - only a reported failure
      // from that thumbnail job (see /internal/thumbnails/:uploadUuid/failed)
      // would fall back to the placeholder embed video.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const payload = JSON.parse(String(fetchMock.mock.calls[1][1].body));
      expect(payload.jobs).toHaveLength(1);
      expect(payload.jobs[0].kind).toBe("thumbnail");
    });

    test("trusts hasVideo: true over an ambiguous container extension", async () => {
      // A .webm can be video or audio-only; hasVideo: true should win over
      // any extension-based guess.
      writeDownloadedFixture("1737900012.webm");
      const fetchMock = downloadThenAcceptAllJobsFetchMock("1737900012.webm", true);
      globalThis.fetch = fetchMock;

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();

      await continueImport(upload, "https://example.com/watch?v=abc", {});
      await upload.reload();

      expect(upload.mediaType).toBe("video");
    });

    test("falls back to extension-based classification when hasVideo is absent", async () => {
      writeDownloadedFixture("1737900013.mp3");
      const fetchMock = downloadThenAcceptAllJobsFetchMock("1737900013.mp3");
      globalThis.fetch = fetchMock;

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();

      await continueImport(upload, "https://example.com/track/abc", {});
      await upload.reload();

      expect(upload.mediaType).toBe("audio");
    });

    test("forwards thumbnailTimestamp to processing as seconds", async () => {
      writeDownloadedFixture("1737900014.mp4");
      const fetchMock = downloadThenAcceptAllJobsFetchMock("1737900014.mp4");
      globalThis.fetch = fetchMock;

      await seedUploaderCreds();
      // Mirrors what importVideo persists on the placeholder row up front —
      // thumbnailTimestampTenths is set at creation time, before the download.
      const upload = await seedDownloadingUpload({ thumbnailTimestampTenths: 123 });

      await continueImport(upload, "https://example.com/watch?v=abc", {});

      const transcodeCall = fetchMock.mock.calls.find(
        (call) => call[0] === "http://processing.test:3001/transcode",
      );
      const payload = JSON.parse(String(transcodeCall[1].body));
      expect(payload.jobs[0].timestampSeconds).toBe(12.3);
    });

    test("skipThumbnail omits the thumbnail job, keeping any rendition jobs", async () => {
      await seedTranscodeProfile({ resolutionName: "720p", mediaType: "video" });
      writeDownloadedFixture("1737900015.mp4");
      const fetchMock = downloadThenAcceptAllJobsFetchMock("1737900015.mp4");
      globalThis.fetch = fetchMock;

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();

      await continueImport(upload, "https://example.com/watch?v=abc", { skipThumbnail: true });

      const transcodeCall = fetchMock.mock.calls.find(
        (call) => call[0] === "http://processing.test:3001/transcode",
      );
      const payload = JSON.parse(String(transcodeCall[1].body));
      expect(payload.jobs.every((job) => job.kind !== "thumbnail")).toBe(true);
      expect(payload.jobs).toHaveLength(1);
    });

    test("batch-enqueues jobs and creates pending FILE_VERSIONS", async () => {
      writeDownloadedFixture("1737900016.mp4");
      const profile = await seedTranscodeProfile({
        outputHeight: 720,
        outputWidth: 1280,
        outputContainer: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
      });

      const fetchMock = downloadThenAcceptAllJobsFetchMock("1737900016.mp4");
      globalThis.fetch = fetchMock;

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();

      await continueImport(upload, "https://example.com/watch?v=xyz", {});
      await upload.reload();

      expect(upload.status).toBe("processing");
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const transcodeCall = fetchMock.mock.calls.find(
        (call) => call[0] === "http://processing.test:3001/transcode",
      );
      const payload = JSON.parse(String(transcodeCall[1].body));
      expect(payload.filename).toBe(`${userStorageSegment(upload.userId)}/${upload.uuid}.mp4`);
      // One thumbnail job + one job for the rendition profile.
      expect(payload.jobs).toHaveLength(2);
      const renditionJob = payload.jobs.find((j) => j.kind === "rendition");
      expect(renditionJob.profile.id).toBe(profile.id);

      const versionRows = await queryRows(
        "SELECT * FROM FILE_VERSIONS WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(versionRows).toHaveLength(1);
      expect(versionRows[0].status).toBe("processing");
    });

    test("rolls back the placeholder row when processing fails to download", async () => {
      globalThis.fetch = jest.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ success: false, error: "yt-dlp failed" }),
      }));

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();

      await continueImport(upload, "https://example.com/watch?v=abc", {});

      expect(await OriginalUpload.findByPk(upload.id)).toBeNull();
      const metadataRows = await queryRows(
        "SELECT * FROM VIDEO_METADATA WHERE original_upload_id = :id",
        { id: upload.id },
      );
      expect(metadataRows).toHaveLength(0);
    });

    test("rolls back the placeholder row when processing is unreachable", async () => {
      globalThis.fetch = jest.fn(async () => {
        throw new Error("fetch failed");
      });

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();

      await continueImport(upload, "https://example.com/watch?v=abc", {});

      expect(await OriginalUpload.findByPk(upload.id)).toBeNull();
    });

    test("rolls back the placeholder row when the downloaded file is missing on disk", async () => {
      // No fixture written: processing claims success but the file isn't there.
      globalThis.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, filename: "does-not-exist.mp4" }),
      }));

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();

      await continueImport(upload, "https://example.com/watch?v=abc", {});

      expect(await OriginalUpload.findByPk(upload.id)).toBeNull();
    });

    test("unlinks the downloaded source file when storing it under the uuid fails", async () => {
      // Written under the epoch-style name processing would have used, but
      // never renamed to <segment>/<uuid>.<ext> since a directory already
      // occupies that exact path.
      writeDownloadedFixture("1737900020.mp4");
      globalThis.fetch = jest.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ success: true, filename: "1737900020.mp4" }),
      }));

      await seedUploaderCreds();
      const upload = await seedDownloadingUpload();
      // Pre-create a directory at the rename target so fs.rename fails
      // (EISDIR/EPERM), exercising the storage-failure branch.
      mkdirSync(
        join(originalDir, userStorageSegment(upload.userId), `${upload.uuid}.mp4`),
        { recursive: true },
      );

      await continueImport(upload, "https://example.com/watch?v=abc", {});

      expect(await OriginalUpload.findByPk(upload.id)).toBeNull();
      expect(existsSync(join(originalDir, "1737900020.mp4"))).toBe(false);
    });

    test("stores the file under the _unowned fallback folder when userId is null", async () => {
      writeDownloadedFixture("1737900021.mp4");
      const fetchMock = downloadThenAcceptAllJobsFetchMock("1737900021.mp4");
      globalThis.fetch = fetchMock;

      const upload = await seedDownloadingUpload({ userId: null });

      await continueImport(upload, "https://example.com/watch?v=abc", {});
      await upload.reload();

      expect(upload.storagePath).toBe(`original/_unowned/${upload.uuid}.mp4`);
      expect(existsSync(join(originalDir, "_unowned", `${upload.uuid}.mp4`))).toBe(true);
    });
  });
});

describe("GET /videos/:id/processing-status", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {{id: number} & Record<string, unknown>} */
  let owner;
  const ownerKey = "jt_test_processing_status_owner_key";

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  afterEach(async () => {
    await resetTables();
  });

  async function seedOwner() {
    owner = await seedUser({ uploader: true, emailVerified: true });
    await seedUserApiKey(owner.id, ownerKey);
  }

  test("returns status, statusMessage, and file-version summaries for the owner", async () => {
    await seedOwner();
    const seeded = await seedUpload({
      userId: owner.id,
      status: "failed",
      statusMessage: "The processing service rejected the URL.",
    });

    const res = await client
      .get(`/api/v1/videos/${seeded.id}/processing-status`)
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "failed",
      statusMessage: "The processing service rejected the URL.",
      fileVersions: [],
      outstandingJobs: [],
      jobsRemaining: 0,
      jobsStatusUnknown: false,
    });
  });

  test("returns 403 for a user who doesn't own the upload", async () => {
    await seedOwner();
    const seeded = await seedUpload({ userId: owner.id });

    const other = await seedUser({ uploader: true, emailVerified: true });
    await seedUserApiKey(other.id, "jt_test_processing_status_other_key");

    const res = await client
      .get(`/api/v1/videos/${seeded.id}/processing-status`)
      .set("Authorization", "Bearer jt_test_processing_status_other_key");

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("returns 404 for a missing upload id", async () => {
    await seedOwner();

    const res = await client
      .get("/api/v1/videos/999999/processing-status")
      .set("Authorization", `Bearer ${ownerKey}`);

    expect(res.status).toBe(404);
  });

  test("requires authentication", async () => {
    await seedOwner();
    const seeded = await seedUpload({ userId: owner.id });

    const res = await client.get(`/api/v1/videos/${seeded.id}/processing-status`);

    expect(res.status).toBe(401);
  });
});
