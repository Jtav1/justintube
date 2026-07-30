import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";

const mockDownloadUrl = jest.fn();

// Must run before any import of routes/download.js (which imports
// lib/download.js statically) - mock registration has to precede the
// dynamic import below under native ESM.
jest.unstable_mockModule("../lib/download.js", () => ({
  DownloadValidationError: class DownloadValidationError extends Error {},
  downloadUrl: mockDownloadUrl,
}));

const { createDownloadRouter } = await import("../routes/download.js");
const { DownloadValidationError } = await import("../lib/download.js");

/**
 * Builds a minimal Express app mounting the download router for route
 * contract tests.
 *
 * @returns {import('express').Express} App mounted at `/download`.
 */
function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use("/download", createDownloadRouter());
  return app;
}

describe("POST /download", () => {
  afterEach(() => {
    mockDownloadUrl.mockReset();
  });

  test("passes through hasVideo: true for a video download", async () => {
    mockDownloadUrl.mockResolvedValue({ filename: "123.mp4", hasVideo: true });

    const res = await request(createTestApp())
      .post("/download")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, filename: "123.mp4", hasVideo: true });
  });

  test("passes through hasVideo: false for an audio-only download", async () => {
    mockDownloadUrl.mockResolvedValue({ filename: "123.m4a", hasVideo: false });

    const res = await request(createTestApp())
      .post("/download")
      .send({ url: "https://example.com/track/abc" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, filename: "123.m4a", hasVideo: false });
  });

  test("returns 400 on a validation error", async () => {
    mockDownloadUrl.mockRejectedValue(new DownloadValidationError("url is required"));

    const res = await request(createTestApp()).post("/download").send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("returns 500 on a generic download failure", async () => {
    mockDownloadUrl.mockRejectedValue(new Error("yt-dlp failed"));

    const res = await request(createTestApp())
      .post("/download")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "yt-dlp failed" });
  });
});
