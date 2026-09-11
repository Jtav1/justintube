import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * NOTIFICATION_TYPES table model. Lookup table of the notification types a
 * user can receive and toggle in their preferences; the standard types are
 * seeded on startup.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const NotificationType = sequelize.define(
  "NotificationType",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: "uq_notification_types_name",
    },
    description: {
      type: DataTypes.STRING(255),
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
    tableName: "NOTIFICATION_TYPES",
    timestamps: true,
  },
);
