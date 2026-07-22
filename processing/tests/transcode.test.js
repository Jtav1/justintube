import {
  TranscodeValidationError,
  validateInputFilename,
} from "../lib/media-paths.js";
import {
  buildFfmpegArgs,
  buildOutputFilename,
  getTranscodeConfig,
  parseHardwareEncoders,
  resolveAudioEncoder,
  resolveHardwareAccelerator,
  resolveVideoEncoder,
  validateTranscodeBatchRequest,
  validateTranscodeProfile,
  validateTranscodeRequest,
} from "../lib/transcode.js";

describe("validateInputFilename", () => {
  test("accepts a plain basename", () => {
    expect(validateInputFilename("abc.mp4")).toBe("abc.mp4");
  });

  test("rejects path traversal and separators", () => {
    expect(() => validateInputFilename("../secret.mp4")).toThrow(
      TranscodeValidationError,
    );
    expect(() => validateInputFilename("original/abc.mp4")).toThrow(
      TranscodeValidationError,
    );
    expect(() => validateInputFilename("")).toThrow(TranscodeValidationError);
  });
});

describe("validateTranscodeProfile / validateTranscodeRequest", () => {
  const validProfile = {
    id: 1,
    outputHeight: 720,
    outputWidth: 1280,
    outputContainer: "mp4",
    videoCodec: "h264",
    audioCodec: "aac",
  };

  test("accepts a nested profile payload", () => {
    expect(
      validateTranscodeRequest({
        filename: "clip.mp4",
        profile: validProfile,
      }),
    ).toEqual({
      filename: "clip.mp4",
      profile: {
        ...validProfile,
        outputContainer: "mp4",
      },
    });
  });

  test("rejects missing profile or non-positive dimensions", () => {
    expect(() => validateTranscodeRequest({ filename: "a.mp4" })).toThrow(
      TranscodeValidationError,
    );
    expect(() =>
      validateTranscodeProfile({ ...validProfile, outputWidth: 0 }),
    ).toThrow(TranscodeValidationError);
    expect(() =>
      validateTranscodeProfile({
        ...validProfile,
        videoCodec: "h264; rm -rf /",
      }),
    ).toThrow(TranscodeValidationError);
  });

  test("normalizes a batch jobs payload", () => {
    const jobId = "11111111-1111-1111-1111-111111111111";
    expect(
      validateTranscodeBatchRequest({
        filename: "clip.mp4",
        jobs: [
          {
            jobId,
            outputFilename: `${jobId}.mp4`,
            profile: validProfile,
          },
        ],
      }),
    ).toEqual({
      filename: "clip.mp4",
      jobs: [
        {
          jobId,
          outputFilename: `${jobId}.mp4`,
          profile: { ...validProfile, outputContainer: "mp4" },
        },
      ],
    });
  });
});

describe("ffmpeg helpers", () => {
  beforeEach(() => {
    process.env.ENABLE_TRANSCODING = "true";
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "false";
    process.env.GPU_ACCELERATION_DEVICE = "";
    process.env.HW_ACCELERATED_TRANSCODING_ENCODERS = "[]";
  });

  test("maps common codecs and builds deterministic args", () => {
    expect(resolveVideoEncoder("h264")).toBe("libx264");
    expect(resolveAudioEncoder("aac")).toBe("aac");
    expect(buildOutputFilename("job-id", "mp4")).toBe("job-id.mp4");

    const args = buildFfmpegArgs({
      inputPath: "/media/original/in.mp4",
      outputPath: "/media/transcoded/out.mp4",
      profile: {
        id: 3,
        outputHeight: 480,
        outputWidth: 854,
        outputContainer: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
      },
    });

    expect(args).toEqual([
      "-y",
      "-i",
      "/media/original/in.mp4",
      "-vf",
      "scale=854:480",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-f",
      "mp4",
      "/media/transcoded/out.mp4",
    ]);
  });

  test("loads transcode settings and parses hardware encoder arrays", () => {
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "true";
    process.env.GPU_ACCELERATION_DEVICE = "/dev/dri/renderD128";
    process.env.HW_ACCELERATED_TRANSCODING_ENCODERS =
      '["h264_qsv","hevc_qsv"]';

    expect(parseHardwareEncoders(
      process.env.HW_ACCELERATED_TRANSCODING_ENCODERS,
    )).toEqual(["h264_qsv", "hevc_qsv"]);
    expect(getTranscodeConfig()).toMatchObject({
      enabled: true,
      hardwareEnabled: true,
      hardwareDevice: "/dev/dri/renderD128",
      hardwareEncoders: ["h264_qsv", "hevc_qsv"],
      useHardware: true,
    });
    expect(resolveHardwareAccelerator("h264_qsv")).toBe("qsv");
  });

  test("builds hardware-accelerated args with an allowed encoder", () => {
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "true";
    process.env.GPU_ACCELERATION_DEVICE = "/dev/dri/renderD128";
    process.env.HW_ACCELERATED_TRANSCODING_ENCODERS =
      '["h264_qsv","hevc_qsv"]';

    const args = buildFfmpegArgs({
      inputPath: "/media/original/in.mp4",
      outputPath: "/media/transcoded/out.mp4",
      profile: {
        id: 3,
        outputHeight: 480,
        outputWidth: 854,
        outputContainer: "mp4",
        videoCodec: "h264_qsv",
        audioCodec: "aac",
      },
    });

    expect(args).toEqual([
      "-y",
      "-hwaccel",
      "qsv",
      "-hwaccel_device",
      "/dev/dri/renderD128",
      "-i",
      "/media/original/in.mp4",
      "-vf",
      "scale=854:480",
      "-c:v",
      "h264_qsv",
      "-c:a",
      "aac",
      "-f",
      "mp4",
      "/media/transcoded/out.mp4",
    ]);
  });

  test("rejects hardware encoders outside the configured allowlist", () => {
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "true";
    process.env.GPU_ACCELERATION_DEVICE = "/dev/dri/renderD128";
    process.env.HW_ACCELERATED_TRANSCODING_ENCODERS =
      '["h264_qsv","hevc_qsv"]';

    expect(() =>
      validateTranscodeProfile({
        id: 3,
        outputHeight: 480,
        outputWidth: 854,
        outputContainer: "mp4",
        videoCodec: "libx264",
        audioCodec: "aac",
      }),
    ).toThrow(
      "profile.videoCodec must be one of the configured hardware encoders",
    );
  });

  test("rejects requests when transcoding is disabled", () => {
    process.env.ENABLE_TRANSCODING = "false";

    expect(() =>
      validateTranscodeProfile({
        id: 3,
        outputHeight: 480,
        outputWidth: 854,
        outputContainer: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
      }),
    ).toThrow("transcoding is disabled");
  });
});
