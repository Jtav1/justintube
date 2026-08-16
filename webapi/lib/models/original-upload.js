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
    uploadedAt: timestampColumn("uploaded_at"),
  },
  {
    tableName: "ORIGINAL_UPLOADS",
    timestamps: true,
    createdAt: "uploadedAt",
    updatedAt: false,
  },
);
