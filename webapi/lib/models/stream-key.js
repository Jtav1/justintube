import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * STREAM_KEYS table model. One active RTMP stream key per user, used to
 * authenticate OBS (or any RTMP-compatible encoder) publishing to the
 * livestream ingest server. Deliberately separate from USER_API_KEYS: a
 * leaked stream key should only be able to publish video, never call the
 * rest of the API. The raw key is never stored; only a SHA-256 hash and a
 * non-secret prefix are persisted, matching the API key pattern.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const StreamKey = sequelize.define(
  "StreamKey",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      unique: "uq_stream_keys_user_id",
    },
    keyHash: {
      type: DataTypes.STRING(64),
      allowNull: false,
      unique: "uq_stream_keys_key_hash",
    },
    keyPrefix: {
      type: DataTypes.STRING(16),
      allowNull: false,
    },
    lastUsedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    revokedAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "STREAM_KEYS",
    timestamps: true,
    indexes: [
      {
        fields: ["user_id"],
        name: "idx_stream_keys_user_id",
      },
    ],
  },
);
