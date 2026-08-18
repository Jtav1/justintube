import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { constrainedString, timestampColumn } from "./attribute-helpers.js";

/**
 * CAST_QUEUE_ITEMS table model. One row per video in a CAST session's live
 * queue. There is no separate history table: a row's lifecycle is tracked
 * entirely through `status` — "queued" while pending, "playing" for the
 * single current item, and "played"/"skipped" once it's done, at which point
 * it *is* the history (ordered by `playedAt DESC`). "removed" is a soft
 * delete so removed items don't disrupt `position` bookkeeping for the rest
 * of the queue. At most one row per session may be "playing" at a time; that
 * invariant is enforced by `lib/cast/queue-service.js`, not the database.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const CastQueueItem = sequelize.define(
  "CastQueueItem",
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
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    addedByUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    status: constrainedString(["queued", "playing", "played", "skipped", "removed"], {
      allowNull: false,
      defaultValue: "queued",
    }),
    position: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    addedAt: timestampColumn("added_at"),
    playedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    tableName: "CAST_QUEUE_ITEMS",
    timestamps: true,
    createdAt: "addedAt",
    updatedAt: false,
    indexes: [
      {
        fields: ["cast_session_id", "status", "position"],
        name: "idx_cast_queue_items_session_status_position",
      },
    ],
  },
);
