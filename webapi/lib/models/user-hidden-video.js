import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * USER_HIDDEN_VIDEOS table model. Records that a user has hidden a video from
 * their own feeds/listings (a per-viewer preference, distinct from
 * VIDEO_METADATA.visibility). Existence of a row is the hidden state; at most
 * one row per (user, upload).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const UserHiddenVideo = sequelize.define(
  "UserHiddenVideo",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "USER_HIDDEN_VIDEOS",
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ["user_id", "original_upload_id"],
        name: "uq_user_hidden_videos_user_upload",
      },
    ],
  },
);
