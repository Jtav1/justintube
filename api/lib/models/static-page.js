import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * STATIC_PAGES table model. One row per block of pre-rendered, HTML-formatted
 * content shown on static pages; `contents` is capped below 10,000 characters.
 * `updatedBy` is the user ID of the last editor (nullable).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const StaticPage = sequelize.define(
  "StaticPage",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    contents: {
      type: DataTypes.STRING(9999),
      allowNull: false,
      validate: {
        len: [1, 9999],
      },
    },
    updatedBy: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "STATIC_PAGES",
    timestamps: true,
  },
);
