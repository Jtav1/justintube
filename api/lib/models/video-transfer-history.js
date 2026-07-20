import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * VIDEO_TRANSFER_HISTORY table model. One row per MediaCMS video being
 * transferred; many rows belong to a single VIDEO_TRANSFER_MAPPING via
 * `mediacmsUserId`.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const VideoTransferHistory = sequelize.define(
  "VideoTransferHistory",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    mediacmsUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    videoFileName: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    videoFileDirectory: {
      type: DataTypes.STRING(512),
      allowNull: false,
    },
    videoTitle: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    videoDescription: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    originalVideoUploadDate: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    videoTransferStatus: {
      type: DataTypes.STRING(32),
      allowNull: false,
    },
  },
  {
    tableName: "VIDEO_TRANSFER_HISTORY",
    timestamps: false,
  },
);
