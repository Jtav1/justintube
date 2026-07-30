import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";
import { LIKE_VALUES } from "./constants.js";

/**
 * VIDEO_LIKES table model. Records a single user's reaction (1 = like, -1 = dislike) on an
 * upload. At most one row per (user, upload); toggling the same reaction again or switching
 * to the other reaction replaces/removes the row (see the like/dislike routes in routes/videos.js).
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
