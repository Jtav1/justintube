import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * CONTENT_TAGS table model. Stores one row per tag applied to an upload; unique
 * per (upload, tag) so a tag is not duplicated on a video.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const ContentTag = sequelize.define(
  "ContentTag",
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
    tag: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "CONTENT_TAGS",
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ["original_upload_id", "tag"],
        name: "uq_content_tags_upload_tag",
      },
    ],
  },
);
