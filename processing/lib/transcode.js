import "dotenv/config";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { TranscodeValidationError } from "./media-paths.js";

const execFileAsync = promisify(execFile);

/**
 * Allowed pattern for ffmpeg codec/container tokens (no spaces or shell metacharacters).
 *
 * @type {RegExp}
 */
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;

/**
 * Maps common profile codec names to ffmpeg encoder names.
 *
 * @type {Record<string, string>}
 */
const VIDEO_CODEC_MAP = {
  h264: "libx264",
  avc: "libx264",
  h265: "libx265",
  hevc: "libx265",
  vp9: "libvpx-vp9",
  vp8: "libvpx",
  av1: "libaom-av1",
};

/**
 * Maps common profile audio codec names to ffmpeg encoder names.
 *
 * @type {Record<string, string>}
 */
const AUDIO_CODEC_MAP = {
  aac: "aac",
  opus: "libopus",
  mp3: "libmp3lame",
  vorbis: "libvorbis",
  flac: "flac",
};

/**
 * Values accepted as enabled boolean environment settings.
 *
 * @type {Set<string>}
 */
const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

/**
 * @typedef {object} TranscodeProfilePayload
 * @property {number} id Transcode profile id from the API.
 * @property {number} outputHeight Target frame height in pixels.
 * @property {number} outputWidth Target frame width in pixels.
 * @property {string} outputContainer Output container / extension (e.g. mp4).
 * @property {string} videoCodec Requested video codec name.
 * @property {string} audioCodec Requested audio codec name.
 * @property {boolean} hardwareAccelerated Whether this profile requests
 *   hardware-accelerated encoding. Routing is per-profile: a job is only
 *   skipped/rejected for hardware reasons when this is true (see
 *   {@link shouldSkipHardwareProfile}); software profiles are always
 *   encoded in software regardless of the deployment's global hardware
 *   configuration.
 */

/**
 * @typedef {object} ValidatedTranscodeRequest
 * @property {string} filename Basename under `/media/original`.
 * @property {TranscodeProfilePayload} profile Validated profile fields.
 */

/**
 * @typedef {object} ValidatedTranscodeJob
 * @property {string} jobId Stable BullMQ job id.
 * @property {string} outputFilename Basename under the job kind's output directory.
 * @property {"rendition"|"thumbnail"} kind Job kind.
 * @property {TranscodeProfilePayload} [profile] Present when `kind === "rendition"`.
 * @property {number|null} [timestampSeconds] Present when `kind === "thumbnail"`.
 */

/**
 * @typedef {object} ValidatedTranscodeBatchRequest
 * @property {string} filename Basename under `/media/original`.
 * @property {ValidatedTranscodeJob[]} jobs One or more transcode jobs.
 */

/**
 * Asserts that `value` is a finite positive integer.
 *
 * @param {unknown} value Candidate number.
 * @param {string} fieldName Field label for error messages.
 * @returns {number} Validated integer.
 * @throws {TranscodeValidationError} When the value is not a positive integer.
 */
function requirePositiveInteger(value, fieldName) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value <= 0
  ) {
    throw new TranscodeValidationError(
      `${fieldName} must be a positive integer`,
    );
  }
  return value;
}

/**
 * Asserts that `value` is a safe non-empty token string for ffmpeg args.
 *
 * @param {unknown} value Candidate string.
 * @param {string} fieldName Field label for error messages.
 * @returns {string} Trimmed validated token.
 * @throws {TranscodeValidationError} When the value is missing or unsafe.
 */
function requireSafeToken(value, fieldName) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TranscodeValidationError(
      `${fieldName} is required and must be a string`,
    );
  }
  const trimmed = value.trim();
  if (!SAFE_TOKEN.test(trimmed)) {
    throw new TranscodeValidationError(
      `${fieldName} contains unsupported characters`,
    );
  }
  return trimmed;
}

