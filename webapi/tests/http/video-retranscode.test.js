import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { mediaDir } from "../../lib/media-meta.js";
import { createTestClient } from "../helpers/app.js";
import {
  resetTables,
  seedFileVersion,
  seedMetadata,
  seedTranscodeProfile,
  seedUpload,
  seedUser,
  seedUserApiKey,
  setupSchema,
} from "../helpers/db.js";
import { FileVersion, OriginalUpload, Role, TranscodeProfile } from "../../lib/models/index.js";

/**
 * Writes a fixture file under the test media root at a given relative storage
 * path, creating parent directories as needed. Mirrors the identical helper
 * in videos.test.js / video-thumbnail-regenerate.test.js.
 *
 * @param {string} relativeStoragePath Path relative to `mediaDir`.
 * @param {Buffer} contents File contents to write.
 * @returns {string} The absolute path the file was written to.
 */
function writeMediaFixture(relativeStoragePath, contents) {
  const absolutePath = join(mediaDir, relativeStoragePath);
  mkdirSync(join(absolutePath, ".."), { recursive: true });
  writeFileSync(absolutePath, contents);
  return absolutePath;
}

/**
 * Builds a `fetch` mock that accepts both the `DELETE /transcode/:jobId`
 * cancellation calls (best-effort, made for each previous rendition) and the
 * batch `POST /transcode` enqueue call, optionally marking some of the
 * batch's jobIds as skipped (profile exceeds source resolution).
 *
 * @param {{ skippedJobIds?: string[] }} [options]
 * @returns {jest.Mock}
 */
function acceptJobFetchMock({ skippedJobIds = [] } = {}) {
  return jest.fn(async (url, options) => {
    if (!String(url).endsWith("/transcode")) {
      // DELETE /transcode/:jobId (best-effort job cancellation) - no body.
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    }
    const body = JSON.parse(String(options.body));
    return {
      ok: true,
      status: 202,
      json: async () => ({
        success: true,
        jobs: body.jobs
          .filter((job) => !skippedJobIds.includes(job.jobId))
          .map((job) => ({ jobId: job.jobId, outputFilename: job.outputFilename })),
        skipped: body.jobs
          .filter((job) => skippedJobIds.includes(job.jobId))
          .map((job) => ({ jobId: job.jobId, reason: "profile_exceeds_source_resolution" })),
      }),
    };
  });
}

/**
 * Finds the batch `POST /transcode` call among a fetch mock's recorded
 * calls, distinguishing it from any `DELETE /transcode/:jobId` cancellation
 * calls made for previous renditions.
 *
 * @param {jest.Mock} fetchMock
 * @returns {{ filename: string, jobs: object[] }} Parsed request body.
 */
function findBatchEnqueueCall(fetchMock) {
  const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith("/transcode"));
  return JSON.parse(String(call[1].body));
}

/**
 * HTTP contract tests for `POST /videos/:id/retranscode` — an admin-only
 * action that deletes every existing FILE_VERSIONS rendition for a video up
 * front, then queues a fresh batch against its current TRANSCODE_PROFILES
 * rows.
 */
