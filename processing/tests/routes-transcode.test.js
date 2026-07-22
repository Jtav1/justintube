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
 * @returns {import('express').Express} App mounted at `/transcode`.
 */
function createTestApp(queue) {
  const app = express();
  app.use(express.json());
  app.use("/transcode", createTranscodeRouter({ queue }));
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
});