/**
 * Asserts that `value` is a boolean when present, defaulting to `false` when
 * absent (older/legacy callers may omit the field entirely).
 *
 * @param {unknown} value Candidate boolean.
 * @param {string} fieldName Field label for error messages.
 * @returns {boolean} Validated boolean, defaulting to `false`.
 * @throws {TranscodeValidationError} When a non-boolean value is present.
 */
function requireBoolean(value, fieldName) {
  if (value === undefined) {
    return false;
  }
  if (typeof value !== "boolean") {
    throw new TranscodeValidationError(`${fieldName} must be a boolean`);
  }
  return value;
}

/**
 * Parses a boolean environment setting.
 *
 * @param {unknown} value Raw environment value.
 * @returns {boolean} Whether the value represents an enabled setting.
 */
export function parseBooleanEnv(value) {
  return TRUE_ENV_VALUES.has(String(value ?? "").trim().toLowerCase());
}

/**
 * Parses the JSON array in `HW_ACCELERATED_TRANSCODING_ENCODERS`.
 *
 * @param {unknown} value Raw environment value.
 * @returns {string[]} Safe, unique hardware encoder names.
 * @throws {TranscodeValidationError} When the setting is not a JSON string
 *   array or contains an unsafe encoder token.
 */
export function parseHardwareEncoders(value) {
  const raw = String(value ?? "").trim();
  if (!raw) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TranscodeValidationError(
      "HW_ACCELERATED_TRANSCODING_ENCODERS must be a JSON array of encoder names",
    );
  }

  if (!Array.isArray(parsed) || parsed.some((encoder) => typeof encoder !== "string")) {
    throw new TranscodeValidationError(
      "HW_ACCELERATED_TRANSCODING_ENCODERS must be a JSON array of encoder names",
    );
  }

  return [
    ...new Set(
      parsed.map((encoder) =>
        requireSafeToken(
          encoder,
          "HW_ACCELERATED_TRANSCODING_ENCODERS encoder",
        ),
      ),
    ),
  ];
}

/**
 * Reads the current software/hardware transcode configuration from environment
 * variables loaded from `processing/.env`.
 *
 * @returns {{
 *   enabled: boolean,
 *   hardwareEnabled: boolean,
 *   hardwareDevice: string,
 *   hardwareEncoders: string[],
 *   useHardware: boolean
 * }} Current transcode configuration.
 * @throws {TranscodeValidationError} When the hardware encoder list is invalid.
 */
export function getTranscodeConfig() {
  const enabled = parseBooleanEnv(process.env.ENABLE_TRANSCODING);
  const hardwareEnabled = parseBooleanEnv(
    process.env.ENABLE_HW_ACCELERATED_TRANSCODING,
  );
  const hardwareDevice = String(
    process.env.GPU_ACCELERATION_DEVICE ?? "",
  ).trim();
  const useHardware = enabled && hardwareEnabled && Boolean(hardwareDevice);

  return {
    enabled,
    hardwareEnabled,
    hardwareDevice,
    hardwareEncoders: useHardware
      ? parseHardwareEncoders(
          process.env.HW_ACCELERATED_TRANSCODING_ENCODERS,
        )
      : [],
    useHardware,
  };
}

/**
 * Validates the nested `profile` object from a transcode request body.
 * Hardware availability/encoder-allowlist gating is NOT performed here - it's
 * a per-job routing decision made later by {@link shouldSkipHardwareProfile}
 * once the source has been probed, not a request-shape validation concern
 * (a batch shouldn't fail entirely just because one job's hardware profile
 * isn't currently runnable).
 *
 * @param {unknown} profile Raw profile payload.
 * @returns {TranscodeProfilePayload} Validated profile fields.
 * @throws {TranscodeValidationError} When any required field is invalid, or
 *   transcoding is disabled entirely.
 */
