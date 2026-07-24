import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * USER_API_KEYS table model. Many static API keys per user for direct API
 * access. The raw key is never stored; only a SHA-256 hash and a non-secret
 * prefix are persisted. Expired (`expiresAt`) or revoked (`revokedAt`) keys
 * must be rejected by auth middleware.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const UserApiKey = sequelize.define(
  "UserApiKey",
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
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING(2000),
      allowNull: true,
    },
    keyHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: "uq_user_api_keys_key_hash",
    },
    keyPrefix: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "USER_API_KEYS",
    timestamps: true,
    indexes: [
      {
        fields: ["user_id"],
        name: "idx_user_api_keys_user_id",
      },
    ],
  },
);
