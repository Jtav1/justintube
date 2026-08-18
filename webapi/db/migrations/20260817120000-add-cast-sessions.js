'use strict';

// CAST shared watch sessions. CAST_SESSIONS holds the join code, owner, an
// optional source playlist the queue was copied from (never mutated - see
// lib/cast/queue-service.js), and a server-authoritative playback clock.
// CAST_QUEUE_ITEMS is the live queue for a session; there is no separate
// history table, a row's `status` transitioning to "played"/"skipped" *is*
// the history. CAST_SESSION_MEMBERS tracks membership, including a durable
// "kicked" status that blocks rejoin. See lib/models/cast-session.js,
// lib/models/cast-queue-item.js, and lib/models/cast-session-member.js for
// the corresponding models.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("CAST_SESSIONS", {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      code: {
        type: Sequelize.STRING(8),
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: "active",
      },
      owner_user_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: "USERS", key: "id" },
        onDelete: "CASCADE",
      },
      source_playlist_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: "USER_PLAYLISTS", key: "id" },
        onDelete: "SET NULL",
      },
      title: {
        type: Sequelize.STRING(255),
        allowNull: true,
      },
      playback_status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: "paused",
      },
      playback_position_seconds: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      playback_updated_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      ended_at: {
        type: Sequelize.DATE,
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
    await queryInterface.addIndex("CAST_SESSIONS", {
      fields: ["code"],
      name: "idx_cast_sessions_code",
    });
    await queryInterface.addIndex("CAST_SESSIONS", {
      fields: ["status"],
      name: "idx_cast_sessions_status",
    });
    await queryInterface.addIndex("CAST_SESSIONS", {
      fields: ["owner_user_id"],
      name: "idx_cast_sessions_owner",
    });

    await queryInterface.createTable("CAST_QUEUE_ITEMS", {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      cast_session_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: "CAST_SESSIONS", key: "id" },
        onDelete: "CASCADE",
      },
      original_upload_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: "ORIGINAL_UPLOADS", key: "id" },
        onDelete: "CASCADE",
      },
      added_by_user_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: "USERS", key: "id" },
        onDelete: "SET NULL",
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: "queued",
      },
      position: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
      },
      added_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
      played_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });
    await queryInterface.addIndex("CAST_QUEUE_ITEMS", {
      fields: ["cast_session_id", "status", "position"],
      name: "idx_cast_queue_items_session_status_position",
    });

    await queryInterface.createTable("CAST_SESSION_MEMBERS", {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      cast_session_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: "CAST_SESSIONS", key: "id" },
        onDelete: "CASCADE",
      },
      user_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        references: { model: "USERS", key: "id" },
        onDelete: "CASCADE",
      },
      role: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: "member",
      },
      status: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: "active",
      },
      joined_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
      left_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
    });
    await queryInterface.addIndex("CAST_SESSION_MEMBERS", {
      fields: ["cast_session_id", "user_id"],
      unique: true,
      name: "uq_cast_session_members",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("CAST_SESSION_MEMBERS");
    await queryInterface.dropTable("CAST_QUEUE_ITEMS");
    await queryInterface.dropTable("CAST_SESSIONS");
  },
};
