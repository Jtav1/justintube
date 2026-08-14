import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import { VISIBILITY_VALUES } from "./constants.js";

/**
 * VIDEO_METADATA table model. Holds the screen-viewable metadata for a single
 * upload (one row per ORIGINAL_UPLOADS record).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const VideoMetadata = sequelize.define(
  "VideoMetadata",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      unique: "uq_video_metadata_upload",
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    viewCount: {
      type: DataTypes.BIGINT.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    visibility: constrainedString(VISIBILITY_VALUES, {
      allowNull: false,
      defaultValue: "private",
    }),
    commentsEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "VIDEO_METADATA",
    timestamps: true,
    indexes: [
      {
        fields: ["visibility", "created_at"],
        name: "idx_video_metadata_visibility_created_at",
      },
    ],
  },
);
