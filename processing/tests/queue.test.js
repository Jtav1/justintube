import { jest } from "@jest/globals";

const computeContentHash = jest.fn();
const notifyContentHashComplete = jest.fn();
const notifyContentHashFailed = jest.fn();

// Must run before any import of lib/queue.js (which imports these modules at
// load time) - mock registration has to precede the dynamic import below
// under native ESM.
jest.unstable_mockModule("../lib/probe.js", () => ({
  computeContentHash,
  collectOutputMetadata: jest.fn(),
}));
jest.unstable_mockModule("../lib/api-client.js", () => ({
  notifyContentHashComplete,
  notifyContentHashFailed,
  notifyFileVersionComplete: jest.fn(),
  notifyFileVersionFailed: jest.fn(),
  notifyThumbnailComplete: jest.fn(),
}));
jest.unstable_mockModule("../lib/media-paths.js", () => ({
  resolveOriginalInputPath: jest.fn((filename) => `/media/original/${filename}`),
  resolveThumbnailOutputPath: jest.fn(),
  resolveTranscodedOutputPath: jest.fn(),
}));
jest.unstable_mockModule("../lib/transcode.js", () => ({
  buildFfmpegArgs: jest.fn(),
  buildThumbnailFfmpegArgs: jest.fn(),
  runFfmpeg: jest.fn(),
}));

const { processTranscodeJob, MAX_HASH_JOB_RUNS } = await import("../lib/queue.js");

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
