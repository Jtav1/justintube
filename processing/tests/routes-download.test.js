import { jest } from "@jest/globals";
import express from "express";
import request from "supertest";

const mockDownloadUrl = jest.fn();
const mockDownloadAudioOnly = jest.fn();
const mockDownloadFormat = jest.fn();
const mockProbeUrl = jest.fn();
const mockProbePlaylist = jest.fn();
const mockDownloadPlaylist = jest.fn();

// Must run before any import of routes/download.js (which imports
// lib/download.js statically) - mock registration has to precede the
// dynamic import below under native ESM.
jest.unstable_mockModule("../lib/download.js", () => ({
  DownloadValidationError: class DownloadValidationError extends Error {},
  downloadUrl: mockDownloadUrl,
  downloadAudioOnly: mockDownloadAudioOnly,
  downloadFormat: mockDownloadFormat,
  probeUrl: mockProbeUrl,
  probePlaylist: mockProbePlaylist,
  downloadPlaylist: mockDownloadPlaylist,
  parseYtDlpOptions: (body) => ({
    cookies: body?.cookies,
    rateLimit: body?.rateLimit,
    retries: body?.retries,
  }),
  validateOptionalLimit: (value) => (value === undefined ? undefined : value),
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
    mockDownloadAudioOnly.mockReset();
    mockDownloadFormat.mockReset();
    mockProbeUrl.mockReset();
    mockProbePlaylist.mockReset();
    mockDownloadPlaylist.mockReset();
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

describe("POST /download/audio", () => {
  afterEach(() => {
    mockDownloadAudioOnly.mockReset();
  });

  test("returns the saved audio filename on success", async () => {
    mockDownloadAudioOnly.mockResolvedValue({ filename: "123.m4a" });

    const res = await request(createTestApp())
      .post("/download/audio")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, filename: "123.m4a" });
  });

  test("passes audioFormat through to downloadAudioOnly", async () => {
    mockDownloadAudioOnly.mockResolvedValue({ filename: "123.mp3" });

    const res = await request(createTestApp())
      .post("/download/audio")
      .send({ url: "https://example.com/watch?v=abc", audioFormat: "mp3" });

    expect(res.status).toBe(200);
    expect(mockDownloadAudioOnly).toHaveBeenCalledWith(
      "https://example.com/watch?v=abc",
      expect.objectContaining({ audioFormat: "mp3" }),
    );
  });

  test("returns 400 on a validation error", async () => {
    mockDownloadAudioOnly.mockRejectedValue(new DownloadValidationError("url is required"));

    const res = await request(createTestApp()).post("/download/audio").send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("returns 500 on a generic download failure", async () => {
    mockDownloadAudioOnly.mockRejectedValue(new Error("yt-dlp failed"));

    const res = await request(createTestApp())
      .post("/download/audio")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "yt-dlp failed" });
  });
});

describe("POST /download/format", () => {
  afterEach(() => {
    mockDownloadFormat.mockReset();
  });

  test("passes url/formatId through and returns the saved filename", async () => {
    mockDownloadFormat.mockResolvedValue({ filename: "123.mp4", hasVideo: true });

    const res = await request(createTestApp())
      .post("/download/format")
      .send({ url: "https://example.com/watch?v=abc", formatId: "137" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, filename: "123.mp4", hasVideo: true });
    expect(mockDownloadFormat).toHaveBeenCalledWith(
      "https://example.com/watch?v=abc",
      "137",
      expect.any(Object),
    );
  });

  test("returns 400 with a probe-first message when the format isn't available", async () => {
    mockDownloadFormat.mockRejectedValue(
      new DownloadValidationError(
        'formatId "999" is not currently available for this URL — call POST /download/probe first to determine valid formats',
      ),
    );

    const res = await request(createTestApp())
      .post("/download/format")
      .send({ url: "https://example.com/watch?v=abc", formatId: "999" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/POST \/download\/probe/);
  });

  test("returns 400 on a missing formatId", async () => {
    mockDownloadFormat.mockRejectedValue(
      new DownloadValidationError("formatId is required and must be a string"),
    );

    const res = await request(createTestApp())
      .post("/download/format")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("returns 500 on a generic download failure", async () => {
    mockDownloadFormat.mockRejectedValue(new Error("yt-dlp failed"));

    const res = await request(createTestApp())
      .post("/download/format")
      .send({ url: "https://example.com/watch?v=abc", formatId: "137" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "yt-dlp failed" });
  });
});

describe("POST /download/probe", () => {
  afterEach(() => {
    mockProbeUrl.mockReset();
  });

  test("returns mapped metadata on success", async () => {
    mockProbeUrl.mockResolvedValue({ title: "Some video", formats: [] });

    const res = await request(createTestApp())
      .post("/download/probe")
      .send({ url: "https://example.com/watch?v=abc" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, title: "Some video", formats: [] });
  });

  test("returns 400 on a validation error", async () => {
    mockProbeUrl.mockRejectedValue(new DownloadValidationError("url is required"));

    const res = await request(createTestApp()).post("/download/probe").send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /download/playlist/probe", () => {
  afterEach(() => {
    mockProbePlaylist.mockReset();
  });

  test("returns enumerated entries on success", async () => {
    mockProbePlaylist.mockResolvedValue({
      playlistTitle: "My playlist",
      playlistId: "pl1",
      entryCount: 1,
      truncated: false,
      entries: [{ url: "https://example.com/watch?v=abc", title: "Video 1" }],
    });

    const res = await request(createTestApp())
      .post("/download/playlist/probe")
      .send({ url: "https://example.com/playlist?list=pl1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.entries).toHaveLength(1);
  });

  test("returns 400 on a validation error", async () => {
    mockProbePlaylist.mockRejectedValue(new DownloadValidationError("url is required"));

    const res = await request(createTestApp()).post("/download/playlist/probe").send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe("POST /download/playlist", () => {
  afterEach(() => {
    mockDownloadPlaylist.mockReset();
  });

  test("returns per-entry results on success", async () => {
    mockDownloadPlaylist.mockResolvedValue({
      playlistTitle: "My playlist",
      playlistId: "pl1",
      total: 1,
      succeeded: 1,
      failed: 0,
      results: [
        { url: "https://example.com/watch?v=abc", title: "Video 1", success: true, filename: "1.mp4", hasVideo: true },
      ],
    });

    const res = await request(createTestApp())
      .post("/download/playlist")
      .send({ url: "https://example.com/playlist?list=pl1" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      playlistTitle: "My playlist",
      playlistId: "pl1",
      total: 1,
      succeeded: 1,
      failed: 0,
      results: [
        { url: "https://example.com/watch?v=abc", title: "Video 1", success: true, filename: "1.mp4", hasVideo: true },
      ],
    });
  });

  test("returns 400 on a validation error", async () => {
    mockDownloadPlaylist.mockRejectedValue(new DownloadValidationError("url is required"));

    const res = await request(createTestApp()).post("/download/playlist").send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test("returns 500 on a generic failure", async () => {
    mockDownloadPlaylist.mockRejectedValue(new Error("yt-dlp failed"));

    const res = await request(createTestApp())
      .post("/download/playlist")
      .send({ url: "https://example.com/playlist?list=pl1" });

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ success: false, error: "yt-dlp failed" });
  });
});
