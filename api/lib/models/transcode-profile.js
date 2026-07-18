import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * TRANSCODE_PROFILES table model. Defines how uploaded videos should be
 * transcoded (dimensions, container, and codecs). Referenced by FILE_VERSIONS.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const TranscodeProfile = sequelize.define(
  "TranscodeProfile",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    outputHeight: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    outputWidth: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    outputContainer: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    videoCodec: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    audioCodec: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
    creatorUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "TRANSCODE_PROFILES",
    timestamps: true,
  },
);
