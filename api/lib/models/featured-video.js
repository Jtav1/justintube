import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * FEATURED_VIDEOS table model. The curated set of uploads promoted in the
 * featured carousel; unique per upload so a video is featured at most once. Delete on id.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const FeaturedVideo = sequelize.define(
  "FeaturedVideo",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    originalUploadId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      unique: "uq_featured_videos_upload",
    },
    createdAt: timestampColumn("created_at"),
  },
  {
    tableName: "FEATURED_VIDEOS",
    timestamps: true,
    createdAt: "createdAt",
    updatedAt: false,
  },
);
