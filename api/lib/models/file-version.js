import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import { RESOLUTION_VALUES } from "./constants.js";

/**
 * FILE_VERSIONS table model. Stores transcoded copies of an upload, keyed to a
 * transcode profile instead of a user. Update status from pending to complete or failed.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const FileVersion = sequelize.define(
  "FileVersion",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    uuidName: {
      type: DataTypes.STRING(36),
      allowNull: false,
      unique: "uq_file_versions_uuid",
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
      defaultValue: "pending",
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
    transcodeProfileId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "FILE_VERSIONS",
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ["original_upload_id", "transcode_profile_id"],
        name: "uq_file_versions_variant",
      },
    ],
  },
);