export function validateTranscodeProfile(profile) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    throw new TranscodeValidationError(
      "profile is required and must be an object",
    );
  }

  const body = /** @type {Record<string, unknown>} */ (profile);

  const validated = {
    id: requirePositiveInteger(body.id, "profile.id"),
    outputHeight: requirePositiveInteger(body.outputHeight, "profile.outputHeight"),
    outputWidth: requirePositiveInteger(body.outputWidth, "profile.outputWidth"),
    outputContainer: requireSafeToken(
      body.outputContainer,
      "profile.outputContainer",
    ).toLowerCase(),
    videoCodec: requireSafeToken(body.videoCodec, "profile.videoCodec"),
    audioCodec: requireSafeToken(body.audioCodec, "profile.audioCodec"),
    hardwareAccelerated: requireBoolean(
      body.hardwareAccelerated,
      "profile.hardwareAccelerated",
    ),
  };

  if (!getTranscodeConfig().enabled) {
    throw new TranscodeValidationError("transcoding is disabled");
  }

  return validated;
}

/**
 * Decides whether a hardware-accelerated profile should be skipped rather
 * than enqueued, because hardware transcoding isn't usable on this
 * deployment right now, or because this profile's videoCodec isn't one of
 * the currently configured hardware encoders. Software profiles
 * (`hardwareAccelerated: false`) are never skipped by this check regardless
 * of the deployment's global hardware configuration.
 *
 * @param {TranscodeProfilePayload} profile Validated profile fields.
 * @param {ReturnType<typeof getTranscodeConfig>} config Current transcode config.
 * @returns {string|null} A skip reason string, or null when the job should run.
 */
export function shouldSkipHardwareProfile(profile, config) {
  if (!profile.hardwareAccelerated) {
    return null;
  }
  if (!config.useHardware) {
    return "hardware_transcoding_unavailable";
  }
  if (!config.hardwareEncoders.includes(profile.videoCodec)) {
    return "hardware_encoder_not_configured";
  }
  return null;
}

/**
 * Validates the optional `timestampSeconds` field on a thumbnail job.
 *
 * @param {unknown} value Raw timestampSeconds value.
 * @param {string} fieldName Field label for error messages.
 * @returns {number|null} Validated timestamp, or null (means "pick randomly").
 * @throws {TranscodeValidationError} When present but not a finite number >= 0.
 */
function validateOptionalTimestampSeconds(value, fieldName) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new TranscodeValidationError(
      `${fieldName} must be a non-negative number or null`,
    );
  }
  return value;
}

/**
 * Validates a single entry in a batch `jobs` array. Dispatches on `job.kind`:
 * `"rendition"` (the default, for back-compat with jobs that omit `kind`)
 * requires a `profile` and goes through the full transcode-mode/hardware
 * gating in {@link validateTranscodeProfile}; `"thumbnail"` requires only a
 * `timestampSeconds` and skips that gating entirely — a single-frame grab
 * isn't a real transcode and shouldn't be blocked by `ENABLE_TRANSCODING`.
 *
 * @param {unknown} job Raw job object.
 * @param {number} index Zero-based index for error messages.
 * @returns {ValidatedTranscodeJob} Validated job fields.
 * @throws {TranscodeValidationError} When any required field is invalid.
 */
export function validateTranscodeJob(job, index) {
  if (job === null || typeof job !== "object" || Array.isArray(job)) {
    throw new TranscodeValidationError(
      `jobs[${index}] is required and must be an object`,
    );
  }

  const body = /** @type {Record<string, unknown>} */ (job);
  const jobId = requireSafeToken(body.jobId, `jobs[${index}].jobId`);
  const outputFilename = requireSafeToken(
    body.outputFilename,
    `jobs[${index}].outputFilename`,
  );
  const kind = body.kind === "thumbnail" ? "thumbnail" : "rendition";

  if (kind === "thumbnail") {
    const timestampSeconds = validateOptionalTimestampSeconds(
      body.timestampSeconds,
      `jobs[${index}].timestampSeconds`,
    );
    return { jobId, outputFilename, kind, timestampSeconds };
  }

  const profile = validateTranscodeProfile(body.profile);
  return { jobId, outputFilename, kind, profile };
}

/**
 * Validates a legacy POST `/transcode` JSON body (`filename` + nested `profile`).
 *
 * @param {unknown} body Raw request body.
 * @returns {ValidatedTranscodeRequest} Validated filename and profile.
 * @throws {TranscodeValidationError} When the body shape or fields are invalid.
 */
