import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * PLAYLIST_ACCESS table model. Grants a specific user permission to view a
 * private playlist. Unique per (playlist, user) so a grant is never duplicated.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const PlaylistAccess = sequelize.define(
  "PlaylistAccess",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    playlistId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "PLAYLIST_ACCESS",
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ["playlist_id", "user_id"],
        name: "uq_playlist_access_playlist_user",
      },
    ],
  },
);
