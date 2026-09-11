'use strict';

// Adds API key scoping: API_KEY_SCOPES is a lookup table (mirrors
// ACCESS_PERMISSIONS/NOTIFICATION_TYPES) of the levels a USER_API_KEYS row
// can be granted; USER_API_KEY_SCOPES is the join table since a key can hold
// more than one scope. See lib/models/api-key-scope.js and
// lib/models/user-api-key-scope.js for the corresponding models, and
// DEFAULT_API_KEY_SCOPES in lib/seed.js for the runtime source of truth this
// migration snapshots (lib/seed.js keeps seeding idempotently on every boot;
// this migration only needs to get a fresh, never-booted database, e.g.
// CI/test setup, to the same starting state).

const NOW = new Date();

const API_KEY_SCOPES = [
  {
    name: "view_only",
    description: "Read-only access to endpoints the key owner can already view.",
  },
  {
    name: "content_edit",
    description:
      "Create, update, and delete the key owner's videos, playlists, comments, and " +
      "other content, plus content-interaction actions (likes, hides, reports).",
  },
  {
    name: "profile_edit",
    description:
      "Update the key owner's own profile, avatar/banner, theme, notification " +
      "preferences, and subscriptions.",
  },
  {
    name: "full_access",
    description:
      "Full account-equivalent access, including admin actions (if the owner is an " +
      "admin) and managing the owner's own API keys.",
  },
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("API_KEY_SCOPES", {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      name: {
        type: Sequelize.STRING(32),
        allowNull: false,
      },
      description: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });

    await queryInterface.addIndex("API_KEY_SCOPES", {
      fields: ["name"],
      unique: true,
      name: "uq_api_key_scopes_name",
    });

    await queryInterface.createTable("USER_API_KEY_SCOPES", {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      user_api_key_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: "USER_API_KEYS", key: "id" },
        onDelete: "CASCADE",
      },
      api_key_scope_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: "API_KEY_SCOPES", key: "id" },
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });

    await queryInterface.addIndex("USER_API_KEY_SCOPES", {
      fields: ["user_api_key_id", "api_key_scope_id"],
      unique: true,
      name: "uq_user_api_key_scopes_key_scope",
    });

    await queryInterface.bulkInsert(
      "API_KEY_SCOPES",
      API_KEY_SCOPES.map((row) => ({ ...row, created_at: NOW, updated_at: NOW })),
      { ignoreDuplicates: true },
    );
  },

  async down(queryInterface) {
    await queryInterface.dropTable("USER_API_KEY_SCOPES");
    await queryInterface.dropTable("API_KEY_SCOPES");
  },
};
