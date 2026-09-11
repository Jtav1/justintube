import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * Regex matching a 6-character hex color without a leading `#` (e.g. "FFFFFF").
 *
 * @type {RegExp}
 */
export const HEX_COLOR_PATTERN = /^[0-9a-fA-F]{6}$/;

/**
 * String stored in `themeOwner` for system-wide (admin-managed) themes, as
 * opposed to a stringified USERS.id for a user-owned theme.
 *
 * @type {string}
 */
export const PUBLIC_THEME_OWNER = "public";

/**
 * THEMES table model. A theme is either owned by a user (`themeOwner` is
 * `String(userId)`) or system-wide (`themeOwner === PUBLIC_THEME_OWNER`).
 * At most one theme has `isDefault: true` at a time — it is the fallback
 * applied when a user has no `themeId` selection.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const Theme = sequelize.define(
  "Theme",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING(2000),
      allowNull: true,
    },
    color1: {
      type: DataTypes.STRING(6),
      allowNull: false,
      validate: { is: HEX_COLOR_PATTERN },
    },
    color2: {
      type: DataTypes.STRING(6),
      allowNull: false,
      validate: { is: HEX_COLOR_PATTERN },
    },
    color3: {
      type: DataTypes.STRING(6),
      allowNull: false,
      validate: { is: HEX_COLOR_PATTERN },
    },
    color4: {
      type: DataTypes.STRING(6),
      allowNull: false,
      validate: { is: HEX_COLOR_PATTERN },
    },
    color5: {
      type: DataTypes.STRING(6),
      allowNull: false,
      validate: { is: HEX_COLOR_PATTERN },
    },
    headerBackgroundFilename: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    sidebarBackgroundFilename: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    viewBackgroundFilename: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    footerBackgroundFilename: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    themeOwner: {
      type: DataTypes.STRING(64),
      allowNull: false,
    },
    isDefault: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "THEMES",
    timestamps: true,
  },
);
