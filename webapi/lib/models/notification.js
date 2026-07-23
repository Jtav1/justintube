import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import { NOTIFICATION_TYPES } from "./constants.js";

/**
 * NOTIFICATIONS table model. One row per notification delivered to a target
 * user; `notificationType` is constrained to NOTIFICATION_TYPES and `readAt`
 * is null until read.
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
    notificationType: constrainedString(NOTIFICATION_TYPES, {
      allowNull: false,
    }),
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    readAt: {
      type: DataTypes.DATE,
      allowNull: true,
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
