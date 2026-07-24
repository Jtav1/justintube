import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * VIDEO_TRANSFER_MAPPING table model. Maps a Justintube user to a MediaCMS user
 * id for migration. Populated manually by a database administrator.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const VideoTransferMapping = sequelize.define(
  "VideoTransferMapping",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      unique: "uq_video_transfer_mapping_user",
    },
    mediacmsUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      unique: "uq_video_transfer_mapping_mediacms_user",
    },
  },
  {
    tableName: "VIDEO_TRANSFER_MAPPING",
    timestamps: false,
  },
);