export function validateTranscodeRequest(body) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TranscodeValidationError("request body must be a JSON object");
  }

  const payload = /** @type {Record<string, unknown>} */ (body);
  if (typeof payload.filename !== "string") {
    throw new TranscodeValidationError(
      "filename is required and must be a string",
    );
  }

  return {
    filename: payload.filename.trim(),
    profile: validateTranscodeProfile(payload.profile),
  };
}

/**
 * Validates a POST `/transcode` body that is either a legacy single-profile
 * request or a batch `{ filename, jobs }` request. Legacy bodies are normalized
 * into a one-element `jobs` array with a generated job id.
 *
 * @param {unknown} body Raw request body.
 * @param {{ generateJobId?: () => string }} [options] Optional id factory for
 *   legacy single-profile requests (defaults to crypto.randomUUID when omitted
 *   by the caller via pre-generated ids).
 * @returns {ValidatedTranscodeBatchRequest} Normalized batch payload.
 * @throws {TranscodeValidationError} When the body shape or fields are invalid.
 */
export function validateTranscodeBatchRequest(body, options = {}) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new TranscodeValidationError("request body must be a JSON object");
  }

  const payload = /** @type {Record<string, unknown>} */ (body);
  if (typeof payload.filename !== "string") {
    throw new TranscodeValidationError(
      "filename is required and must be a string",
    );
  }

  const filename = payload.filename.trim();

  if (Array.isArray(payload.jobs)) {
    if (payload.jobs.length === 0) {
      throw new TranscodeValidationError("jobs must be a non-empty array");
    }
    return {
      filename,
      jobs: payload.jobs.map((job, index) => validateTranscodeJob(job, index)),
    };
  }

  // Legacy single-profile shape → one job with a caller-supplied id factory.
  const profile = validateTranscodeProfile(payload.profile);
  const generateJobId =
    typeof options.generateJobId === "function"
      ? options.generateJobId
      : () => {
          throw new TranscodeValidationError(
            "generateJobId is required for legacy single-profile requests",
          );
        };
  const jobId = generateJobId();
  return {
    filename,
    jobs: [
      {
        jobId,
        outputFilename: buildOutputFilename(jobId, profile.outputContainer),
        kind: "rendition",
        profile,
      },
    ],
  };
}

/**
 * Resolves a profile video codec name to an ffmpeg video encoder.
 *
 * @param {string} videoCodec Profile video codec (e.g. h264, libx264).
 * @returns {string} FFmpeg `-c:v` encoder name.
 */
export function resolveVideoEncoder(videoCodec) {
  const key = videoCodec.toLowerCase();
  return VIDEO_CODEC_MAP[key] || videoCodec;
}

/**
 * Resolves a profile audio codec name to an ffmpeg audio encoder.
 *
 * @param {string} audioCodec Profile audio codec (e.g. aac, libopus).
 * @returns {string} FFmpeg `-c:a` encoder name.
 */
export function resolveAudioEncoder(audioCodec) {
  const key = audioCodec.toLowerCase();
  return AUDIO_CODEC_MAP[key] || audioCodec;
}

/**
 * Infers the ffmpeg hardware acceleration API from an encoder name.
 *
 * @param {string} videoCodec Allowed hardware encoder name.
 * @returns {string} FFmpeg `-hwaccel` value.
 */
export function resolveHardwareAccelerator(videoCodec) {
  const key = videoCodec.toLowerCase();

  if (key.endsWith("_qsv")) {
    return "qsv";
  }
  if (key.endsWith("_nvenc") || key.endsWith("_cuda")) {
    return "cuda";
  }
  if (key.endsWith("_vaapi")) {
    return "vaapi";
  }
  if (key.endsWith("_videotoolbox")) {
    return "videotoolbox";
  }

  return "auto";
}

/**
 * Builds a deterministic output basename from a UUID and container.
 *
 * @param {string} uuid Job / output UUID (without extension).
 * @param {string} outputContainer Container / extension token.
 * @returns {string} Output basename such as `<uuid>.mp4`.
 */
