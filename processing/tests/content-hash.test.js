import { jest } from "@jest/globals";

/** @type {{ stdout?: string, error?: Error }} */
let nextResult = {};

/** @type {Array<{ file: string, args: string[] }>} */
const execFileCalls = [];

// Must run before any import of lib/probe.js (which calls
// promisify(execFile) from node:child_process at module load) - mock
// registration has to precede the dynamic import below under native ESM.
jest.unstable_mockModule("node:child_process", () => ({
  execFile: (file, args, _options, callback) => {
    execFileCalls.push({ file, args });
    if (nextResult.error) {
      callback(nextResult.error);
      return;
    }
    callback(null, { stdout: nextResult.stdout ?? "", stderr: "" });
  },
}));

const { computeContentHash } = await import("../lib/probe.js");

describe("computeContentHash", () => {
  afterEach(() => {
    nextResult = {};
    execFileCalls.length = 0;
  });

  test("runs ffmpeg's hash muxer against the primary video stream and parses the sha256", async () => {
    nextResult = { stdout: "SHA256=abc123def456\n" };

    const hash = await computeContentHash("/media/original/clip.mp4");

    expect(hash).toBe("sha256:abc123def456");
    expect(execFileCalls).toEqual([
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

  test("lowercases the hex digest", async () => {
    nextResult = { stdout: "SHA256=ABCDEF\n" };
    await expect(computeContentHash("/media/original/clip.mp4")).resolves.toBe(
      "sha256:abcdef",
    );
  });

  test("throws when ffmpeg's output has no parseable hash", async () => {
    nextResult = { stdout: "no hash here\n" };
    await expect(computeContentHash("/media/original/clip.mp4")).rejects.toThrow(
      "ffmpeg did not return a content hash",
    );
  });

  test("propagates an ffmpeg spawn/exit failure", async () => {
    nextResult = { error: new Error("ffmpeg exited with code 1") };
    await expect(computeContentHash("/media/original/clip.mp4")).rejects.toThrow(
      "ffmpeg exited with code 1",
    );
  });
});
