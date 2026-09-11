import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * DUPLICATE_UPLOAD_FLAGS table model. One row per possible-duplicate match a
 * content-hash job surfaces, created when a new upload's computed
 * `contentHash` matches an already-live upload. Reviewed by an admin or
 * moderator via `PATCH /admin/duplicate-uploads/:id/moderate`, which resolves
 * whether the new upload is kept (released to transcode) or discarded in
 * favor of the existing one. Both upload references use `onDelete: SET NULL`
 * so this row survives either side being deleted later, preserving the
 * moderation history.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const DuplicateUploadFlag = sequelize.define(
  "DuplicateUploadFlag",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    newOriginalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    existingOriginalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    contentHash: {
      type: DataTypes.STRING(128),
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: "pending",
    },
    resolution: {
      type: DataTypes.STRING(32),
      allowNull: true,
    },
    moderatorUserId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: true,
    },
    moderatorComment: {
      type: DataTypes.STRING(500),
      allowNull: true,
    },
    resolvedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "DUPLICATE_UPLOAD_FLAGS",
    timestamps: true,
    updatedAt: false,
  },
);
