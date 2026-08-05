import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * VIDEO_ACCESS table model. Grants a specific user access to a private
 * upload at a given permission level (see ACCESS_PERMISSIONS - "view" or
 * "edit"). Unique per (upload, user) so a grant is never duplicated.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const VideoAccess = sequelize.define(
  "VideoAccess",
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
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    permissionId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "VIDEO_ACCESS",
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ["original_upload_id", "user_id"],
        name: "uq_video_access_upload_user",
      },
    ],
  },
);
