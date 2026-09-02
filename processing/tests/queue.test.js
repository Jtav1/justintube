import { jest } from "@jest/globals";
import { DelayedError } from "bullmq";

const computeContentHash = jest.fn();
const collectOutputMetadata = jest.fn();
const notifyContentHashComplete = jest.fn();
const notifyContentHashFailed = jest.fn();
const notifyThumbnailComplete = jest.fn();
const notifyThumbnailFailed = jest.fn();
const notifyEmbedVideoComplete = jest.fn();
const probeEmbeddedThumbnailStream = jest.fn();
const probeHasVideoStream = jest.fn();
const resolveThumbnailOutputPath = jest.fn();
const resolveThumbnailInputPath = jest.fn();
const resolveTranscodedOutputPath = jest.fn();
const buildThumbnailFfmpegArgs = jest.fn();
const buildEmbeddedThumbnailFfmpegArgs = jest.fn();
const buildEmbedFfmpegArgs = jest.fn();
const runFfmpeg = jest.fn();
const stat = jest.fn();

// Must run before any import of lib/queue.js (which imports these modules at
// load time) - mock registration has to precede the dynamic import below
// under native ESM.
jest.unstable_mockModule("../lib/probe.js", () => ({
  computeContentHash,
  collectOutputMetadata,
  probeStreamCodecs: jest.fn(),
  probeEmbeddedThumbnailStream,
  probeHasVideoStream,
}));
jest.unstable_mockModule("../lib/api-client.js", () => ({
  notifyContentHashComplete,
  notifyContentHashFailed,
  notifyFileVersionComplete: jest.fn(),
  notifyFileVersionFailed: jest.fn(),
  notifyThumbnailComplete,
  notifyThumbnailFailed,
  notifyOriginalUploadNormalizeComplete: jest.fn(),
  notifyOriginalUploadNormalizeFailed: jest.fn(),
  notifyEmbedVideoComplete,
  notifyEmbedVideoFailed: jest.fn(),
}));
jest.unstable_mockModule("../lib/media-paths.js", () => ({
  resolveOriginalInputPath: jest.fn((filename) => `/media/original/${filename}`),
  resolveThumbnailOutputPath,
  resolveThumbnailInputPath,
  resolveTranscodedOutputPath,
  resolveNormalizedOutputPath: jest.fn(),
}));
jest.unstable_mockModule("../lib/transcode.js", () => ({
  buildFfmpegArgs: jest.fn(),
  buildThumbnailFfmpegArgs,
  buildEmbeddedThumbnailFfmpegArgs,
  buildEmbedFfmpegArgs,
  buildNormalizeFfmpegArgs: jest.fn(),
  runFfmpeg,
}));
jest.unstable_mockModule("node:fs/promises", () => ({
  stat,
}));

const { processTranscodeJob, notifyTranscodeJobFailed, MAX_HASH_JOB_RUNS } = await import(
  "../lib/queue.js"
);

/**
 * Builds a fake BullMQ job for a "thumbnail" kind job.
 *
 * @param {object} [dataOverrides] Initial job.data overrides.
 * @returns {object} Fake job.
 */
function makeThumbnailJob(dataOverrides = {}) {
  return {
    id: "thumb-abc123",
    data: {
      kind: "thumbnail",
      inputFilename: "clip.mp3",
      outputFilename: "thumb-abc123.webp",
      timestampSeconds: 5,
      ...dataOverrides,
    },
    updateProgress: jest.fn().mockResolvedValue(undefined),
  };
}

