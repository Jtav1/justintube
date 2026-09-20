import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";

/**
 * CAST_SESSION_MEMBERS table model. Tracks who belongs to a CAST session.
 * `status: "kicked"` is durable (never deleted) so a kicked user's rejoin
 * attempt (`joinSessionByCode`) can be permanently rejected; a normal
 * leave/rejoin instead flips the same row between "active" and "left" rather
 * than inserting a new row, per the unique `(castSessionId, userId)` index.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const CastSessionMember = sequelize.define(
  "CastSessionMember",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    castSessionId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    role: constrainedString(["owner", "member"], {
      allowNull: false,
      defaultValue: "member",
    }),
    status: constrainedString(["active", "left", "kicked"], {
      allowNull: false,
      defaultValue: "active",
    }),
    joinedAt: timestampColumn("joined_at"),
    leftAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "CAST_SESSION_MEMBERS",
    timestamps: true,
    createdAt: "joinedAt",
    updatedAt: false,
    indexes: [
      {
        unique: true,
        fields: ["cast_session_id", "user_id"],
        name: "uq_cast_session_members",
      },
    ],
  },
);