describe("POST /videos/:id/retranscode", () => {
  /** @type {ReturnType<typeof createTestClient>} */
  let client;
  /** @type {typeof fetch | undefined} */
  let originalFetch;
  /** @type {string} */
  let adminKey;

  beforeAll(async () => {
    await setupSchema();
    client = createTestClient();
  });

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    // The app seeds a handful of default "video" TRANSCODE_PROFILES rows on
    // boot (once, in beforeAll) - cleared here so each test starts from a
    // known, empty profile set regardless of run order within this file.
    await TranscodeProfile.destroy({ where: {} });
    const adminRole = await Role.findOne({ where: { name: "admin" } });
    const admin = await seedUser({ roleId: adminRole?.id ?? null, emailVerified: true });
    adminKey = `jt_test_${admin.id}_retranscode_key`;
    await seedUserApiKey(admin.id, adminKey);
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await resetTables();
  });

  /**
   * Seeds an owner user plus a video upload+metadata row they own.
   *
   * @param {object} [overrides] Passed through to seedUpload.
   * @returns {Promise<{ ownerId: number, uploadId: number }>}
   */
  async function seedOwnedVideo(overrides = {}) {
    const owner = await seedUser({ emailVerified: true });
    const upload = await seedUpload({ userId: owner.id, ...overrides });
    await seedMetadata(upload.id, { title: "Owned video" });
    return { ownerId: owner.id, uploadId: upload.id };
  }

  test("rejects an unauthenticated request", async () => {
    const { uploadId } = await seedOwnedVideo();
    const res = await client
      .post(`/api/v1/videos/${uploadId}/retranscode`)
      .set("Authorization", "Bearer jt_not_a_real_key")
      .send({});

    expect(res.status).toBe(401);
    expect(res.body.error).toBe("unauthorized");
  });

  test("rejects the video's own owner when not an admin", async () => {
    const owner = await seedUser({ emailVerified: true });
    const ownerKey = `jt_test_${owner.id}_retranscode_owner_key`;
    await seedUserApiKey(owner.id, ownerKey);
    const upload = await seedUpload({ userId: owner.id });
    await seedMetadata(upload.id, { title: "Owned video" });

    const res = await client
      .post(`/api/v1/videos/${upload.id}/retranscode`)
      .set("Authorization", `Bearer ${ownerKey}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error).toBe("forbidden");
  });

  test("returns 404 for an unknown video id", async () => {
    const res = await client
      .post("/api/v1/videos/999999/retranscode")
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body.error).toBe("not_found");
  });

  test("returns 400 invalid_state when no transcode profiles exist for this media type", async () => {
    const { uploadId } = await seedOwnedVideo();

    const res = await client
      .post(`/api/v1/videos/${uploadId}/retranscode`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid_state");
  });

  test("creates fresh renditions and replaces the previous ones once queued", async () => {
    const { uploadId } = await seedOwnedVideo({ videoId: "retrvid1", fileExtension: "mp4" });
    const seededRow = await OriginalUpload.findByPk(uploadId);
    const profile = await seedTranscodeProfile({ resolutionName: "720p", outputHeight: 720 });

    const oldVersion = await seedFileVersion(uploadId, {
      status: "complete",
      transcodeProfileId: profile.id,
      storagePath: "transcoded/old-version.mp4",
    });
    const oldFilePath = writeMediaFixture(oldVersion.storagePath, Buffer.from("old"));

    const fetchMock = acceptJobFetchMock();
    globalThis.fetch = fetchMock;

    const res = await client
      .post(`/api/v1/videos/${uploadId}/retranscode`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ success: true });

    // One DELETE /transcode/:jobId (cancelling the old rendition's job) plus
    // the batch POST /transcode enqueue.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const payload = findBatchEnqueueCall(fetchMock);
    expect(payload.filename).toBe(seededRow.storagePath.replace(/^original\//, ""));
    expect(payload.jobs).toHaveLength(1);
    expect(payload.jobs[0]).toMatchObject({ kind: "rendition", profile: { id: profile.id } });

    // The old rendition (row + file) is gone...
    expect(await FileVersion.findByPk(oldVersion.id)).toBeNull();
    expect(existsSync(oldFilePath)).toBe(false);

    // ...replaced by exactly one new, in-flight rendition for the profile.
    const remaining = await FileVersion.findAll({ where: { originalUploadId: uploadId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].transcodeProfileId).toBe(profile.id);
    expect(remaining[0].status).toBe("processing");
    expect(remaining[0].id).not.toBe(oldVersion.id);

    const row = await OriginalUpload.findByPk(uploadId);
    expect(row.status).toBe("processing");
  });

  test("destroys the pending rendition when processing reports it skipped", async () => {
    const { uploadId } = await seedOwnedVideo();
    await seedTranscodeProfile({ resolutionName: "1080p", outputHeight: 1080 });

    // Skip every jobId the handler enqueues - a full skip is easiest to
    // assert deterministically without needing to know the fresh uuid ahead
    // of time.
    globalThis.fetch = jest.fn(async (_url, options) => {
      const body = JSON.parse(String(options.body));
      return {
        ok: true,
        status: 202,
        json: async () => ({
          success: true,
          jobs: [],
          skipped: body.jobs.map((job) => ({
            jobId: job.jobId,
            reason: "profile_exceeds_source_resolution",
          })),
        }),
      };
    });

    const res = await client
      .post(`/api/v1/videos/${uploadId}/retranscode`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(202);
    const remaining = await FileVersion.findAll({ where: { originalUploadId: uploadId } });
    expect(remaining).toHaveLength(0);
  });

  test("returns 502 when enqueueing fails, having already dropped the previous renditions", async () => {
    const { uploadId } = await seedOwnedVideo();
    const profile = await seedTranscodeProfile({ resolutionName: "480p", outputHeight: 480 });
    const oldVersion = await seedFileVersion(uploadId, {
      status: "complete",
      transcodeProfileId: profile.id,
      storagePath: "transcoded/kept-version.mp4",
    });
    const oldFilePath = writeMediaFixture(oldVersion.storagePath, Buffer.from("kept"));

    globalThis.fetch = jest.fn(async () => {
      throw new Error("network down");
    });

    const res = await client
      .post(`/api/v1/videos/${uploadId}/retranscode`)
      .set("Authorization", `Bearer ${adminKey}`)
      .send({});

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("processing_unavailable");

    // FILE_VERSIONS has a unique (originalUploadId, transcodeProfileId)
    // constraint, so the old rendition has to be deleted before a
    // replacement pending row for the same profile can even be created -
    // an enqueue failure after that point can't be rolled back to restore
    // it, and no orphaned pending row is left behind either.
    expect(existsSync(oldFilePath)).toBe(false);
    const remaining = await FileVersion.findAll({ where: { originalUploadId: uploadId } });
    expect(remaining).toHaveLength(0);
  });
});
