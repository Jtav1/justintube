import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import {
  PLAYLIST_KIND_VALUES,
  SEARCH_INDEX_STATUS_VALUES,
  VISIBILITY_VALUES,
} from "./constants.js";

/**
 * USER_PLAYLISTS table model. Stores playlists owned by a user.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const UserPlaylist = sequelize.define(
  "UserPlaylist",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: false,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    visibility: constrainedString(VISIBILITY_VALUES, {
      allowNull: false,
      defaultValue: "private",
    }),
    kind: constrainedString(PLAYLIST_KIND_VALUES, {
      allowNull: false,
      defaultValue: "standard",
    }),
    lastAddedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    searchIndexStatus: constrainedString(SEARCH_INDEX_STATUS_VALUES, {
      allowNull: false,
      defaultValue: "pending",
    }),
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "USER_PLAYLISTS",
    timestamps: true,
  },
);
