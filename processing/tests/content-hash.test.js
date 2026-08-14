import { jest } from "@jest/globals";

/** @type {{ ffprobe?: { stdout?: string, error?: Error }, ffmpeg?: { stdout?: string, error?: Error } }} */
let nextResults = {};

/** @type {Array<{ file: string, args: string[] }>} */
const execFileCalls = [];

// Must run before any import of lib/probe.js (which calls
// promisify(execFile) from node:child_process at module load) - mock
// registration has to precede the dynamic import below under native ESM.
jest.unstable_mockModule("node:child_process", () => ({
  execFile: (file, args, _options, callback) => {
    execFileCalls.push({ file, args });
    const result = nextResults[file] ?? {};
    if (result.error) {
      callback(result.error);
      return;
    }
    callback(null, { stdout: result.stdout ?? "", stderr: "" });
  },
}));

const { computeContentHash } = await import("../lib/probe.js");

/**
 * Default ffprobe response reporting a video stream present, so tests that
 * don't care about audio-only fallback behave like a normal video file.
 *
 * @type {{ stdout: string }}
 */
const VIDEO_STREAM_PROBE = {
  stdout: JSON.stringify({ streams: [{ width: 1920, height: 1080 }] }),
};

/**
 * ffprobe response reporting no video stream (e.g. an audio-only upload).
 *
 * @type {{ stdout: string }}
 */
const NO_VIDEO_STREAM_PROBE = { stdout: JSON.stringify({ streams: [] }) };

describe("computeContentHash", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    nextResults = {};
    execFileCalls.length = 0;
    process.env = { ...originalEnv };
  });

  test("runs ffmpeg's hash muxer against the primary video stream and parses the sha256", async () => {
    nextResults = {
      ffprobe: VIDEO_STREAM_PROBE,
      ffmpeg: { stdout: "SHA256=abc123def456\n" },
    };

    const hash = await computeContentHash("/media/original/clip.mp4");

    expect(hash).toBe("sha256:abc123def456");
    expect(execFileCalls).toEqual([
      {
        file: "ffprobe",
        args: [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=width,height",
          "-of",
          "json",
          "/media/original/clip.mp4",
        ],
      },
      {
        file: "ffmpeg",
        args: [
          "-v",
          "error",
          "-i",
          "/media/original/clip.mp4",
          "-map",
          "0:v:0",
          "-f",
          "hash",
          "-hash",
          "sha256",
          "-",
        ],
      },
    ]);
  });

  test("falls back to the audio stream when no video stream is present", async () => {
    nextResults = {
      ffprobe: NO_VIDEO_STREAM_PROBE,
      ffmpeg: { stdout: "SHA256=abc123def456\n" },
    };

    await computeContentHash("/media/original/clip.mp3");

    const ffmpegCall = execFileCalls.find((call) => call.file === "ffmpeg");
    expect(ffmpegCall.args).toContain("0:a:0");
    expect(ffmpegCall.args).not.toContain("0:v:0");
  });

  test("adds hwaccel args when hardware transcoding is configured", async () => {
    process.env.ENABLE_TRANSCODING = "true";
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "true";
    process.env.GPU_ACCELERATION_DEVICE = "/dev/dri/renderD128";
    process.env.HW_ACCELERATED_TRANSCODING_ENCODERS = JSON.stringify(["h264_vaapi"]);
    nextResults = {
      ffprobe: VIDEO_STREAM_PROBE,
      ffmpeg: { stdout: "SHA256=abc123def456\n" },
    };

    await computeContentHash("/media/original/clip.mp4");

    const ffmpegCall = execFileCalls.find((call) => call.file === "ffmpeg");
    expect(ffmpegCall.args).toEqual([
      "-v",
      "error",
      "-hwaccel",
      "vaapi",
      "-hwaccel_device",
      "/dev/dri/renderD128",
      "-i",
      "/media/original/clip.mp4",
      "-map",
      "0:v:0",
      "-f",
      "hash",
      "-hash",
      "sha256",
      "-",
    ]);
  });

  test("omits hwaccel args when hardware transcoding is not configured", async () => {
    process.env.ENABLE_TRANSCODING = "true";
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "false";
    nextResults = {
      ffprobe: VIDEO_STREAM_PROBE,
      ffmpeg: { stdout: "SHA256=abc123def456\n" },
    };

    await computeContentHash("/media/original/clip.mp4");

    const ffmpegCall = execFileCalls.find((call) => call.file === "ffmpeg");
    expect(ffmpegCall.args).not.toContain("-hwaccel");
  });

  test("lowercases the hex digest", async () => {
    nextResults = { ffprobe: VIDEO_STREAM_PROBE, ffmpeg: { stdout: "SHA256=ABCDEF\n" } };
    await expect(computeContentHash("/media/original/clip.mp4")).resolves.toBe(
      "sha256:abcdef",
    );
  });

  test("throws when ffmpeg's output has no parseable hash", async () => {
    nextResults = { ffprobe: VIDEO_STREAM_PROBE, ffmpeg: { stdout: "no hash here\n" } };
    await expect(computeContentHash("/media/original/clip.mp4")).rejects.toThrow(
      "ffmpeg did not return a content hash",
    );
  });

  test("propagates an ffmpeg spawn/exit failure", async () => {
    nextResults = {
      ffprobe: VIDEO_STREAM_PROBE,
      ffmpeg: { error: new Error("ffmpeg exited with code 1") },
    };
    await expect(computeContentHash("/media/original/clip.mp4")).rejects.toThrow(
      "ffmpeg exited with code 1",
    );
  });
});
