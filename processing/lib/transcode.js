import "dotenv/config";

import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { TranscodeValidationError, validateRelativeMediaPath } from "./media-paths.js";

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
 * @property {string} [outputFilename] Basename under the job kind's output
 *   directory. Absent when `kind === "hash"` (no output file is written).
 * @property {"rendition"|"thumbnail"|"hash"|"normalize"|"embed"|"subtitle"|"hls"|"storyboard"|"preview"} kind Job kind.
 * @property {TranscodeProfilePayload} [profile] Present when `kind === "rendition"`.
 * @property {number|null} [timestampSeconds] Present when `kind === "thumbnail"`.
 * @property {string} [thumbnailFilename] Present when `kind === "embed"` — relative
 *   path under `/media/thumbnails` to loop as the muxed output's video stream.
 * @property {boolean} [isDefault] Present when `kind === "embed"` — whether
 *   `thumbnailFilename` is the fixed placeholder asset (no real thumbnail
 *   exists for this upload yet) rather than genuine cover art. Echoed back
 *   through the completion callback so the API can refuse to let a slower
 *   placeholder-sourced completion overwrite a real one that already landed.
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
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
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
  return TRUE_ENV_VALUES.has(
    String(value ?? "")
      .trim()
      .toLowerCase(),
  );
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

  if (
    !Array.isArray(parsed) ||
    parsed.some((encoder) => typeof encoder !== "string")
  ) {
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
      ? parseHardwareEncoders(process.env.HW_ACCELERATED_TRANSCODING_ENCODERS)
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
  if (
    profile === null ||
    typeof profile !== "object" ||
    Array.isArray(profile)
  ) {
    throw new TranscodeValidationError(
      "profile is required and must be an object",
    );
  }

  const body = /** @type {Record<string, unknown>} */ (profile);

  const validated = {
    id: requirePositiveInteger(body.id, "profile.id"),
    outputHeight: requirePositiveInteger(
      body.outputHeight,
      "profile.outputHeight",
    ),
    outputWidth: requirePositiveInteger(
      body.outputWidth,
      "profile.outputWidth",
    ),
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
 * `"hash"` (duplicate-upload content hashing) needs only `jobId` - it never
 * writes an output file, so `outputFilename` is omitted entirely. `"normalize"`
 * (remux/transcode a FILETYPES_CONVERTIBLE upload to H.264/AAC MP4) needs
 * only `jobId` + `outputFilename` - no profile (it never scales) and no
 * hardware/mode gating (it always runs in software). `"embed"` (mux an
 * audio-only upload with its thumbnail image into a playable MP4, for link
 * unfurlers that only render `og:video`) needs `jobId` + `outputFilename` +
 * `thumbnailFilename` - no profile, no gating. `"hls"` (remux the original
 * upload - always the highest-quality copy available - into single-file
 * byte-range fMP4 HLS, for adaptive seeking/partial-download playback) needs
 * only `jobId` + `outputFilename` (a directory, not a file - see
 * `resolveHlsOutputDir`) - like `"normalize"`, no profile, no gating, always
 * software (`-c copy`, a remux). `"storyboard"` (tile evenly time-spaced
 * thumbnails from the original upload into a single sprite image, plus a
 * WebVTT sidecar mapping time ranges to each tile - the seek-bar hover-
 * scrub preview) needs only `jobId` + `outputFilename` (a directory, not a
 * file - see `resolveStoryboardOutputDir`) - no profile, no gating.
 * `"preview"` (a short muted, looping clip cut from the original upload,
 * shown on hover in a video grid - see `buildPreviewClipFfmpegArgs`) needs
 * only `jobId` + `outputFilename` (a single file, like `"embed"`) - no
 * profile, no gating.
 *
 * `outputFilename` (and `thumbnailFilename`) are validated with
 * {@link validateRelativeMediaPath} rather than {@link requireSafeToken} -
 * both may legitimately be a `<userId|_unowned>/<basename>` path under the
 * per-user media layout, which `requireSafeToken`'s bare-token pattern would
 * reject outright.
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

  if (body.kind === "hash") {
    return { jobId, kind: "hash" };
  }

  const outputFilename = validateRelativeMediaPath(
    body.outputFilename,
    `jobs[${index}].outputFilename`,
  );

  if (body.kind === "normalize") {
    return { jobId, outputFilename, kind: "normalize" };
  }

  if (body.kind === "subtitle") {
    return { jobId, outputFilename, kind: "subtitle" };
  }

  if (body.kind === "hls") {
    return { jobId, outputFilename, kind: "hls" };
  }

  if (body.kind === "storyboard") {
    return { jobId, outputFilename, kind: "storyboard" };
  }

  if (body.kind === "preview") {
    return { jobId, outputFilename, kind: "preview" };
  }

  if (body.kind === "embed") {
    const thumbnailFilename = validateRelativeMediaPath(
      body.thumbnailFilename,
      `jobs[${index}].thumbnailFilename`,
    );
    const isDefault = requireBoolean(body.isDefault, `jobs[${index}].isDefault`);
    return { jobId, outputFilename, kind: "embed", thumbnailFilename, isDefault };
  }

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
 * Builds `-hwaccel`/`-hwaccel_device` input args for a decode-only ffmpeg
 * invocation that has no target encoder of its own (e.g. content hashing).
 * Since there's no profile to infer an accelerator API from, this uses the
 * deployment's first configured hardware encoder as the source of that
 * inference — deployments configure one hardware API at a time, so any
 * configured encoder identifies it.
 *
 * @param {ReturnType<typeof getTranscodeConfig>} config Current transcode config.
 * @returns {string[]} `-hwaccel`/`-hwaccel_device` args, or `[]` when
 *   hardware isn't usable on this deployment.
 */
export function resolveDecodeHardwareAccelArgs(config) {
  if (!config.useHardware || config.hardwareEncoders.length === 0) {
    return [];
  }
  return [
    "-hwaccel",
    resolveHardwareAccelerator(config.hardwareEncoders[0]),
    "-hwaccel_device",
    config.hardwareDevice,
  ];
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
 * Builds the ffmpeg argument list for a normalize job: rewraps/re-encodes an
 * upload accepted through the FILETYPES_CONVERTIBLE tier into an H.264/AAC
 * MP4 (or an audio-only MP4-family file, conventionally named `.m4a`) at the
 * source's original dimensions. Unlike {@link buildFfmpegArgs}, this never
 * scales, and copies each stream (`-c:v copy` / `-c:a copy`) instead of
 * re-encoding it whenever the source is already in the target codec — a
 * "remux" rather than a full transcode for streams that don't need one.
 * Always runs in software (no hardware-accel branch) — normalize is a
 * comparatively rare, one-off, often copy-heavy operation, not worth the
 * added complexity for v1.
 *
 * @param {object} options Normalize execution options.
 * @param {string} options.inputPath Absolute path to the source file.
 * @param {string} options.outputPath Absolute path for the output file.
 * @param {{ hasVideo: boolean, videoCodec: string|null, hasAudio: boolean, audioCodec: string|null }} options.codecs
 *   Source stream presence/codecs from `probeStreamCodecs`.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildNormalizeFfmpegArgs({ inputPath, outputPath, codecs }) {
  const args = ["-y", "-i", inputPath];

  if (codecs.hasVideo) {
    args.push("-c:v", codecs.videoCodec === "h264" ? "copy" : resolveVideoEncoder("h264"));
  }
  if (codecs.hasAudio) {
    args.push("-c:a", codecs.audioCodec === "aac" ? "copy" : resolveAudioEncoder("aac"));
  }

  args.push("-f", "mp4", outputPath);
  return args;
}

/**
 * Target segment duration, in seconds, for HLS packaging. Only matters for
 * `EXT-X-BYTERANGE` boundary granularity within the single fMP4 media file
 * (`-hls_flags single_file`) — there's no per-segment file count cost to
 * weigh here, unlike classic multi-file HLS.
 *
 * @type {number}
 */
const HLS_SEGMENT_DURATION_SECONDS = 6;

/**
 * Fixed basenames written into an `"hls"` job's output directory (see
 * `resolveHlsOutputDir`) — always the same three names regardless of input,
 * since each upload gets its own directory.
 *
 * @type {{ init: string, media: string, playlist: string }}
 */
export const HLS_OUTPUT_FILENAMES = {
  init: "init.mp4",
  media: "stream.m4s",
  playlist: "variant.m3u8",
};

/**
 * Builds the ffmpeg argument list for packaging the original upload into
 * single-file byte-range fMP4 HLS (`"hls"` job kind). Always a remux
 * (`-c copy`) — the original is kept exactly as uploaded, at its full
 * quality; this only repackages its container for seekable, partial-download
 * playback, never re-encodes it. `single_file` flag keeps the whole thing in
 * one `stream.m4s`, referenced via `EXT-X-BYTERANGE` in the variant
 * playlist, instead of many small segment files — deliberately traded off
 * against per-segment CDN cacheability, since this is a single self-hosted
 * volume, not a CDN-fronted deployment, and file/inode count matters more
 * here.
 *
 * @param {object} options HLS packaging execution options.
 * @param {string} options.inputPath Absolute path to the original upload.
 * @param {string} options.outputDir Absolute path to the job's output
 *   directory (see `resolveHlsOutputDir`) — must already exist.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildHlsFfmpegArgs({ inputPath, outputDir }) {
  return [
    "-y",
    "-i",
    inputPath,
    "-c",
    "copy",
    "-f",
    "hls",
    "-hls_time",
    String(HLS_SEGMENT_DURATION_SECONDS),
    "-hls_playlist_type",
    "vod",
    "-hls_segment_type",
    "fmp4",
    "-hls_fmp4_init_filename",
    HLS_OUTPUT_FILENAMES.init,
    "-hls_flags",
    "single_file+independent_segments",
    "-hls_segment_filename",
    join(outputDir, HLS_OUTPUT_FILENAMES.media),
    join(outputDir, HLS_OUTPUT_FILENAMES.playlist),
  ];
}

/**
 * Maximum frame dimensions for an `"embed"` job's looped video stream (a
 * bounding box, not a hard target) — generously sized since the source is
 * already a small thumbnail image, not something worth downscaling further.
 *
 * @type {number}
 */
const EMBED_VIDEO_MAX_WIDTH = 854;

/**
 * @type {number}
 */
const EMBED_VIDEO_MAX_HEIGHT = 480;

/**
 * Builds the ffmpeg argument list for an `"embed"` job: mux an audio-only
 * upload with a single looped still image (its thumbnail) into a real MP4
 * with both a video and an audio stream. Exists purely so link-unfurl bots
 * (Discord in particular) that only render `og:video` — never `og:audio` —
 * have something genuinely playable to point at for audio uploads.
 *
 * `-tune stillimage` plus a static source frame keeps the video stream
 * essentially free to encode (one real keyframe, near-zero delta after that),
 * so the output is only marginally larger than the raw audio. `-shortest`
 * stops the (otherwise infinitely-looped, per `-loop 1`) image stream once
 * the audio ends. The scale+pad filter fits the image within a bounding box
 * and forces even output dimensions (via `ceil(iw/2)*2`) regardless of the
 * source image's own dimensions/parity, both required for H.264. Audio is
 * always re-encoded to AAC rather than copied — unlike `buildNormalizeFfmpegArgs`,
 * the source codec (mp3, opus, flac, ...) is often not one the MP4 container
 * can hold at all, so there is no safe "copy when already matching" case here.
 *
 * @param {object} options Embed execution options.
 * @param {string} options.imagePath Absolute path to the thumbnail image to loop.
 * @param {string} options.audioPath Absolute path to the source audio file.
 * @param {string} options.outputPath Absolute path for the output `.mp4` file.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildEmbedFfmpegArgs({ imagePath, audioPath, outputPath }) {
  return [
    "-y",
    "-loop",
    "1",
    "-i",
    imagePath,
    "-i",
    audioPath,
    "-vf",
    `scale='min(${EMBED_VIDEO_MAX_WIDTH},iw)':'min(${EMBED_VIDEO_MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease,pad='ceil(iw/2)*2':'ceil(ih/2)*2'`,
    "-c:v",
    "libx264",
    "-tune",
    "stillimage",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
    outputPath,
  ];
}

/**
 * Maximum thumbnail frame dimensions (a bounding box, not a hard target) —
 * matches the app's existing "480p" rendition convention.
 *
 * @type {number}
 */
const THUMBNAIL_MAX_WIDTH = 426;

/**
 * @type {number}
 */
const THUMBNAIL_MAX_HEIGHT = 240;

/**
 * Builds the `-vf` scaling expression for a thumbnail frame: fit within
 * {@link THUMBNAIL_MAX_WIDTH}x{@link THUMBNAIL_MAX_HEIGHT} as a bounding box
 * (never upscale), preserving the source aspect ratio, and round both
 * dimensions to even numbers (`trunc(x/2)*2`) since that's required by most
 * pixel formats/encoders. Uses the software `scale` filter's built-in
 * `force_original_aspect_ratio` option.
 *
 * @returns {string} A `-vf` filter expression.
 */
function buildThumbnailScaleFilter() {
  return `scale='min(${THUMBNAIL_MAX_WIDTH},iw)':'min(${THUMBNAIL_MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease`;
}

/**
 * Builds the ffmpeg argument list for a single-frame thumbnail extraction.
 * Deliberately bypasses the transcoding-enabled/hardware-acceleration gating
 * in `validateTranscodeProfile`/`shouldSkipHardwareProfile` (see
 * `validateTranscodeJob`) — this is a lightweight frame grab, not a real
 * transcode, and `ENABLE_TRANSCODING=false` shouldn't block it. It still
 * decodes via hardware acceleration when this deployment has it configured
 * (see {@link resolveDecodeHardwareAccelArgs}), mirroring the decode-side
 * input args {@link buildFfmpegArgs} uses for a real transcode.
 *
 * Encodes to WebP for efficient web delivery.
 *
 * @param {object} options Thumbnail execution options.
 * @param {string} options.inputPath Absolute path to the source video file.
 * @param {string} options.outputPath Absolute path for the output `.webp` file.
 * @param {number} options.timestampSeconds Frame timestamp to seek to, in seconds.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildThumbnailFfmpegArgs({
  inputPath,
  outputPath,
  timestampSeconds,
}) {
  const config = getTranscodeConfig();
  const hwArgs = resolveDecodeHardwareAccelArgs(config);

  return [
    "-y",
    ...hwArgs,
    "-ss",
    String(timestampSeconds),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-vf",
    buildThumbnailScaleFilter(),
    "-c:v",
    "libwebp",
    "-quality",
    "70",
    outputPath,
  ];
}

/**
 * Builds the ffmpeg argument list for extracting an embedded cover-art /
 * attached-thumbnail stream (see `probeEmbeddedThumbnailStream`) as the video's
 * thumbnail, rather than decoding and grabbing a frame at a timestamp. Reuses
 * the same bounding-box scale + WebP encode as {@link buildThumbnailFfmpegArgs}
 * so both paths produce an equivalent output regardless of source.
 *
 * @param {object} options Thumbnail execution options.
 * @param {string} options.inputPath Absolute path to the source media file.
 * @param {string} options.outputPath Absolute path for the output `.webp` file.
 * @param {number} options.streamIndex ffmpeg stream index of the attached picture.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildEmbeddedThumbnailFfmpegArgs({
  inputPath,
  outputPath,
  streamIndex,
}) {
  return [
    "-y",
    "-i",
    inputPath,
    "-map",
    `0:${streamIndex}`,
    "-frames:v",
    "1",
    "-an",
    "-sn",
    "-vf",
    buildThumbnailScaleFilter(),
    "-c:v",
    "libwebp",
    "-quality",
    "70",
    outputPath,
  ];
}

/**
 * Builds the ffmpeg argument list for extracting a subtitle stream (see
 * `probeAllSubtitleStreams`) into a standalone `.vtt` file. ffmpeg's `webvtt`
 * subtitle encoder converts directly from any of the supported text-based
 * source codecs, so this always produces valid WebVTT regardless of the
 * source's own subtitle codec — no separate conversion step needed.
 *
 * @param {object} options Subtitle extraction options.
 * @param {string} options.inputPath Absolute path to the source media file.
 * @param {string} options.outputPath Absolute path for the output `.vtt` file.
 * @param {number} options.streamIndex ffmpeg stream index of the subtitle track.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildSubtitleFfmpegArgs({ inputPath, outputPath, streamIndex }) {
  return ["-y", "-i", inputPath, "-map", `0:${streamIndex}`, "-c:s", "webvtt", outputPath];
}

/**
 * Target time gap, in seconds, between consecutive storyboard tiles for a
 * video short enough that {@link STORYBOARD_MAX_TILES} wouldn't otherwise be
 * reached - the seek-bar hover-scrub preview everyone recognizes from
 * YouTube samples roughly this often. Longer videos get a wider gap instead
 * (see {@link computeStoryboardLayout}), so the sprite sheet never grows
 * past the tile cap regardless of how long the source runs.
 *
 * @type {number}
 */
const STORYBOARD_DEFAULT_INTERVAL_SECONDS = 10;

/**
 * Hard cap on how many tiles a single storyboard sprite sheet may contain,
 * regardless of source duration - without this, a multi-hour recording
 * would produce an enormous sprite image. {@link computeStoryboardLayout}
 * widens the sampling interval instead of exceeding this.
 *
 * @type {number}
 */
const STORYBOARD_MAX_TILES = 100;

/**
 * Pixel dimensions of a single storyboard tile. Deliberately small - this
 * is a seek-bar hover preview, not a real thumbnail.
 *
 * @type {{ width: number, height: number }}
 */
export const STORYBOARD_TILE_SIZE = { width: 160, height: 90 };

/**
 * Fixed basenames written into a `"storyboard"` job's output directory (see
 * `resolveStoryboardOutputDir`) — always the same two names regardless of
 * input, since each upload gets its own directory. The sprite's own
 * basename is also what the VTT sidecar references (`sprite.jpg#xywh=...`),
 * since both files live side by side in that same directory.
 *
 * @type {{ sprite: string, vtt: string }}
 */
export const STORYBOARD_OUTPUT_FILENAMES = {
  sprite: "sprite.jpg",
  vtt: "storyboard.vtt",
};

/**
 * Computes a storyboard sprite sheet's layout for a source of the given
 * duration: how far apart (in seconds) consecutive tiles are sampled, how
 * many tiles that yields, and a roughly-square grid to arrange them in.
 * Starts from {@link STORYBOARD_DEFAULT_INTERVAL_SECONDS} and widens the
 * interval as needed to keep the tile count at or below
 * {@link STORYBOARD_MAX_TILES} - so a 5-minute video still gets a tile every
 * 10 seconds, while a 5-hour one gets a wider gap instead of a 1800-tile
 * image. Always yields at least one tile, even for a source shorter than
 * one interval.
 *
 * @param {number} durationSeconds Probed source duration in whole seconds.
 * @returns {{ intervalSeconds: number, tileCount: number, columns: number, rows: number }}
 *   The computed layout.
 */
export function computeStoryboardLayout(durationSeconds) {
  const safeDuration = Math.max(durationSeconds, 1);
  const intervalSeconds = Math.max(
    STORYBOARD_DEFAULT_INTERVAL_SECONDS,
    Math.ceil(safeDuration / STORYBOARD_MAX_TILES),
  );
  const tileCount = Math.min(
    STORYBOARD_MAX_TILES,
    Math.max(1, Math.ceil(safeDuration / intervalSeconds)),
  );
  const columns = Math.ceil(Math.sqrt(tileCount));
  const rows = Math.ceil(tileCount / columns);
  return { intervalSeconds, tileCount, columns, rows };
}

/**
 * Builds the ffmpeg argument list for a `"storyboard"` job: samples one
 * frame every `intervalSeconds` from the original upload (via the `fps`
 * filter, which resamples by wall-clock time rather than frame count - no
 * need to know the source's own frame rate, unlike a `select='not(mod(n,N))'`
 * frame-skip approach), scales/letterboxes each to a uniform
 * {@link STORYBOARD_TILE_SIZE} cell, and tiles them into one sprite image in
 * a single pass. `-frames:v 1` stops ffmpeg after writing exactly one tiled
 * page — without it, `tile` would keep buffering further pages for any
 * sampled frames beyond `columns*rows`, which never happens given how
 * `computeStoryboardLayout` sizes the grid, but pinning it removes any doubt.
 *
 * @param {object} options Storyboard execution options.
 * @param {string} options.inputPath Absolute path to the original upload.
 * @param {string} options.outputPath Absolute path for the output sprite image.
 * @param {number} options.intervalSeconds Seconds between sampled frames.
 * @param {number} options.columns Grid columns.
 * @param {number} options.rows Grid rows.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildStoryboardFfmpegArgs({ inputPath, outputPath, intervalSeconds, columns, rows }) {
  const { width, height } = STORYBOARD_TILE_SIZE;
  return [
    "-y",
    "-i",
    inputPath,
    "-vf",
    `fps=1/${intervalSeconds},` +
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,` +
      `tile=${columns}x${rows}`,
    "-frames:v",
    "1",
    // Without this, ffmpeg's image2 muxer warns that a single-file output
    // path isn't a sequence pattern (e.g. "%03d") and only writes anyway
    // because -frames:v happens to cap it at one - -update says outright
    // "yes, a single still image, intentionally."
    "-update",
    "1",
    "-an",
    outputPath,
  ];
}

/**
 * Formats a non-negative second count as a WebVTT timestamp
 * (`HH:MM:SS.mmm`).
 *
 * @param {number} totalSeconds Seconds, may be fractional.
 * @returns {string} WebVTT-formatted timestamp.
 */
function formatVttTimestamp(totalSeconds) {
  const wholeMs = Math.round(totalSeconds * 1000);
  const hours = Math.floor(wholeMs / 3_600_000);
  const minutes = Math.floor((wholeMs % 3_600_000) / 60_000);
  const seconds = Math.floor((wholeMs % 60_000) / 1000);
  const milliseconds = wholeMs % 1000;
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}.${pad(milliseconds, 3)}`;
}

/**
 * Builds the WebVTT sidecar mapping each time range to its tile's region of
 * the sprite image, via the `#xywh=x,y,w,h` media-fragment syntax every
 * seek-bar hover-preview implementation (and this app's own player) expects.
 * Tiles are addressed in the same row-major order ffmpeg's `tile` filter
 * fills them in. The final cue's end time is clamped to the real source
 * duration rather than running a full interval past it, since
 * `computeStoryboardLayout` rounds the tile count up (the last tile may
 * cover a shorter-than-usual span).
 *
 * @param {object} options Layout + metadata.
 * @param {number} options.durationSeconds Probed source duration.
 * @param {number} options.intervalSeconds Seconds between sampled frames.
 * @param {number} options.tileCount Total tiles actually laid out.
 * @param {number} options.columns Grid columns.
 * @param {string} options.spriteFilename Sprite image's own basename (sits
 *   alongside this VTT in the same output directory).
 * @returns {string} WebVTT file contents, newline-terminated.
 */
export function buildStoryboardVtt({
  durationSeconds,
  intervalSeconds,
  tileCount,
  columns,
  spriteFilename,
}) {
  const { width, height } = STORYBOARD_TILE_SIZE;
  const lines = ["WEBVTT", ""];

  for (let index = 0; index < tileCount; index++) {
    const start = index * intervalSeconds;
    const end = Math.min(start + intervalSeconds, durationSeconds);
    const col = index % columns;
    const row = Math.floor(index / columns);
    lines.push(
      `${formatVttTimestamp(start)} --> ${formatVttTimestamp(end)}`,
      `${spriteFilename}#xywh=${col * width},${row * height},${width},${height}`,
      "",
    );
  }

  return `${lines.join("\n")}\n`;
}

/**
 * Target length, in seconds, of the hover-preview clip generated for a
 * `"preview"` job - long enough to show real motion, short enough to stay a
 * cheap, tiny file suitable for autoplaying on every video grid card a user
 * hovers.
 *
 * @type {number}
 */
const PREVIEW_CLIP_DURATION_SECONDS = 3;

/**
 * Where to start the preview clip, as a fraction of the source's total
 * duration - 25% in rather than 0 skips opening titles/black frames and
 * tends to land somewhere more representative of the video's actual content.
 *
 * @type {number}
 */
const PREVIEW_CLIP_START_FRACTION = 0.25;

/**
 * Maximum frame dimensions for a preview clip (a bounding box, not a hard
 * target) - these are tiny hover-preview thumbnails, not a real rendition,
 * so a small cap keeps encode time and file size negligible.
 *
 * @type {number}
 */
const PREVIEW_CLIP_MAX_WIDTH = 480;

/**
 * @type {number}
 */
const PREVIEW_CLIP_MAX_HEIGHT = 270;

/**
 * Computes the `-ss`/`-t` window to cut a preview clip from, given the
 * source's probed duration. Starts {@link PREVIEW_CLIP_START_FRACTION} of
 * the way in, then clamps so the clip never runs past the end of a short
 * video - at the extreme (a video shorter than
 * {@link PREVIEW_CLIP_DURATION_SECONDS}), this falls back to the entire
 * video starting at 0.
 *
 * @param {number} durationSeconds Probed source duration, in seconds.
 * @returns {{ startSeconds: number, durationSeconds: number }} The ffmpeg
 *   `-ss`/`-t` window to cut.
 */
export function computePreviewClipWindow(durationSeconds) {
  const safeDuration = Math.max(durationSeconds, 0.1);
  const clipDuration = Math.min(PREVIEW_CLIP_DURATION_SECONDS, safeDuration);
  const idealStart = safeDuration * PREVIEW_CLIP_START_FRACTION;
  const startSeconds = Math.max(0, Math.min(idealStart, safeDuration - clipDuration));
  return { startSeconds, durationSeconds: clipDuration };
}

/**
 * Builds the ffmpeg argument list for a `"preview"` job: cut a short, muted,
 * silent clip from the original upload for hover-preview on a video grid
 * card. Same technique as `buildEmbedFfmpegArgs` (a tiny, always-playable
 * MP4) but sourced from a real video segment instead of a looped still
 * image - the webview player simply sets `loop` on the resulting `<video>`
 * element rather than ffmpeg looping it server-side, since the clip is
 * already short.
 *
 * `-ss` before `-i` (input seeking) trades keyframe-accurate seeking for
 * speed, which is the right call here - a hover preview doesn't need to
 * start at an exact frame, and this is cheap to run on every upload. `-an`
 * drops audio entirely (the clip is always muted on autoplay, and dropping
 * the stream outright is simpler and smaller than muxing silence). The
 * scale+pad filter mirrors `buildEmbedFfmpegArgs`'s bounding-box fit and
 * even-dimension rounding, required for H.264.
 *
 * @param {object} options Preview clip execution options.
 * @param {string} options.inputPath Absolute path to the source video file.
 * @param {string} options.outputPath Absolute path for the output `.mp4` file.
 * @param {number} options.startSeconds Clip start offset, in seconds.
 * @param {number} options.durationSeconds Clip length, in seconds.
 * @returns {string[]} Argument vector suitable for `execFile("ffmpeg", args)`.
 */
export function buildPreviewClipFfmpegArgs({
  inputPath,
  outputPath,
  startSeconds,
  durationSeconds,
}) {
  return [
    "-y",
    "-ss",
    String(startSeconds),
    "-i",
    inputPath,
    "-t",
    String(durationSeconds),
    "-vf",
    `scale='min(${PREVIEW_CLIP_MAX_WIDTH},iw)':'min(${PREVIEW_CLIP_MAX_HEIGHT},ih)':force_original_aspect_ratio=decrease,pad='ceil(iw/2)*2':'ceil(ih/2)*2'`,
    "-an",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-f",
    "mp4",
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
