import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * USER_VIEW_HISTORY table model. Records one row per (user, video) pair for an authenticated
 * user (anonymous views only increment VIDEO_METADATA.view_count and are never recorded here).
 * Like VIDEO_LIKES, at most one row per (user, upload): repeat views upsert the existing row
 * rather than inserting a new one — `createdAt` stays the first-view time, `updatedAt` moves to
 * the most recent view.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const UserViewHistory = sequelize.define(
  "UserViewHistory",
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
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "USER_VIEW_HISTORY",
    timestamps: false,
    indexes: [
      {
        unique: true,
        fields: ["user_id", "original_upload_id"],
        name: "uq_user_view_history_user_upload",
      },
      {
        fields: ["user_id", "updated_at"],
        name: "idx_user_view_history_user_updated",
      },
    ],
  },
);
