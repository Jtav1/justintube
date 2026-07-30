import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * COMMENTS table model. One row per comment (or reply, via `parentCommentId`)
 * on a video. `distinguishedMod`/`distinguishedAdmin` mark a comment as
 * officially highlighted by a moderator/admin; `distinguishedAdmin` comments
 * cannot be deleted by moderators (only by their author or an admin).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const Comment = sequelize.define(
  "Comment",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    parentCommentId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    body: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    distinguishedMod: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    distinguishedAdmin: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "COMMENTS",
    timestamps: true,
  },
);
