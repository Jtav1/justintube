import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";

/**
 * CAST_SESSIONS table model. A shared watch session: a join code, an owner,
 * an optional source playlist the queue was copied from (the source is never
 * mutated), and a server-authoritative playback clock (`playbackStatus` +
 * `playbackPositionSeconds` + `playbackUpdatedAt`) that every connected
 * member's player syncs against. `code` is only unique among `status:
 * "active"` rows (checked in `lib/cast/codes.js`, not enforced by a DB
 * constraint) so an ended session's old code can be safely reused.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const CastSession = sequelize.define(
  "CastSession",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    code: {
      type: DataTypes.STRING(8),
      allowNull: false,
    },
    status: constrainedString(["active", "ended"], {
      allowNull: false,
      defaultValue: "active",
    }),
    ownerUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    sourcePlaylistId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    title: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    playbackStatus: constrainedString(["playing", "paused"], {
      allowNull: false,
      defaultValue: "paused",
    }),
    playbackPositionSeconds: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    // DATE(3), not plain DATE: MySQL's DATETIME defaults to second precision,
    // which rounds away the milliseconds `effectivePosition` subtracts against
    // and leaves up to half a second of noise in every member's sync target.
    // SQLite stores ISO strings, so the precision arg is a no-op there.
    playbackUpdatedAt: {
      type: DataTypes.DATE(3),
      allowNull: true,
    },
    endedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "CAST_SESSIONS",
    timestamps: true,
    indexes: [
      { fields: ["code"], name: "idx_cast_sessions_code" },
      { fields: ["status"], name: "idx_cast_sessions_status" },
      { fields: ["owner_user_id"], name: "idx_cast_sessions_owner" },
    ],
  },
);
