import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * ACCESS_PERMISSIONS table model. Holds the permission levels a VIDEO_ACCESS
 * or PLAYLIST_ACCESS grant row can reference ("view", "edit"); the standard
 * levels are seeded on startup, mirroring how ROLES backs USERS.roleId.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const AccessPermission = sequelize.define(
  "AccessPermission",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(16),
      allowNull: false,
      unique: "uq_access_permissions_name",
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "ACCESS_PERMISSIONS",
    timestamps: true,
  },
);
