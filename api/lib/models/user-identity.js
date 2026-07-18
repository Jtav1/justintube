import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * USER_IDENTITIES table model. Links an internal USERS account to an external
 * identity at an SSO provider.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const UserIdentity = sequelize.define(
  "UserIdentity",
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
    providerId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    providerUserId: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "USER_IDENTITIES",
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ["provider_id", "provider_user_id"],
        name: "uq_user_identities_provider_subject",
      },
      {
        unique: true,
        fields: ["user_id", "provider_id"],
        name: "uq_user_identities_user_provider",
      },
    ],
  },
);