describe("processTranscodeJob (kind: thumbnail) embedded art priority", () => {
  beforeEach(() => {
    probeEmbeddedThumbnailStream.mockReset();
    probeHasVideoStream.mockReset().mockResolvedValue(true);
    resolveThumbnailOutputPath.mockReset().mockImplementation((f) => `/media/thumbnails/${f}`);
    buildThumbnailFfmpegArgs.mockReset().mockReturnValue(["frame-grab-args"]);
    buildEmbeddedThumbnailFfmpegArgs.mockReset().mockReturnValue(["embedded-art-args"]);
    runFfmpeg.mockReset().mockResolvedValue(undefined);
    stat.mockReset().mockResolvedValue({ size: 1234 });
    notifyThumbnailComplete.mockReset().mockResolvedValue({ ok: true, status: 200, error: null });
    notifyThumbnailFailed.mockReset().mockResolvedValue({ ok: true, status: 200, error: null });
  });

  test("extracts embedded cover art instead of grabbing a frame when present", async () => {
    probeEmbeddedThumbnailStream.mockResolvedValue(2);
    const job = makeThumbnailJob();

    const result = await processTranscodeJob(job);

    expect(buildEmbeddedThumbnailFfmpegArgs).toHaveBeenCalledWith({
      inputPath: "/media/original/clip.mp3",
      outputPath: "/media/thumbnails/thumb-abc123.webp",
      streamIndex: 2,
    });
    expect(buildThumbnailFfmpegArgs).not.toHaveBeenCalled();
    expect(runFfmpeg).toHaveBeenCalledWith(["embedded-art-args"]);
    expect(result).toEqual({ outputFilename: "thumb-abc123.webp" });
  });

  test("falls back to a timestamped frame grab when no embedded art exists", async () => {
    probeEmbeddedThumbnailStream.mockResolvedValue(null);
    const job = makeThumbnailJob();

    await processTranscodeJob(job);

    expect(buildThumbnailFfmpegArgs).toHaveBeenCalledWith({
      inputPath: "/media/original/clip.mp3",
      outputPath: "/media/thumbnails/thumb-abc123.webp",
      timestampSeconds: 5,
    });
    expect(buildEmbeddedThumbnailFfmpegArgs).not.toHaveBeenCalled();
    expect(runFfmpeg).toHaveBeenCalledWith(["frame-grab-args"]);
  });

  test("falls back to a frame grab when the embedded-art probe itself fails", async () => {
    probeEmbeddedThumbnailStream.mockRejectedValue(new Error("ffprobe exited with code 1"));
    const job = makeThumbnailJob();

    await processTranscodeJob(job);

    expect(buildThumbnailFfmpegArgs).toHaveBeenCalled();
    expect(buildEmbeddedThumbnailFfmpegArgs).not.toHaveBeenCalled();
    expect(runFfmpeg).toHaveBeenCalledWith(["frame-grab-args"]);
  });

  test("skips the frame grab and resolves gracefully when the source has no video stream", async () => {
    probeEmbeddedThumbnailStream.mockResolvedValue(null);
    probeHasVideoStream.mockResolvedValue(false);
    const job = makeThumbnailJob();

    const result = await processTranscodeJob(job);

    expect(probeHasVideoStream).toHaveBeenCalledWith("/media/original/clip.mp3");
    expect(buildThumbnailFfmpegArgs).not.toHaveBeenCalled();
    expect(buildEmbeddedThumbnailFfmpegArgs).not.toHaveBeenCalled();
    expect(runFfmpeg).not.toHaveBeenCalled();
    expect(notifyThumbnailFailed).toHaveBeenCalledWith(
      "thumb-abc123",
      "source has no video stream",
    );
    expect(notifyThumbnailComplete).not.toHaveBeenCalled();
    expect(result).toEqual({ outputFilename: null, skipped: "no_video_stream" });
  });

  test("still attempts the frame grab when the video-stream probe itself fails", async () => {
    probeEmbeddedThumbnailStream.mockResolvedValue(null);
    probeHasVideoStream.mockRejectedValue(new Error("ffprobe exited with code 1"));
    const job = makeThumbnailJob();

    await processTranscodeJob(job);

    expect(buildThumbnailFfmpegArgs).toHaveBeenCalled();
    expect(runFfmpeg).toHaveBeenCalledWith(["frame-grab-args"]);
    expect(notifyThumbnailFailed).not.toHaveBeenCalled();
  });

  test("does not probe for a video stream when embedded art was already found", async () => {
    probeEmbeddedThumbnailStream.mockResolvedValue(2);
    const job = makeThumbnailJob();

    await processTranscodeJob(job);

    expect(probeHasVideoStream).not.toHaveBeenCalled();
  });
});

/**
 * Builds a fake BullMQ job for an "embed" kind job.
 *
 * @param {object} [dataOverrides] Initial job.data overrides.
 * @returns {object} Fake job.
 */
