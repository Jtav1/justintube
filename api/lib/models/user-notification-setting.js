import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * USER_NOTIFICATION_SETTINGS table model. Stores a user's per-type notification
 * preferences; `notificationType` is a free-form string reserved for future use.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const UserNotificationSetting = sequelize.define(
  "UserNotificationSetting",
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
    notificationType: {
      type: DataTypes.STRING(64),
      allowNull: true,
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "USER_NOTIFICATION_SETTINGS",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["user_id", "notification_type"],
        name: "uq_user_notification_settings_user_type",
      },
    ],
  },
);
