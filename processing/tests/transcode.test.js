import {
  TranscodeValidationError,
  validateInputFilename,
} from "../lib/media-paths.js";
import {
  buildFfmpegArgs,
  buildNormalizeFfmpegArgs,
  buildOutputFilename,
  buildThumbnailFfmpegArgs,
  getTranscodeConfig,
  parseHardwareEncoders,
  resolveAudioEncoder,
  resolveHardwareAccelerator,
  resolveVideoEncoder,
  shouldSkipHardwareProfile,
  validateTranscodeBatchRequest,
  validateTranscodeJob,
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
        hardwareAccelerated: false,
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
          kind: "rendition",
          profile: {
            ...validProfile,
            outputContainer: "mp4",
            hardwareAccelerated: false,
          },
        },
      ],
    });
  });
});

describe("thumbnail job validation and ffmpeg args", () => {
  test("validateTranscodeJob accepts a thumbnail job with a null timestamp", () => {
    const jobId = "66666666-6666-6666-6666-666666666666";
    expect(
      validateTranscodeJob(
        { jobId, outputFilename: `${jobId}.webp`, kind: "thumbnail", timestampSeconds: null },
        0,
      ),
    ).toEqual({
      jobId,
      outputFilename: `${jobId}.webp`,
      kind: "thumbnail",
      timestampSeconds: null,
    });
  });

  test("validateTranscodeJob accepts a thumbnail job with a numeric timestamp", () => {
    const jobId = "77777777-7777-7777-7777-777777777777";
    expect(
      validateTranscodeJob(
        { jobId, outputFilename: `${jobId}.webp`, kind: "thumbnail", timestampSeconds: 12.3 },
        0,
      ),
    ).toEqual({
      jobId,
      outputFilename: `${jobId}.webp`,
      kind: "thumbnail",
      timestampSeconds: 12.3,
    });
  });

  test("validateTranscodeJob rejects a negative thumbnail timestamp", () => {
    const jobId = "88888888-8888-8888-8888-888888888888";
    expect(() =>
      validateTranscodeJob(
        { jobId, outputFilename: `${jobId}.webp`, kind: "thumbnail", timestampSeconds: -1 },
        0,
      ),
    ).toThrow(TranscodeValidationError);
  });

  test("validateTranscodeJob rejects a non-numeric thumbnail timestamp", () => {
    const jobId = "99999999-9999-9999-9999-999999999999";
    expect(() =>
      validateTranscodeJob(
        { jobId, outputFilename: `${jobId}.webp`, kind: "thumbnail", timestampSeconds: "soon" },
        0,
      ),
    ).toThrow(TranscodeValidationError);
  });

  test("validateTranscodeJob skips profile/transcode-mode validation for thumbnail jobs even when transcoding is disabled", () => {
    const previous = process.env.ENABLE_TRANSCODING;
    process.env.ENABLE_TRANSCODING = "false";
    try {
      const jobId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
      expect(() =>
        validateTranscodeJob(
          { jobId, outputFilename: `${jobId}.webp`, kind: "thumbnail", timestampSeconds: null },
          0,
        ),
      ).not.toThrow();
    } finally {
      process.env.ENABLE_TRANSCODING = previous;
    }
  });

  test("validateTranscodeJob accepts a hash job with only a jobId, no outputFilename/profile", () => {
    const jobId = "hash-abc123";
    expect(validateTranscodeJob({ jobId, kind: "hash" }, 0)).toEqual({
      jobId,
      kind: "hash",
    });
  });

  test("validateTranscodeJob skips profile/transcode-mode validation for hash jobs even when transcoding is disabled", () => {
    const previous = process.env.ENABLE_TRANSCODING;
    process.env.ENABLE_TRANSCODING = "false";
    try {
      expect(() => validateTranscodeJob({ jobId: "hash-xyz", kind: "hash" }, 0)).not.toThrow();
    } finally {
      process.env.ENABLE_TRANSCODING = previous;
    }
  });

  test("validateTranscodeBatchRequest accepts a batch with a hash job", () => {
    const result = validateTranscodeBatchRequest({
      filename: "clip.mp4",
      jobs: [{ jobId: "hash-abc123", kind: "hash" }],
    });
    expect(result).toEqual({
      filename: "clip.mp4",
      jobs: [{ jobId: "hash-abc123", kind: "hash" }],
    });
  });

  test("validateTranscodeJob accepts a normalize job with only jobId + outputFilename, no profile", () => {
    const jobId = "normalize-abc123";
    expect(
      validateTranscodeJob({ jobId, outputFilename: "abc123.mp4", kind: "normalize" }, 0),
    ).toEqual({
      jobId,
      outputFilename: "abc123.mp4",
      kind: "normalize",
    });
  });

  test("validateTranscodeJob skips profile/transcode-mode validation for normalize jobs even when transcoding is disabled", () => {
    const previous = process.env.ENABLE_TRANSCODING;
    process.env.ENABLE_TRANSCODING = "false";
    try {
      expect(() =>
        validateTranscodeJob(
          { jobId: "normalize-abc123", outputFilename: "abc123.mp4", kind: "normalize" },
          0,
        ),
      ).not.toThrow();
    } finally {
      process.env.ENABLE_TRANSCODING = previous;
    }
  });

  test("validateTranscodeBatchRequest accepts a batch with a normalize job", () => {
    const result = validateTranscodeBatchRequest({
      filename: "clip.mov",
      jobs: [{ jobId: "normalize-abc123", outputFilename: "abc123.mp4", kind: "normalize" }],
    });
    expect(result).toEqual({
      filename: "clip.mov",
      jobs: [{ jobId: "normalize-abc123", outputFilename: "abc123.mp4", kind: "normalize" }],
    });
  });

  test("buildThumbnailFfmpegArgs builds a bounded-scale, webp-encoded single-frame command", () => {
    const args = buildThumbnailFfmpegArgs({
      inputPath: "/media/original/in.mp4",
      outputPath: "/media/thumbnails/out.webp",
      timestampSeconds: 12.3,
    });

    expect(args).toEqual([
      "-y",
      "-ss",
      "12.3",
      "-i",
      "/media/original/in.mp4",
      "-frames:v",
      "1",
      "-an",
      "-sn",
      "-vf",
      "scale='min(426,iw)':'min(240,ih)':force_original_aspect_ratio=decrease",
      "-c:v",
      "libwebp",
      "-quality",
      "70",
      "/media/thumbnails/out.webp",
    ]);
  });

  test("buildThumbnailFfmpegArgs requests hwaccel decode but always scales with the software filter when QSV is configured", () => {
    const originalEnv = {
      ENABLE_TRANSCODING: process.env.ENABLE_TRANSCODING,
      ENABLE_HW_ACCELERATED_TRANSCODING: process.env.ENABLE_HW_ACCELERATED_TRANSCODING,
      GPU_ACCELERATION_DEVICE: process.env.GPU_ACCELERATION_DEVICE,
      HW_ACCELERATED_TRANSCODING_ENCODERS: process.env.HW_ACCELERATED_TRANSCODING_ENCODERS,
    };

    try {
      process.env.ENABLE_TRANSCODING = "true";
      process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "true";
      process.env.GPU_ACCELERATION_DEVICE = "/dev/dri/renderD128";
      process.env.HW_ACCELERATED_TRANSCODING_ENCODERS = '["h264_qsv","hevc_qsv"]';

      const args = buildThumbnailFfmpegArgs({
        inputPath: "/media/original/in.mp4",
        outputPath: "/media/thumbnails/out.webp",
        timestampSeconds: 12.3,
      });

      expect(args).toEqual([
        "-y",
        "-hwaccel",
        "qsv",
        "-hwaccel_device",
        "/dev/dri/renderD128",
        "-ss",
        "12.3",
        "-i",
        "/media/original/in.mp4",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-vf",
        "scale='min(426,iw)':'min(240,ih)':force_original_aspect_ratio=decrease",
        "-c:v",
        "libwebp",
        "-quality",
        "70",
        "/media/thumbnails/out.webp",
      ]);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
  });

  test("buildThumbnailFfmpegArgs requests hwaccel decode but always scales with the software filter for a non-QSV accelerator", () => {
    const originalEnv = {
      ENABLE_TRANSCODING: process.env.ENABLE_TRANSCODING,
      ENABLE_HW_ACCELERATED_TRANSCODING: process.env.ENABLE_HW_ACCELERATED_TRANSCODING,
      GPU_ACCELERATION_DEVICE: process.env.GPU_ACCELERATION_DEVICE,
      HW_ACCELERATED_TRANSCODING_ENCODERS: process.env.HW_ACCELERATED_TRANSCODING_ENCODERS,
    };

    try {
      process.env.ENABLE_TRANSCODING = "true";
      process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "true";
      process.env.GPU_ACCELERATION_DEVICE = "/dev/dri/renderD128";
      process.env.HW_ACCELERATED_TRANSCODING_ENCODERS = '["h264_vaapi"]';

      const args = buildThumbnailFfmpegArgs({
        inputPath: "/media/original/in.mp4",
        outputPath: "/media/thumbnails/out.webp",
        timestampSeconds: 12.3,
      });

      expect(args).toEqual([
        "-y",
        "-hwaccel",
        "vaapi",
        "-hwaccel_device",
        "/dev/dri/renderD128",
        "-ss",
        "12.3",
        "-i",
        "/media/original/in.mp4",
        "-frames:v",
        "1",
        "-an",
        "-sn",
        "-vf",
        "scale='min(426,iw)':'min(240,ih)':force_original_aspect_ratio=decrease",
        "-c:v",
        "libwebp",
        "-quality",
        "70",
        "/media/thumbnails/out.webp",
      ]);
    } finally {
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      }
    }
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
        hardwareAccelerated: true,
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

  test("shouldSkipHardwareProfile: never skips a software profile regardless of global hardware config", () => {
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "false";
    const config = getTranscodeConfig();
    expect(
      shouldSkipHardwareProfile(
        { videoCodec: "h264", hardwareAccelerated: false },
        config,
      ),
    ).toBeNull();
  });

  test("shouldSkipHardwareProfile: skips a hardware profile when hardware transcoding is off", () => {
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "false";
    const config = getTranscodeConfig();
    expect(
      shouldSkipHardwareProfile(
        { videoCodec: "h264_qsv", hardwareAccelerated: true },
        config,
      ),
    ).toBe("hardware_transcoding_unavailable");
  });

  test("shouldSkipHardwareProfile: skips a hardware profile whose codec isn't in the encoder allowlist", () => {
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "true";
    process.env.GPU_ACCELERATION_DEVICE = "/dev/dri/renderD128";
    process.env.HW_ACCELERATED_TRANSCODING_ENCODERS =
      '["h264_qsv","hevc_qsv"]';
    const config = getTranscodeConfig();
    expect(
      shouldSkipHardwareProfile(
        { videoCodec: "libx264", hardwareAccelerated: true },
        config,
      ),
    ).toBe("hardware_encoder_not_configured");
  });

  test("shouldSkipHardwareProfile: allows a hardware profile whose codec is allowlisted", () => {
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "true";
    process.env.GPU_ACCELERATION_DEVICE = "/dev/dri/renderD128";
    process.env.HW_ACCELERATED_TRANSCODING_ENCODERS =
      '["h264_qsv","hevc_qsv"]';
    const config = getTranscodeConfig();
    expect(
      shouldSkipHardwareProfile(
        { videoCodec: "h264_qsv", hardwareAccelerated: true },
        config,
      ),
    ).toBeNull();
  });

  test("validateTranscodeProfile no longer throws for a hardware profile when global hardware mode is off (routing, not validation, decides skip)", () => {
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING = "false";

    expect(
      validateTranscodeProfile({
        id: 3,
        outputHeight: 480,
        outputWidth: 854,
        outputContainer: "mp4",
        videoCodec: "libx264",
        audioCodec: "aac",
        hardwareAccelerated: true,
      }),
    ).toMatchObject({ hardwareAccelerated: true, videoCodec: "libx264" });
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

describe("buildNormalizeFfmpegArgs", () => {
  test("copies both streams when source is already H.264/AAC (pure remux)", () => {
    const args = buildNormalizeFfmpegArgs({
      inputPath: "/media/original/in.mkv",
      outputPath: "/media/original/out.mp4",
      codecs: { hasVideo: true, videoCodec: "h264", hasAudio: true, audioCodec: "aac" },
    });

    expect(args).toEqual([
      "-y",
      "-i",
      "/media/original/in.mkv",
      "-c:v",
      "copy",
      "-c:a",
      "copy",
      "-f",
      "mp4",
      "/media/original/out.mp4",
    ]);
  });

  test("re-encodes only the mismatched video stream, copies audio already in AAC", () => {
    const args = buildNormalizeFfmpegArgs({
      inputPath: "/media/original/in.avi",
      outputPath: "/media/original/out.mp4",
      codecs: { hasVideo: true, videoCodec: "mpeg4", hasAudio: true, audioCodec: "aac" },
    });

    expect(args).toEqual([
      "-y",
      "-i",
      "/media/original/in.avi",
      "-c:v",
      "libx264",
      "-c:a",
      "copy",
      "-f",
      "mp4",
      "/media/original/out.mp4",
    ]);
  });

  test("re-encodes only the mismatched audio stream, copies video already in H.264", () => {
    const args = buildNormalizeFfmpegArgs({
      inputPath: "/media/original/in.mov",
      outputPath: "/media/original/out.mp4",
      codecs: { hasVideo: true, videoCodec: "h264", hasAudio: true, audioCodec: "pcm_s16le" },
    });

    expect(args).toEqual([
      "-y",
      "-i",
      "/media/original/in.mov",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-f",
      "mp4",
      "/media/original/out.mp4",
    ]);
  });

  test("re-encodes both streams when neither matches the target codec", () => {
    const args = buildNormalizeFfmpegArgs({
      inputPath: "/media/original/in.avi",
      outputPath: "/media/original/out.mp4",
      codecs: { hasVideo: true, videoCodec: "mpeg4", hasAudio: true, audioCodec: "mp3" },
    });

    expect(args).toEqual([
      "-y",
      "-i",
      "/media/original/in.avi",
      "-c:v",
      "libx264",
      "-c:a",
      "aac",
      "-f",
      "mp4",
      "/media/original/out.mp4",
    ]);
  });

  test("omits video codec args entirely for an audio-only source", () => {
    const args = buildNormalizeFfmpegArgs({
      inputPath: "/media/original/in.wma",
      outputPath: "/media/original/out.m4a",
      codecs: { hasVideo: false, videoCodec: null, hasAudio: true, audioCodec: "wmav2" },
    });

    expect(args).toEqual([
      "-y",
      "-i",
      "/media/original/in.wma",
      "-c:a",
      "aac",
      "-f",
      "mp4",
      "/media/original/out.m4a",
    ]);
  });

  test("never scales, unlike buildFfmpegArgs - no -vf flag regardless of source dimensions", () => {
    const args = buildNormalizeFfmpegArgs({
      inputPath: "/media/original/in.mov",
      outputPath: "/media/original/out.mp4",
      codecs: { hasVideo: true, videoCodec: "h264", hasAudio: true, audioCodec: "aac" },
    });

    expect(args).not.toContain("-vf");
  });
});
