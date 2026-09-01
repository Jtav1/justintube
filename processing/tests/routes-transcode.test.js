import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { originalDir } from "../lib/media-paths.js";
import { createTranscodeRouter } from "../routes/transcode.js";

/**
 * Builds a minimal Express app with a mocked queue for route contract tests.
 *
 * @param {object} queue Mock BullMQ queue surface used by the router.
 * @param {object} [routerOptions] Extra options passed to createTranscodeRouter.
 * @returns {import('express').Express} App mounted at `/transcode`.
 */
function createTestApp(queue, routerOptions = {}) {
  const app = express();
  app.use(express.json());
  app.use("/transcode", createTranscodeRouter({ queue, ...routerOptions }));
  return app;
}

describe("POST /transcode and GET /transcode/:jobId", () => {
  const fixtureName = "route-test-clip.mp4";
  const fixturePath = join(originalDir, fixtureName);

  const profile = {
    id: 1,
    outputHeight: 720,
    outputWidth: 1280,
    outputContainer: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
    hardwareAccelerated: false,
  };

  beforeAll(() => {
    mkdirSync(originalDir, { recursive: true });
    writeFileSync(fixturePath, Buffer.from("fake-video"));
  });

  afterAll(() => {
    try {
      unlinkSync(fixturePath);
    } catch {
      // ignore missing fixture cleanup
    }
  });

  test("returns 400 when the body is invalid", async () => {
    const queue = {
      addBulk: jest.fn(),
      getJob: jest.fn(),
    };
    const app = createTestApp(queue);

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  test("queues a job and returns 202 with jobId and outputFilename", async () => {
    const queue = {
      addBulk: jest.fn().mockResolvedValue([{ id: "ignored" }]),
      getJob: jest.fn(),
    };
    const app = createTestApp(queue);

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName, profile });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(typeof res.body.jobId).toBe("string");
    expect(res.body.jobId.length).toBe(36);
    expect(res.body.outputFilename).toBe(`${res.body.jobId}.mp4`);
    expect(res.body.jobs).toHaveLength(1);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk).toHaveBeenCalledWith([
      {
        name: "ffmpeg-transcode",
        data: {
          inputFilename: fixtureName,
          outputFilename: res.body.outputFilename,
          kind: "rendition",
          profile,
        },
        opts: { jobId: res.body.jobId, priority: 3 },
      },
    ]);
  });

  test("queues a batch of jobs and returns 202 with jobs array", async () => {
    const queue = {
      addBulk: jest.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]),
      getJob: jest.fn(),
    };
    const app = createTestApp(queue);
    const jobA = {
      jobId: "11111111-1111-1111-1111-111111111111",
      outputFilename: "11111111-1111-1111-1111-111111111111.mp4",
      profile,
    };
    const jobB = {
      jobId: "22222222-2222-2222-2222-222222222222",
      outputFilename: "22222222-2222-2222-2222-222222222222.mp4",
      profile: { ...profile, id: 2, outputHeight: 480, outputWidth: 854 },
    };

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName, jobs: [jobA, jobB] });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.jobs).toEqual([
      {
        jobId: jobA.jobId,
        outputFilename: jobA.outputFilename,
        profileId: 1,
      },
      {
        jobId: jobB.jobId,
        outputFilename: jobB.outputFilename,
        profileId: 2,
      },
    ]);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
  });

  test("skips a hardware-accelerated profile when hardware transcoding is unavailable, queuing the rest of the batch", async () => {
    const queue = {
      addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
      getJob: jest.fn(),
    };
    const app = createTestApp(queue);
    const softwareJob = {
      jobId: "33333333-3333-3333-3333-333333333333",
      outputFilename: "33333333-3333-3333-3333-333333333333.mp4",
      profile,
    };
    const hardwareJob = {
      jobId: "44444444-4444-4444-4444-444444444444",
      outputFilename: "44444444-4444-4444-4444-444444444444.mp4",
      profile: {
        ...profile,
        id: 2,
        videoCodec: "h264_qsv",
        hardwareAccelerated: true,
      },
    };

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName, jobs: [softwareJob, hardwareJob] });

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.jobs).toEqual([
      {
        jobId: softwareJob.jobId,
        outputFilename: softwareJob.outputFilename,
        profileId: 1,
      },
    ]);
    expect(res.body.skipped).toEqual([
      {
        jobId: hardwareJob.jobId,
        profileId: 2,
        reason: "hardware_transcoding_unavailable",
      },
    ]);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
  });

  test("returns 400 when the input file is missing", async () => {
    const queue = {
      addBulk: jest.fn(),
      getJob: jest.fn(),
    };
    const app = createTestApp(queue);

    const res = await request(app)
      .post("/transcode")
      .send({ filename: "does-not-exist.mp4", profile });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not found/i);
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  test("returns 404 when the job id is unknown", async () => {
    const queue = {
      addBulk: jest.fn(),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const app = createTestApp(queue);

    const res = await request(app).get("/transcode/missing-id");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: "job not found",
    });
  });

  test("returns job status when the job exists", async () => {
    const queue = {
      addBulk: jest.fn(),
      getJob: jest.fn().mockResolvedValue({
        id: "job-1",
        progress: 40,
        data: {
          outputFilename: "job-1.mp4",
          profile: { id: 1 },
        },
        failedReason: null,
        returnvalue: null,
        getState: async () => "active",
      }),
    };
    const app = createTestApp(queue);

    const res = await request(app).get("/transcode/job-1");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      jobId: "job-1",
      state: "active",
      progress: 40,
      outputFilename: "job-1.mp4",
      profileId: 1,
    });
  });

  test("removes a job and returns 200", async () => {
    const remove = jest.fn().mockResolvedValue(undefined);
    const queue = {
      addBulk: jest.fn(),
      getJob: jest.fn().mockResolvedValue({
        id: "job-1",
        remove,
      }),
    };
    const app = createTestApp(queue);

    const res = await request(app).delete("/transcode/job-1");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      jobId: "job-1",
      removed: true,
    });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("returns 404 when deleting an unknown job", async () => {
    const queue = {
      addBulk: jest.fn(),
      getJob: jest.fn().mockResolvedValue(null),
    };
    const app = createTestApp(queue);

    const res = await request(app).delete("/transcode/missing-id");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: "job not found",
    });
  });

  test("skips profiles larger than the probed source resolution", async () => {
    const queue = {
      addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
      getJob: jest.fn(),
    };
    const probeInput = jest.fn(async () => ({
      videoWidth: 1280,
      videoHeight: 720,
    }));
    const app = createTestApp(queue, { probeInput });

    const job720 = {
      jobId: "11111111-1111-1111-1111-111111111111",
      outputFilename: "11111111-1111-1111-1111-111111111111.mp4",
      profile,
    };
    const job1080 = {
      jobId: "22222222-2222-2222-2222-222222222222",
      outputFilename: "22222222-2222-2222-2222-222222222222.mp4",
      profile: { ...profile, id: 2, outputHeight: 1080, outputWidth: 1920 },
    };

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName, jobs: [job720, job1080] });

    expect(res.status).toBe(202);
    expect(res.body.jobs).toEqual([
      {
        jobId: job720.jobId,
        outputFilename: job720.outputFilename,
        profileId: 1,
      },
    ]);
    expect(res.body.skipped).toEqual([
      {
        jobId: job1080.jobId,
        profileId: 2,
        reason: "profile_exceeds_source_resolution",
      },
    ]);
    expect(res.body.source).toEqual({
      videoWidth: 1280,
      videoHeight: 720,
      durationSeconds: null,
      hasVideoStream: null,
    });
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk.mock.calls[0][0]).toHaveLength(1);
  });

  test("reports source.hasVideoStream: true when a genuine (non-attached-pic) video stream is found", async () => {
    const queue = {
      addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
      getJob: jest.fn(),
    };
    const app = createTestApp(queue, { probeHasVideo: async () => true });

    const thumbnailJob = {
      jobId: "88888888-8888-8888-8888-888888888888",
      outputFilename: "88888888-8888-8888-8888-888888888888.webp",
      kind: "thumbnail",
      timestampSeconds: null,
    };

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName, jobs: [thumbnailJob] });

    expect(res.status).toBe(202);
    expect(res.body.source.hasVideoStream).toBe(true);
  });

  test("reports source.hasVideoStream: false for audio-only content, even with embedded cover art (attached_pic)", async () => {
    const queue = {
      addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
      getJob: jest.fn(),
    };
    const app = createTestApp(queue, { probeHasVideo: async () => false });

    const thumbnailJob = {
      jobId: "99999999-9999-9999-9999-999999999999",
      outputFilename: "99999999-9999-9999-9999-999999999999.webp",
      kind: "thumbnail",
      timestampSeconds: null,
    };

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName, jobs: [thumbnailJob] });

    expect(res.status).toBe(202);
    expect(res.body.source.hasVideoStream).toBe(false);
  });

  test("skips all rendition profiles when the source has no video stream, but not thumbnail jobs", async () => {
    const queue = {
      addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
      getJob: jest.fn(),
    };
    const probeInput = jest.fn(async () => ({
      videoWidth: null,
      videoHeight: null,
    }));
    const app = createTestApp(queue, { probeInput });

    const renditionJob = {
      jobId: "55555555-5555-5555-5555-555555555555",
      outputFilename: "55555555-5555-5555-5555-555555555555.mp4",
      profile,
    };
    const thumbnailJob = {
      jobId: "66666666-6666-6666-6666-666666666666",
      outputFilename: "66666666-6666-6666-6666-666666666666.webp",
      kind: "thumbnail",
      timestampSeconds: null,
    };

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName, jobs: [renditionJob, thumbnailJob] });

    expect(res.status).toBe(202);
    expect(res.body.jobs).toEqual([
      {
        jobId: thumbnailJob.jobId,
        outputFilename: thumbnailJob.outputFilename,
        profileId: null,
      },
    ]);
    expect(res.body.skipped).toEqual([
      {
        jobId: renditionJob.jobId,
        profileId: 1,
        reason: "source_has_no_video_stream",
      },
    ]);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk.mock.calls[0][0]).toHaveLength(1);
  });

  test("does not skip rendition profiles when the source probe itself fails (fails open)", async () => {
    const queue = {
      addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
      getJob: jest.fn(),
    };
    const probeInput = jest.fn(async () => {
      throw new Error("ffprobe exited with code 1");
    });
    const app = createTestApp(queue, { probeInput });

    const renditionJob = {
      jobId: "77777777-7777-7777-7777-777777777777",
      outputFilename: "77777777-7777-7777-7777-777777777777.mp4",
      profile,
    };

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName, jobs: [renditionJob] });

    expect(res.status).toBe(202);
    expect(res.body.skipped).toEqual([]);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk.mock.calls[0][0]).toHaveLength(1);
  });

  test("skips profiles whose orientation does not match the source", async () => {
    const queue = {
      addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
      getJob: jest.fn(),
    };
    const probeInput = jest.fn(async () => ({
      videoWidth: 1920,
      videoHeight: 1080,
    }));
    const app = createTestApp(queue, { probeInput });

    const horizontalJob = {
      jobId: "33333333-3333-3333-3333-333333333333",
      outputFilename: "33333333-3333-3333-3333-333333333333.mp4",
      profile,
    };
    const verticalJob = {
      jobId: "44444444-4444-4444-4444-444444444444",
      outputFilename: "44444444-4444-4444-4444-444444444444.mp4",
      profile: { ...profile, id: 2, outputHeight: 1080, outputWidth: 608 },
    };

    const res = await request(app)
      .post("/transcode")
      .send({ filename: fixtureName, jobs: [horizontalJob, verticalJob] });

    expect(res.status).toBe(202);
    expect(res.body.jobs).toEqual([
      {
        jobId: horizontalJob.jobId,
        outputFilename: horizontalJob.outputFilename,
        profileId: 1,
      },
    ]);
    expect(res.body.skipped).toEqual([
      {
        jobId: verticalJob.jobId,
        profileId: 2,
        reason: "profile_orientation_mismatch",
      },
    ]);
    expect(queue.addBulk).toHaveBeenCalledTimes(1);
    expect(queue.addBulk.mock.calls[0][0]).toHaveLength(1);
  });

  test("does not enqueue when every profile exceeds the source", async () => {
    const queue = {
      addBulk: jest.fn(),
      getJob: jest.fn(),
    };
    const app = createTestApp(queue, {
      probeInput: async () => ({ videoWidth: 640, videoHeight: 360 }),
    });

    const res = await request(app)
      .post("/transcode")
      .send({
        filename: fixtureName,
        jobs: [
          {
            jobId: "33333333-3333-3333-3333-333333333333",
            outputFilename: "33333333-3333-3333-3333-333333333333.mp4",
            profile,
          },
        ],
      });

    expect(res.status).toBe(202);
    expect(res.body.jobs).toEqual([]);
    expect(res.body.skipped).toHaveLength(1);
    expect(queue.addBulk).not.toHaveBeenCalled();
  });

  describe("thumbnail jobs", () => {
    test("enqueues a mixed batch of rendition and thumbnail jobs", async () => {
      const queue = {
        addBulk: jest.fn().mockResolvedValue([{ id: "a" }, { id: "b" }]),
        getJob: jest.fn(),
      };
      const app = createTestApp(queue);
      const renditionJob = {
        jobId: "11111111-1111-1111-1111-111111111111",
        outputFilename: "11111111-1111-1111-1111-111111111111.mp4",
        kind: "rendition",
        profile,
      };
      const thumbnailJob = {
        jobId: "22222222-2222-2222-2222-222222222222",
        outputFilename: "22222222-2222-2222-2222-222222222222.webp",
        kind: "thumbnail",
        timestampSeconds: 3,
      };

      const res = await request(app)
        .post("/transcode")
        .send({ filename: fixtureName, jobs: [renditionJob, thumbnailJob] });

      expect(res.status).toBe(202);
      expect(res.body.jobs).toEqual([
        { jobId: renditionJob.jobId, outputFilename: renditionJob.outputFilename, profileId: 1 },
        { jobId: thumbnailJob.jobId, outputFilename: thumbnailJob.outputFilename, profileId: null },
      ]);
      expect(queue.addBulk).toHaveBeenCalledTimes(1);
      expect(queue.addBulk).toHaveBeenCalledWith([
        {
          name: "ffmpeg-transcode",
          data: {
            inputFilename: fixtureName,
            outputFilename: renditionJob.outputFilename,
            kind: "rendition",
            profile,
          },
          opts: { jobId: renditionJob.jobId, priority: 3 },
        },
        {
          name: "ffmpeg-thumbnail",
          data: {
            inputFilename: fixtureName,
            outputFilename: thumbnailJob.outputFilename,
            kind: "thumbnail",
            // durationSeconds is null for this fake fixture (ffprobe fails
            // against non-video bytes), so the requested timestamp passes
            // through unchanged rather than being clamped/randomized.
            timestampSeconds: 3,
          },
          opts: { jobId: thumbnailJob.jobId, priority: 1 },
        },
      ]);
    });

    test("thumbnail jobs bypass the resolution skip check", async () => {
      const queue = {
        addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
        getJob: jest.fn(),
      };
      const probeInput = jest.fn(async () => ({ videoWidth: 320, videoHeight: 240 }));
      const app = createTestApp(queue, { probeInput });

      const thumbnailJob = {
        jobId: "33333333-3333-3333-3333-333333333333",
        outputFilename: "33333333-3333-3333-3333-333333333333.webp",
        kind: "thumbnail",
        timestampSeconds: null,
      };

      const res = await request(app)
        .post("/transcode")
        .send({ filename: fixtureName, jobs: [thumbnailJob] });

      expect(res.status).toBe(202);
      expect(res.body.skipped).toEqual([]);
      expect(res.body.jobs).toHaveLength(1);
      expect(queue.addBulk).toHaveBeenCalledTimes(1);
    });

    test("randomizes the timestamp when it exceeds the probed duration", async () => {
      const queue = {
        addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
        getJob: jest.fn(),
      };
      const app = createTestApp(queue, {
        probeDuration: async () => 10,
      });

      const thumbnailJob = {
        jobId: "44444444-4444-4444-4444-444444444444",
        outputFilename: "44444444-4444-4444-4444-444444444444.webp",
        kind: "thumbnail",
        timestampSeconds: 999,
      };

      const res = await request(app)
        .post("/transcode")
        .send({ filename: fixtureName, jobs: [thumbnailJob] });

      expect(res.status).toBe(202);
      const enqueued = queue.addBulk.mock.calls[0][0][0];
      expect(enqueued.data.timestampSeconds).not.toBe(999);
      expect(enqueued.data.timestampSeconds).toBeGreaterThanOrEqual(0);
      expect(enqueued.data.timestampSeconds).toBeLessThanOrEqual(10);
    });

    test("randomizes the timestamp when omitted", async () => {
      const queue = {
        addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
        getJob: jest.fn(),
      };
      const app = createTestApp(queue, {
        probeDuration: async () => 10,
      });

      const thumbnailJob = {
        jobId: "55555555-5555-5555-5555-555555555555",
        outputFilename: "55555555-5555-5555-5555-555555555555.webp",
        kind: "thumbnail",
        timestampSeconds: null,
      };

      const res = await request(app)
        .post("/transcode")
        .send({ filename: fixtureName, jobs: [thumbnailJob] });

      expect(res.status).toBe(202);
      const enqueued = queue.addBulk.mock.calls[0][0][0];
      expect(typeof enqueued.data.timestampSeconds).toBe("number");
      expect(enqueued.data.timestampSeconds).toBeGreaterThanOrEqual(0);
      expect(enqueued.data.timestampSeconds).toBeLessThanOrEqual(10);
    });
  });

  describe("hash jobs", () => {
    test("enqueues a duplicate-upload content-hash job with no outputFilename/profile", async () => {
      const queue = {
        addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
        getJob: jest.fn(),
      };
      const app = createTestApp(queue);
      const hashJob = { jobId: "hash-abc123", kind: "hash" };

      const res = await request(app)
        .post("/transcode")
        .send({ filename: fixtureName, jobs: [hashJob] });

      expect(res.status).toBe(202);
      expect(res.body.jobs).toEqual([
        { jobId: hashJob.jobId, outputFilename: undefined, profileId: null },
      ]);
      expect(queue.addBulk).toHaveBeenCalledWith([
        {
          name: "ffmpeg-hash",
          data: {
            inputFilename: fixtureName,
            outputFilename: undefined,
            kind: "hash",
            profile: undefined,
            timestampSeconds: undefined,
          },
          opts: { jobId: hashJob.jobId, priority: 4 },
        },
      ]);
    });

    test("a hash job is never skipped by the resolution/orientation/hardware checks", async () => {
      const queue = {
        addBulk: jest.fn().mockResolvedValue([{ id: "a" }]),
        getJob: jest.fn(),
      };
      const app = createTestApp(queue, {
        probeInput: async () => ({ videoWidth: 10, videoHeight: 10 }),
      });
      const hashJob = { jobId: "hash-tiny-source", kind: "hash" };

      const res = await request(app)
        .post("/transcode")
        .send({ filename: fixtureName, jobs: [hashJob] });

      expect(res.status).toBe(202);
      expect(res.body.skipped).toEqual([]);
      expect(queue.addBulk).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /transcode/retry-failed-hashes", () => {
    test("retries only failed jobs of kind hash, leaving other failed jobs alone", async () => {
      const hashJob = {
        id: "hash-a",
        data: { kind: "hash", runCount: 1 },
        retry: jest.fn().mockResolvedValue(),
      };
      const renditionJob = {
        id: "rendition-b",
        data: { kind: "rendition" },
        retry: jest.fn().mockResolvedValue(),
      };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([hashJob, renditionJob]),
      };
      const app = createTestApp(queue);

      const res = await request(app).post("/transcode/retry-failed-hashes");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        retried: ["hash-a"],
        discarded: [],
        failed: [],
      });
      expect(queue.getJobs).toHaveBeenCalledWith(["failed"]);
      expect(hashJob.retry).toHaveBeenCalledTimes(1);
      expect(renditionJob.retry).not.toHaveBeenCalled();
    });

    test("reports a per-job error without failing the whole request", async () => {
      const okJob = {
        id: "hash-ok",
        data: { kind: "hash", runCount: 2 },
        retry: jest.fn().mockResolvedValue(),
      };
      const badJob = {
        id: "hash-bad",
        data: { kind: "hash", runCount: 2 },
        retry: jest.fn().mockRejectedValue(new Error("job is not in a failed state")),
      };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([okJob, badJob]),
      };
      const app = createTestApp(queue);

      const res = await request(app).post("/transcode/retry-failed-hashes");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        retried: ["hash-ok"],
        discarded: [],
        failed: [{ jobId: "hash-bad", error: "job is not in a failed state" }],
      });
    });

    test("returns an empty result when there are no failed hash jobs", async () => {
      const queue = { getJobs: jest.fn().mockResolvedValue([]) };
      const app = createTestApp(queue);

      const res = await request(app).post("/transcode/retry-failed-hashes");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true, retried: [], discarded: [], failed: [] });
    });

    test("discards (instead of retrying) a hash job that has already reached the run cap", async () => {
      const maxedOutJob = {
        id: "hash-maxed",
        data: { kind: "hash", runCount: 7 },
        retry: jest.fn().mockResolvedValue(),
        remove: jest.fn().mockResolvedValue(),
      };
      const underCapJob = {
        id: "hash-under-cap",
        data: { kind: "hash", runCount: 6 },
        retry: jest.fn().mockResolvedValue(),
        remove: jest.fn().mockResolvedValue(),
      };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([maxedOutJob, underCapJob]),
      };
      const app = createTestApp(queue);

      const res = await request(app).post("/transcode/retry-failed-hashes");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        retried: ["hash-under-cap"],
        discarded: ["hash-maxed"],
        failed: [],
      });
      expect(maxedOutJob.remove).toHaveBeenCalledTimes(1);
      expect(maxedOutJob.retry).not.toHaveBeenCalled();
      expect(underCapJob.retry).toHaveBeenCalledTimes(1);
      expect(underCapJob.remove).not.toHaveBeenCalled();
    });

    test("reports an error when discarding a maxed-out job fails, without throwing", async () => {
      const maxedOutJob = {
        id: "hash-maxed-broken",
        data: { kind: "hash", runCount: 7 },
        retry: jest.fn().mockResolvedValue(),
        remove: jest.fn().mockRejectedValue(new Error("job locked")),
      };
      const queue = {
        getJobs: jest.fn().mockResolvedValue([maxedOutJob]),
      };
      const app = createTestApp(queue);

      const res = await request(app).post("/transcode/retry-failed-hashes");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        retried: [],
        discarded: [],
        failed: [{ jobId: "hash-maxed-broken", error: "job locked" }],
      });
    });
  });
});
