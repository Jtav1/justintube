import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * API_KEY_SCOPES table model. Lookup table of the access levels a
 * USER_API_KEYS row can be granted ("view_only", "content_edit",
 * "profile_edit", "full_access"); the standard scopes are seeded on startup,
 * mirroring how ACCESS_PERMISSIONS backs VIDEO_ACCESS/PLAYLIST_ACCESS. A key
 * can hold more than one scope (see USER_API_KEY_SCOPES); "full_access" is
 * treated as a superset of the others rather than something combined with
 * them for a narrower grant.
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const ApiKeyScope = sequelize.define(
  "ApiKeyScope",
  {
    id: {
      type: DataTypes.INTEGER.UNSIGNED,
      autoIncrement: true,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(32),
      allowNull: false,
      unique: "uq_api_key_scopes_name",
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    createdAt: timestampColumn("created_at"),
    updatedAt: timestampColumn("updated_at"),
  },
  {
    tableName: "API_KEY_SCOPES",
    timestamps: true,
  },
);
