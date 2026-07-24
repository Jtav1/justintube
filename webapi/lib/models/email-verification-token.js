import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * EMAIL_VERIFICATION_TOKENS table model. Stores hashed one-time tokens for
 * confirming account email addresses. Raw tokens are never persisted.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const EmailVerificationToken = sequelize.define(
  "EmailVerificationToken",
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
      unique: "uq_email_verification_tokens_token_hash",
    },
    expiresAt: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "EMAIL_VERIFICATION_TOKENS",
    timestamps: true,
    indexes: [
      {
        fields: ["user_id"],
        name: "idx_email_verification_tokens_user_id",
      },
    ],
  },
);
