'use strict';

// EMOJI_REACTION_USAGE backs the CAST reaction bar's "most used emoji" list.
// A counter (one row per distinct emoji), not a log of every reaction: ranking
// only needs totals, and this stays bounded however many reactions are sent.
// `emoji` is the primary key so recording a use is an upsert-and-increment.
// STRING(32) is sized for multi-codepoint ZWJ sequences - 👨‍👩‍👧‍👦 alone is
// 11 UTF-16 units. See lib/models/emoji-reaction-usage.js and
// lib/cast/emoji-usage.js.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("EMOJI_REACTION_USAGE", {
      emoji: {
        type: Sequelize.STRING(32),
        allowNull: false,
        primaryKey: true,
      },
      use_count: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        defaultValue: 0,
      },
      last_used_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });
    await queryInterface.addIndex("EMOJI_REACTION_USAGE", {
      fields: ["use_count"],
      name: "idx_emoji_reaction_usage_count",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("EMOJI_REACTION_USAGE");
  },
};
