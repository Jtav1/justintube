import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * VIDEO_THUMBNAIL table model. Stores the thumbnail produced for an original
 * upload (one row per ORIGINAL_UPLOADS record).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const VideoThumbnail = sequelize.define(
  "VideoThumbnail",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      unique: "uq_video_thumbnail_upload",
    },
    thumbnailFilename: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "VIDEO_THUMBNAIL",
    timestamps: true,
  },
);