function makeEmbedJob(dataOverrides = {}) {
  return {
    id: "embed-abc123",
    data: {
      kind: "embed",
      inputFilename: "clip.mp3",
      thumbnailFilename: "42/cover.jpg",
      outputFilename: "42/embed-abc123.mp4",
      ...dataOverrides,
    },
    updateProgress: jest.fn().mockResolvedValue(undefined),
  };
}

describe("processTranscodeJob (kind: embed)", () => {
  beforeEach(() => {
    resolveThumbnailInputPath.mockReset().mockImplementation((f) => `/media/thumbnails/${f}`);
    resolveTranscodedOutputPath.mockReset().mockImplementation((f) => `/media/transcoded/${f}`);
    buildEmbedFfmpegArgs.mockReset().mockReturnValue(["embed-args"]);
    runFfmpeg.mockReset().mockResolvedValue(undefined);
    collectOutputMetadata.mockReset().mockResolvedValue({
      fileSizeBytes: 4321,
      videoWidth: 480,
      videoHeight: 480,
      resolution: "480p",
      storagePath: "transcoded/42/embed-abc123.mp4",
      mimeType: "video/mp4",
    });
    notifyEmbedVideoComplete.mockReset().mockResolvedValue({ ok: true, status: 200, error: null });
  });

  test("mux the audio input with the thumbnail image and reports the result", async () => {
    const job = makeEmbedJob();

    const result = await processTranscodeJob(job);

    expect(resolveThumbnailInputPath).toHaveBeenCalledWith("42/cover.jpg");
    expect(buildEmbedFfmpegArgs).toHaveBeenCalledWith({
      imagePath: "/media/thumbnails/42/cover.jpg",
      audioPath: "/media/original/clip.mp3",
      outputPath: "/media/transcoded/42/embed-abc123.mp4",
    });
    expect(runFfmpeg).toHaveBeenCalledWith(["embed-args"]);
    expect(notifyEmbedVideoComplete).toHaveBeenCalledWith("embed-abc123", expect.objectContaining({
      storagePath: "transcoded/42/embed-abc123.mp4",
      videoWidth: 480,
      videoHeight: 480,
      isDefault: false,
    }));
    expect(result).toEqual({
      outputFilename: "42/embed-abc123.mp4",
      fileSizeBytes: 4321,
      videoWidth: 480,
      videoHeight: 480,
      storagePath: "transcoded/42/embed-abc123.mp4",
    });
  });

  test("echoes isDefault: true back to the completion callback for a placeholder-sourced mux", async () => {
    const job = makeEmbedJob({ thumbnailFilename: "default-audio-thumbnail.png", isDefault: true });

    await processTranscodeJob(job);

    expect(notifyEmbedVideoComplete).toHaveBeenCalledWith("embed-abc123", expect.objectContaining({
      isDefault: true,
    }));
  });

  test("propagates an ffmpeg failure instead of notifying completion", async () => {
    runFfmpeg.mockReset().mockRejectedValue(new Error("ffmpeg exited with code 1"));
    const job = makeEmbedJob();

    await expect(processTranscodeJob(job)).rejects.toThrow("ffmpeg exited with code 1");
    expect(notifyEmbedVideoComplete).not.toHaveBeenCalled();
  });
});

describe("notifyTranscodeJobFailed (kind: thumbnail)", () => {
  beforeEach(() => {
    notifyThumbnailFailed.mockReset().mockResolvedValue({ ok: true, status: 200, error: null });
  });

  test("calls back to the API so it can fall back to the placeholder thumbnail when eligible", async () => {
    const job = { id: "thumb-abc123", data: { kind: "thumbnail" } };

    await notifyTranscodeJobFailed(job, new Error("no video/art stream to grab a frame from"));

    expect(notifyThumbnailFailed).toHaveBeenCalledWith(
      "thumb-abc123",
      "no video/art stream to grab a frame from",
    );
  });
});

/**
 * Builds a fake BullMQ job for a "hash" kind job, tracking `updateData`
 * calls against an in-memory `data` object the way a real job would persist
 * them to Redis.
 *
 * @param {object} [dataOverrides] Initial job.data overrides.
 * @returns {object} Fake job.
 */
function makeHashJob(dataOverrides = {}) {
  const job = {
    id: "hash-abc123",
    data: { kind: "hash", inputFilename: "clip.mp4", ...dataOverrides },
    updateProgress: jest.fn().mockResolvedValue(undefined),
    updateData: jest.fn(async (newData) => {
      job.data = newData;
    }),
    moveToDelayed: jest.fn().mockResolvedValue(undefined),
  };
  return job;
}

