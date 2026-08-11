import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";
import { VISIBILITY_VALUES } from "./constants.js";

/**
 * Allowed LIVESTREAMS.status values.
 *
 * @type {string[]}
 */
export const LIVESTREAM_STATUS_VALUES = ["offline", "live"];

/**
 * LIVESTREAMS table model. One row per user's livestream "channel" - reused
 * across sessions (created on first successful RTMP authorize, flipped
 * between `offline`/`live` by the ingest server's start/stop callbacks; see
 * `routes/internal-livestreams.js`).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const Livestream = sequelize.define(
  "Livestream",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      unique: "uq_livestreams_user_id",
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    visibility: constrainedString(VISIBILITY_VALUES, {
      allowNull: false,
      defaultValue: "private",
    }),
    status: constrainedString(LIVESTREAM_STATUS_VALUES, {
      allowNull: false,
      defaultValue: "offline",
    }),
    viewerCount: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
    },
    startedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "LIVESTREAMS",
    timestamps: true,
    indexes: [
      {
        fields: ["status"],
        name: "idx_livestreams_status",
      },
    ],
  },
);
