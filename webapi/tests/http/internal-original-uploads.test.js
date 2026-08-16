import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { DuplicateUploadFlag, FileVersion, Notification, OriginalUpload, Role } from "../../lib/models/index.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedMetadata,
  seedTranscodeProfile,
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

/**
 * HTTP tests for processing -> API FILETYPES_CONVERTIBLE normalize-job
 * callbacks. Unlike the hash callbacks above, `normalize-complete` finishes
 * work the upload response deferred at request time: it replaces the raw
 * source's metadata with the normalized H.264/AAC MP4 (or M4A) output and
 * only then runs `finalizeUploadTranscodes` (rendition/thumbnail enqueue),
 * so a real (mocked) processing round-trip happens inside these tests too.
 */
describe("POST /internal/original-uploads/:jobId/normalize-complete and normalize-failed", () => {
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

  /**
   * Builds a `fetch` mock that answers `POST /transcode` by accepting every
   * job in the request unconditionally, mirroring the shape
   * `finalizeUploadTranscodes` sends.
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

  test("rejects missing bearer token", async () => {
    const upload = await seedUpload({ status: "converting" });
    const res = await client
      .post(`/internal/original-uploads/normalize-${upload.videoId}/normalize-complete`)
      .send({ storagePath: `original/${upload.videoId}.mp4`, fileExtension: "mp4" });
    expect(res.status).toBe(401);
  });

  test("returns 400 for a malformed jobId", async () => {
    const res = await client
      .post("/internal/original-uploads/not-a-normalize-job/normalize-complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ storagePath: "original/abc123.mp4", fileExtension: "mp4" });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_job_id");
  });

  test("returns 400 when storagePath/fileExtension are missing", async () => {
    const upload = await seedUpload({ status: "converting" });
    const res = await client
      .post(`/internal/original-uploads/normalize-${upload.videoId}/normalize-complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_body");
  });

  test("returns 404 for an unknown videoId", async () => {
    const res = await client
      .post("/internal/original-uploads/normalize-zzzzzz/normalize-complete")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ storagePath: "original/zzzzzz.mp4", fileExtension: "mp4" });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("replaces the raw source's metadata and runs finalizeUploadTranscodes against the normalized file", async () => {
    globalThis.fetch = acceptAllJobsFetchMock();

    const upload = await seedUpload({
      status: "converting",
      fileExtension: "mov",
      mimeType: "video/quicktime",
      storagePath: `original/${generateOldStoragePathSuffix()}`,
      skipThumbnail: false,
    });
    await seedMetadata(upload.id);
    const profile = await seedTranscodeProfile({ outputHeight: 480, outputWidth: 854 });

    const res = await client
      .post(`/internal/original-uploads/normalize-${upload.videoId}/normalize-complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({
        storagePath: `original/${upload.videoId}.mp4`,
        fileExtension: "mp4",
        mimeType: "video/mp4",
        videoWidth: 1920,
        videoHeight: 1080,
        resolution: "1080p",
        fileSizeBytes: 999,
      });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, videoId: upload.videoId });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.fileExtension).toBe("mp4");
    expect(reloaded.mimeType).toBe("video/mp4");
    expect(reloaded.storagePath).toBe(`original/${upload.videoId}.mp4`);
    expect(reloaded.videoWidth).toBe(1920);
    expect(reloaded.status).not.toBe("converting");
    expect(reloaded.statusMessage).toBeNull();

    // finalizeUploadTranscodes ran against the normalized file: a FILE_VERSIONS
    // row was created for the seeded profile and the batch request targeted
    // the new .mp4 filename, not the original .mov source.
    const versions = await FileVersion.findAll({ where: { originalUploadId: upload.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].transcodeProfileId).toBe(profile.id);

    const renditionCall = globalThis.fetch.mock.calls.find((call) => {
      const body = JSON.parse(String(call[1].body));
      return body.filename === `${upload.videoId}.mp4`;
    });
    expect(renditionCall).toBeDefined();
  });

  test("honors a persisted skipThumbnail=true when finalizing", async () => {
    globalThis.fetch = acceptAllJobsFetchMock();

    const upload = await seedUpload({
      status: "converting",
      fileExtension: "mov",
      storagePath: `original/${generateOldStoragePathSuffix()}`,
      skipThumbnail: true,
    });
    await seedMetadata(upload.id);
    // Without a matching profile, skipThumbnail=true would leave zero jobs to
    // enqueue at all (finalizeUploadTranscodes skips the processing
    // round-trip entirely) - seed one so there's a rendition job to inspect.
    await seedTranscodeProfile({ outputHeight: 360, outputWidth: 640 });

    await client
      .post(`/internal/original-uploads/normalize-${upload.videoId}/normalize-complete`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ storagePath: `original/${upload.videoId}.mp4`, fileExtension: "mp4" });

    const payload = JSON.parse(String(globalThis.fetch.mock.calls[0][1].body));
    expect(payload.jobs.every((job) => job.kind !== "thumbnail")).toBe(true);
  });

  test("normalize-failed marks the upload failed without touching its file metadata", async () => {
    const upload = await seedUpload({
      status: "converting",
      fileExtension: "mov",
      storagePath: `original/${generateOldStoragePathSuffix()}`,
    });
    await seedMetadata(upload.id);

    const res = await client
      .post(`/internal/original-uploads/normalize-${upload.videoId}/normalize-failed`)
      .set("Authorization", `Bearer ${TOKEN}`)
      .send({ error: "ffmpeg exited with code 1" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, videoId: upload.videoId, status: "failed" });

    const reloaded = await OriginalUpload.findByPk(upload.id);
    expect(reloaded.status).toBe("failed");
    expect(reloaded.statusMessage).toBe("ffmpeg exited with code 1");
    // The raw source file's metadata is left exactly as it was pre-normalize.
    expect(reloaded.fileExtension).toBe("mov");
  });
});

/**
 * Builds a unique basename for a fake pre-normalize raw upload file, so
 * seeded uploads in the normalize-complete/failed tests don't collide on
 * `storagePath` with each other.
 *
 * @returns {string} A unique `<random>.mov` basename.
 */
function generateOldStoragePathSuffix() {
  return `${Math.random().toString(36).slice(2)}.mov`;
}
