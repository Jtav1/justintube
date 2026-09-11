import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * PASSWORD_RESET_TOKENS table model. Stores hashed one-time tokens for
 * self-service password resets. Raw tokens are never persisted.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const PasswordResetToken = sequelize.define(
  "PasswordResetToken",
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
    tokenHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: "uq_password_reset_tokens_token_hash",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "PASSWORD_RESET_TOKENS",
    timestamps: true,
    indexes: [
      {
        fields: ["user_id"],
        name: "idx_password_reset_tokens_user_id",
      },
    ],
  },
);
