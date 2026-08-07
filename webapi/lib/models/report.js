import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import { REPORT_TYPE_VALUES } from "./constants.js";

/**
 * REPORTS table model. A single row per user-filed policy report against a
 * video, user, playlist, or the website/system in general.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const Report = sequelize.define(
  "Report",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    reporterUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    reportType: constrainedString(REPORT_TYPE_VALUES, { allowNull: false }),
    link: {
      type: DataTypes.STRING(2048),
      allowNull: true,
    },
    videoId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    reportedUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    playlistId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    description: {
      type: DataTypes.STRING(1000),
      allowNull: false,
    },
    resolved: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    comment: {
      type: DataTypes.STRING(1000),
      allowNull: true,
    },
    commenterUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "REPORTS",
    timestamps: true,
  },
);
