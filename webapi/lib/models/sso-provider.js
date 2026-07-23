import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * SSO_PROVIDERS table model. Catalog of single sign-on providers that users can
 * link an external identity to.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const SsoProvider = sequelize.define(
  "SsoProvider",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    providerKey: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: "uq_sso_providers_key",
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
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
    tableName: "SSO_PROVIDERS",
    timestamps: true,
  },
);
