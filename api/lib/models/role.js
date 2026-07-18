import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * ROLES table model. Holds the authorization roles a user account can hold;
 * the standard roles are seeded on startup.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const Role = sequelize.define(
  "Role",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: "uq_roles_name",
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
    tableName: "ROLES",
    timestamps: true,
  },
);
