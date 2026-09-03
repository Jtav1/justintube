import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * VIDEO_SUBTITLE table model. Stores one caption/subtitle track for an
 * original upload (many rows per ORIGINAL_UPLOADS record, e.g. one per
 * language), always as WebVTT (.vtt) regardless of whether it was
 * auto-extracted from an embedded subtitle stream or uploaded directly by
 * the owner/admin.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const VideoSubtitle = sequelize.define(
  "VideoSubtitle",
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
    // Human-readable label shown to viewers, e.g. "English" or "Director's commentary".
    label: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    subtitleFilename: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    // 'user' (owner/admin uploaded it directly) | 'auto' (extracted from
    // the original file's embedded subtitle stream by processing).
    source: {
      type: DataTypes.STRING(16),
      allowNull: false,
      defaultValue: "auto",
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "VIDEO_SUBTITLE",
    timestamps: true,
  },
);
