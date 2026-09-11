import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";
import { createQueueRouter } from "../routes/queue.js";

/**
 * Builds a minimal Express app with a mocked queue for route contract tests.
 *
 * @param {object} queue Mock BullMQ queue surface used by the router.
 * @returns {import('express').Express} App mounted at `/queue`.
 */
function createTestApp(queue) {
  const app = express();
  app.use(express.json());
  app.use("/queue", createQueueRouter({ queue }));
  return app;
}

describe("GET /queue/jobs", () => {
  test("returns the non-terminal job list from getQueueJobs", async () => {
    const queue = {
      getJobs: jest.fn((states) => {
        if (states[0] === "waiting") {
          return Promise.resolve([{ id: "w1", name: "ffmpeg-transcode", data: { kind: "rendition" } }]);
        }
        return Promise.resolve([]);
      }),
    };
    const app = createTestApp(queue);

    const res = await request(app).get("/queue/jobs");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      jobs: [{ jobId: "w1", kind: "rendition", name: "ffmpeg-transcode", state: "waiting", truncated: false }],
    });
  });

  test("returns 500 when the queue lookup throws", async () => {
    const queue = {
      getJobs: jest.fn().mockRejectedValue(new Error("redis unavailable")),
    };
    const app = createTestApp(queue);

    const res = await request(app).get("/queue/jobs");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe("GET /queue/history", () => {
  test("returns a paginated history page, defaulting limit to 5", async () => {
    const queue = {
      getJobs: jest.fn().mockResolvedValue([]),
      getJobCounts: jest.fn().mockResolvedValue({ completed: 0, failed: 0 }),
    };
    const app = createTestApp(queue);

    const res = await request(app).get("/queue/history");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, items: [], total: 0, page: 1, limit: 5 });
  });

  test("honors explicit page/limit query params", async () => {
    const queue = {
      getJobs: jest.fn().mockResolvedValue([]),
      getJobCounts: jest.fn().mockResolvedValue({ completed: 0, failed: 0 }),
    };
    const app = createTestApp(queue);

    const res = await request(app).get("/queue/history?page=2&limit=10");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 2, limit: 10 });
  });

  test("returns 400 for an invalid page", async () => {
    const queue = { getJobs: jest.fn(), getJobCounts: jest.fn() };
    const app = createTestApp(queue);

    const res = await request(app).get("/queue/history?page=0");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(queue.getJobs).not.toHaveBeenCalled();
  });

  test("returns 400 for a limit above the max", async () => {
    const queue = { getJobs: jest.fn(), getJobCounts: jest.fn() };
    const app = createTestApp(queue);

    const res = await request(app).get("/queue/history?limit=1000");

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("returns 500 when the queue lookup throws", async () => {
    const queue = {
      getJobs: jest.fn().mockRejectedValue(new Error("redis unavailable")),
      getJobCounts: jest.fn(),
    };
    const app = createTestApp(queue);

    const res = await request(app).get("/queue/history");

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});
