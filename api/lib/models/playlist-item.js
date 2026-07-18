import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * PLAYLIST_ITEMS table model. Join table linking playlists to the original
 * uploads they contain.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const PlaylistItem = sequelize.define(
  "PlaylistItem",
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
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    position: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    addedAt: timestampColumn("added_at"),
  },
  {
    tableName: "PLAYLIST_ITEMS",
    timestamps: true,
    createdAt: "addedAt",
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ["playlist_id", "original_upload_id"],
        name: "uq_playlist_items",
      },
    ],
  },
);
