import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * USER_API_KEY_SCOPES table model. Join row granting one API_KEY_SCOPES
 * entry to one USER_API_KEYS row; a key holds the union of its granted
 * scopes. Unique per (key, scope) so a grant is never duplicated.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const UserApiKeyScope = sequelize.define(
  "UserApiKeyScope",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userApiKeyId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    apiKeyScopeId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    createdAt: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: sequelize.literal("CURRENT_TIMESTAMP"),
      field: "created_at",
    },
  },
  {
    tableName: "USER_API_KEY_SCOPES",
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ["user_api_key_id", "api_key_scope_id"],
        name: "uq_user_api_key_scopes_key_scope",
      },
    ],
  },
);
