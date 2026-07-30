import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * USER_VIEW_HISTORY table model. Records one row per video view by an authenticated user
 * (anonymous views only increment VIDEO_METADATA.view_count and are never recorded here). Unlike
 * VIDEO_LIKES there is no unique constraint — repeat views each get their own row.
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
  },
  {
    tableName: "USER_VIEW_HISTORY",
    timestamps: false,
    indexes: [
      {
        fields: ["user_id", "created_at"],
        name: "idx_user_view_history_user_created",
      },
    ],
  },
);
