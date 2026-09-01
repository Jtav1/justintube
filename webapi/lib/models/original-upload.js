import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import { MEDIA_TYPE_VALUES, RESOLUTION_VALUES, SEARCH_INDEX_STATUS_VALUES } from "./constants.js";

/**
 * ORIGINAL_UPLOADS table model. One row per uploaded source media file.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const OriginalUpload = sequelize.define(
  "OriginalUpload",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    originalFilename: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    videoId: {
      type: DataTypes.STRING(6).BINARY,
      allowNull: false,
      unique: "uq_video_id",
    },
    /**
     * Internal storage filename (no extension) — the on-disk basename for
     * this upload's original file, distinct from the public `videoId`. Never
     * exposed in API responses.
     */
    uuid: {
      type: DataTypes.STRING(36),
      allowNull: false,
      unique: "uq_original_uploads_uuid",
    },
    fileExtension: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    mimeType: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    mediaType: constrainedString(MEDIA_TYPE_VALUES, {
      allowNull: false,
      defaultValue: "video",
    }),
    fileSizeBytes: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: true,
    },
    storagePath: {
      type: DataTypes.STRING(512),
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "uploaded",
    },
    statusMessage: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    videoWidth: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    videoHeight: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    resolution: constrainedString(RESOLUTION_VALUES, { allowNull: true }),
    durationSeconds: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    /**
     * Requested thumbnail-frame timestamp, encoded as tenths-of-a-second
     * (e.g. 12.3s -> 123) so 0.1s precision fits in an INTEGER column.
     * Null means no timestamp was requested (processing picks a random one).
     */
    thumbnailTimestampTenths: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    /**
     * Mirrors the request-time `skipThumbnail` option. Persisted (rather than
     * threaded through as a plain function parameter, like the import flow
     * does) because a convertible-format upload's `finalizeUploadTranscodes`
     * call happens later, from the async `/internal/original-uploads/:jobId/
     * normalize-complete` callback - a separate HTTP request with no access
     * to the original request's in-memory state.
     */
    skipThumbnail: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    searchIndexStatus: constrainedString(SEARCH_INDEX_STATUS_VALUES, {
      allowNull: false,
      defaultValue: "pending",
    }),
    /**
     * ffmpeg decoded-video-stream sha256 hash (`sha256:<hex>`), used for
     * duplicate-upload detection. Null until a content-hash job completes;
     * stays null forever when ENABLE_DUPLICATE_UPLOAD_DETECTION is off.
     */
    contentHash: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
    /**
     * Whether ffprobe found a genuine, decodable video stream — distinct
     * from `mediaType` (an extension-based guess made at upload time that
     * can be wrong, e.g. an audio-only file in a `.mp4` container) and from
     * `videoWidth`/`videoHeight` being non-null (which an embedded cover-art
     * stream on an audio file can also produce - see `probeHasVideoStream`,
     * processing). Set from `source.hasVideoStream` in the initial
     * `/transcode` batch response (`finalizeUploadTranscodes`). Null until
     * that probe has run (or if it failed) - only an explicit `false` should
     * ever be treated as "definitely no video stream"; treat null the same
     * as `true` (fail open, matching existing probe-failure conventions).
     */
    hasVideoStream: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
    },
    /**
     * Storage path (under `transcoded/`) of the audio-only upload's
     * thumbnail-image + audio MP4, muxed purely so link-unfurl bots that only
     * render `og:video` (Discord in particular, which has no `og:audio`
     * player) have something genuinely playable to embed. Null until an
     * `"embed"` processing job completes for this upload; always null for
     * video uploads (they already have a real video stream to embed). See
     * `enqueueAudioEmbedVideo` (routes/uploads.js).
     */
    embedVideoStoragePath: {
      type: DataTypes.STRING(512),
      allowNull: true,
    },
    embedVideoWidth: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    embedVideoHeight: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    /**
     * Whether `embedVideoStoragePath` was muxed from the fixed placeholder
     * thumbnail (no real cover art/manual thumbnail exists for this upload
     * yet) rather than genuine art. Lets the `embed-complete` callback refuse
     * to let a slower placeholder-sourced completion overwrite a real one
     * that already landed (see `routes/internal-original-uploads.js`).
     */
    embedVideoIsDefault: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    uploadedAt: timestampColumn("uploaded_at"),
  },
  {
    tableName: "ORIGINAL_UPLOADS",
    timestamps: true,
    createdAt: "uploadedAt",
    updatedAt: false,
  },
);
