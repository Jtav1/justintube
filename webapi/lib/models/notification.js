import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * NOTIFICATIONS table model. One row per notification delivered to a target
 * user; `notificationTypeId` references NOTIFICATION_TYPES and `readAt` is
 * null until read.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const Notification = sequelize.define(
  "Notification",
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
    notificationTypeId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    /**
     * Linkable data related to this notification, for the frontend to build
     * a link from (e.g. a video's public `videoId` for like/comment
     * notifications). Null when a notification has nothing to link to.
     */
    target: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    /**
     * Soft-delete flag set when the owning user deletes this notification
     * from their tray/notifications page. The row is kept (not removed) but
     * excluded from all listing queries.
     */
    deleted: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "NOTIFICATIONS",
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: false,
  },
);