export function buildOutputFilename(uuid, outputContainer) {
  return `${uuid}.${outputContainer}`;
}

/**
 * Builds the ffmpeg argument list for a scale + re-encode job. Only ever
 * called for jobs that already passed the routes-level
 * {@link shouldSkipHardwareProfile} check, so `profile.hardwareAccelerated
 * === true` here implies hardware is actually configured and usable.
 *
 * @param {object} options Transcode execution options.
 * @param {string} options.inputPath Absolute path to the source file.
 * @param {string} options.outputPath Absolute path for the output file.
 * @param {TranscodeProfilePayload} options.profile Validated profile fields.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildFfmpegArgs({ inputPath, outputPath, profile }) {
  const videoEncoder = profile.hardwareAccelerated
    ? profile.videoCodec
    : resolveVideoEncoder(profile.videoCodec);
  const audioEncoder = resolveAudioEncoder(profile.audioCodec);

  const inputArgs = profile.hardwareAccelerated
    ? [
        "-hwaccel",
        resolveHardwareAccelerator(profile.videoCodec),
        "-hwaccel_device",
        getTranscodeConfig().hardwareDevice,
      ]
    : [];

  return [
    "-y",
    ...inputArgs,
    "-i",
    inputPath,
    "-vf",
    `scale=${profile.outputWidth}:${profile.outputHeight}`,
    "-c:v",
    videoEncoder,
    "-c:a",
    audioEncoder,
    "-f",
    profile.outputContainer,
    outputPath,
  ];
}

/**
 * Maximum thumbnail frame dimensions (a bounding box, not a hard target) —
 * matches the app's existing "480p" rendition convention.
 *
 * @type {number}
 */
const THUMBNAIL_MAX_WIDTH = 854;

/**
 * @type {number}
 */
const THUMBNAIL_MAX_HEIGHT = 480;

/**
 * Builds the ffmpeg argument list for a single-frame thumbnail extraction.
 * Deliberately bypasses the transcoding-enabled/hardware-acceleration gating
 * in `validateTranscodeProfile`/`shouldSkipHardwareProfile` (see
 * `validateTranscodeJob`) — this is a lightweight frame grab, not a real
 * transcode, and `ENABLE_TRANSCODING=false` shouldn't block it.
 *
 * Scales down (never up) to fit within {@link THUMBNAIL_MAX_WIDTH}x
 * {@link THUMBNAIL_MAX_HEIGHT} as a bounding box, preserving the source
 * aspect ratio (`force_original_aspect_ratio=decrease`) rather than a hard
 * `scale=854x480` stretch, which would distort any non-16:9 source. Encodes
 * to WebP for efficient web delivery.
 *
 * @param {object} options Thumbnail execution options.
 * @param {string} options.inputPath Absolute path to the source video file.
 * @param {string} options.outputPath Absolute path for the output `.webp` file.
 * @param {number} options.timestampSeconds Frame timestamp to seek to, in seconds.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildThumbnailFfmpegArgs({ inputPath, outputPath, timestampSeconds }) {
  return [
    "-y",
    "-ss",
    String(timestampSeconds),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':'min(${THUMBNAIL_MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease`,
    "-c:v",
    "libwebp",
    "-quality",
    "80",
    outputPath,
  ];
}

/**
 * Runs ffmpeg with the given argument list via `execFile`.
 *
 * @param {string[]} args FFmpeg CLI arguments (no binary name).
 * @returns {Promise<void>} Resolves when ffmpeg exits successfully.
 * @throws {Error} When ffmpeg exits non-zero or cannot be spawned.
 */
export async function runFfmpeg(args) {
  try {
    await execFileAsync("ffmpeg", args, {
      maxBuffer: 10 * 1024 * 1024,
    });
  } catch (err) {
    const stderr =
      typeof err?.stderr === "string" && err.stderr.trim()
        ? err.stderr.trim()
        : err instanceof Error
          ? err.message
          : "ffmpeg failed";
    throw new Error(stderr);
  }
}
