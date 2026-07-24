import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * SYSTEM_CONFIG table model. Stores arbitrary system-wide configuration
 * name/value pairs; `name` is unique.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const SystemConfig = sequelize.define(
  "SystemConfig",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    value: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "SYSTEM_CONFIG",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["name"],
        name: "uq_system_config_name",
      },
    ],
  },
);
