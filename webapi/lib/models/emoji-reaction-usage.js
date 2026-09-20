import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";
import { timestampColumn } from "./attribute-helpers.js";

/**
 * EMOJI_REACTION_USAGE table model. A running tally of how often each emoji has
 * been used as a CAST reaction, so the reaction bar can show the instance's
 * most-used emoji instead of a hardcoded list.
 *
 * Deliberately a counter (one row per distinct emoji) rather than a log of
 * every reaction: ranking only needs totals, and a counter stays bounded no
 * matter how many reactions are sent. `emoji` is the primary key, so recording
 * a use is an upsert-and-increment with no lookup table in between.
 *
 * The column is a plain STRING(32), not `constrainedString` from
 * ./attribute-helpers.js - that helper is STRING(16) and validates against a
 * closed value list, which is the opposite of an open-ended emoji set. 32 is
 * sized for multi-codepoint ZWJ sequences (👨‍👩‍👧‍👦 alone is 11 UTF-16 units).
 *
 * @type {import('sequelize').ModelStatic<import('sequelize').Model>}
 */
export const EmojiReactionUsage = sequelize.define(
  "EmojiReactionUsage",
  {
    emoji: {
      type: DataTypes.STRING(32),
      allowNull: false,
      primaryKey: true,
    },
    useCount: {
      type: DataTypes.INTEGER.UNSIGNED,
      allowNull: false,
      defaultValue: 0,
      field: "use_count",
    },
    lastUsedAt: timestampColumn("last_used_at"),
  },
  {
    tableName: "EMOJI_REACTION_USAGE",
    timestamps: false,
    indexes: [
      {
        fields: ["use_count"],
        name: "idx_emoji_reaction_usage_count",
      },
    ],
  },
);
