import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import { SEARCH_INDEX_STATUS_VALUES } from "./constants.js";

/**
 * USERS table model. One row per account; local accounts store a bcrypt hash in
 * `passwordHash` (nullable for SSO-only accounts). When `passwordExpired` is
 * true, the account must change its password (e.g. after an admin reset).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    username: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: "uq_users_username",
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: "uq_users_email",
    },
    displayName: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    passwordHash: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    passwordExpired: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    bio: {
      type: DataTypes.STRING(5000),
      allowNull: true,
    },
    avatarFilename: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    bannerFilename: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    emailVerified: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    emailVerifiedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    uploader: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    roleId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    themeId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    searchIndexStatus: constrainedString(SEARCH_INDEX_STATUS_VALUES, {
      allowNull: false,
      defaultValue: "pending",
    }),
    lastLogIn: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "USERS",
    timestamps: true,
  },
);
