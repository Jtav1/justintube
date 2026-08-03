import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * USER_NOTIFICATION_SETTINGS table model. Stores a user's per-type
 * notification preferences; `notificationTypeId` references
 * NOTIFICATION_TYPES. Every user is expected to have an explicit row for
 * every active notification type - seeded with that type's default values
 * (`getNotificationTypeDefaults` in `lib/seed.js`) when their account is
 * created, and reconciled on every boot by `ensureUserNotificationSettings`
 * (covers types added after a user registered). `enabled` gates in-app/tray
 * delivery; `emailEnabled` gates email delivery - the two are independent.
 * `notificationTypeId` stays nullable at the column level for schema
 * flexibility, but in practice every row is created against a real type.
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