describe("processTranscodeJob (kind: hash) run-count tracking", () => {
  beforeEach(() => {
    computeContentHash.mockReset().mockResolvedValue("sha256:abc");
    notifyContentHashComplete.mockReset().mockResolvedValue({ ok: true, status: 200, error: null });
    notifyContentHashFailed.mockReset().mockResolvedValue({ ok: true, status: 200, error: null });
  });

  test("persists runCount=1 on a job's first run", async () => {
    const job = makeHashJob();

    await processTranscodeJob(job);

    expect(job.updateData).toHaveBeenCalledWith(
      expect.objectContaining({ runCount: 1 }),
    );
    expect(job.data.runCount).toBe(1);
  });

  test("increments the existing runCount rather than resetting it", async () => {
    const job = makeHashJob({ runCount: 3 });

    await processTranscodeJob(job);

    expect(job.data.runCount).toBe(4);
  });

  test("increments runCount even when the hash computation itself fails", async () => {
    computeContentHash.mockRejectedValue(new Error("ffmpeg exited with code 1"));
    const job = makeHashJob({ runCount: 5 });

    await expect(processTranscodeJob(job)).rejects.toThrow("ffmpeg exited with code 1");

    expect(job.data.runCount).toBe(6);
  });

  test("MAX_HASH_JOB_RUNS is 7", () => {
    expect(MAX_HASH_JOB_RUNS).toBe(7);
  });
});

describe("processTranscodeJob (kind: hash) HASH_GENERATION_WINDOW", () => {
  const originalWindow = process.env.HASH_GENERATION_WINDOW;

  beforeEach(() => {
    computeContentHash.mockReset().mockResolvedValue("sha256:abc");
    notifyContentHashComplete.mockReset().mockResolvedValue({ ok: true, status: 200, error: null });
  });

  afterEach(() => {
    jest.useRealTimers();
    if (originalWindow === undefined) {
      delete process.env.HASH_GENERATION_WINDOW;
    } else {
      process.env.HASH_GENERATION_WINDOW = originalWindow;
    }
  });

  test("runs immediately when unset, even outside a typical off-hours window", async () => {
    delete process.env.HASH_GENERATION_WINDOW;
    jest.useFakeTimers({ now: new Date(2026, 0, 1, 14, 0, 0) });
    const job = makeHashJob();

    await processTranscodeJob(job);

    expect(computeContentHash).toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });

  test("runs immediately when the current hour is inside the window", async () => {
    process.env.HASH_GENERATION_WINDOW = "0-6";
    jest.useFakeTimers({ now: new Date(2026, 0, 1, 3, 0, 0) });
    const job = makeHashJob();

    await processTranscodeJob(job, "lock-token");

    expect(computeContentHash).toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
    expect(job.data.runCount).toBe(1);
  });

  test("defers to the next window start when the current hour is outside the window", async () => {
    process.env.HASH_GENERATION_WINDOW = "0-6";
    jest.useFakeTimers({ now: new Date(2026, 0, 1, 14, 0, 0) });
    const job = makeHashJob();

    await expect(processTranscodeJob(job, "lock-token")).rejects.toBeInstanceOf(DelayedError);

    expect(computeContentHash).not.toHaveBeenCalled();
    expect(job.updateData).not.toHaveBeenCalled();
    expect(job.moveToDelayed).toHaveBeenCalledTimes(1);
    const [deferredUntil, token] = job.moveToDelayed.mock.calls[0];
    expect(token).toBe("lock-token");
    // 14:00 -> next window start (midnight) is a 10 hour delay.
    expect(deferredUntil - Date.now()).toBe(10 * 60 * 60 * 1000);
  });

  test("supports a wrap-past-midnight window (e.g. 22-4)", async () => {
    process.env.HASH_GENERATION_WINDOW = "22-4";
    jest.useFakeTimers({ now: new Date(2026, 0, 1, 23, 0, 0) });
    const job = makeHashJob();

    await processTranscodeJob(job, "lock-token");

    expect(computeContentHash).toHaveBeenCalled();
    expect(job.moveToDelayed).not.toHaveBeenCalled();
  });
});
