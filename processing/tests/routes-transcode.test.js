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
        opts: { jobId: res.body.jobId },
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
    });
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
          opts: { jobId: renditionJob.jobId },
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
          opts: { jobId: thumbnailJob.jobId },
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
});
