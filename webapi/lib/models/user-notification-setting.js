import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * USER_NOTIFICATION_SETTINGS table model. Stores a user's per-type notification
 * preferences; `notificationTypeId` references NOTIFICATION_TYPES and is
 * nullable (no row for a type defaults both `enabled` and `emailEnabled` to
 * true, see the routes that read this table). `enabled` gates in-app/tray
 * delivery; `emailEnabled` gates email delivery - the two are independent.
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
    notificationTypeId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    emailEnabled: {
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
        fields: ["user_id", "notification_type_id"],
        name: "uq_user_notification_settings_user_type_id",
      },
    ],
  },
);
