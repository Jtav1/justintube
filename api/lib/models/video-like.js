import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";
import { LIKE_VALUES } from "./constants.js";

/**
 * VIDEO_LIKES table model. Records a single user's like (1) on an upload. Delete likes
 * on "un liking" instead of storing a negative value to make sqlite happy.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const VideoLike = sequelize.define(
  "VideoLike",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    likeValue: {
      type: DataTypes.TINYINT,
      allowNull: false,
      validate: {
        isIn: [LIKE_VALUES],
      },
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "VIDEO_LIKES",
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ["user_id", "original_upload_id"],
        name: "uq_video_likes_user_upload",
      },
    ],
  },
);
