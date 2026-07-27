import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import { RESOLUTION_VALUES } from "./constants.js";

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
    uuidName: {
      type: DataTypes.STRING(36),
      allowNull: false,
      unique: "uq_uuid_name",
    },
    fileExtension: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    mimeType: {
      type: DataTypes.STRING(128),
      allowNull: true,
    },
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
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
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
