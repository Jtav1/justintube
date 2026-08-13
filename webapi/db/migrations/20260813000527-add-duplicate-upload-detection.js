'use strict';

// Duplicate-upload detection: ORIGINAL_UPLOADS.content_hash stores the
// ffmpeg decoded-video-stream sha256 hash computed by a "hash" job in
// processing/ (see lib/models/original-upload.js); skip_thumbnail persists
// the original upload/import request's skipThumbnail flag so it survives
// the deferred finalizeUploadTranscodes() call made later from the
// hash-complete callback or a moderator's "keep new" resolution, outside the
// original request. DUPLICATE_UPLOAD_FLAGS is a REPORTS-style review-queue
// table: one row per possible-duplicate match, reviewed by an admin/
// moderator via PATCH /admin/duplicate-uploads/:id/moderate. See
// lib/models/duplicate-upload-flag.js for the corresponding model.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("ORIGINAL_UPLOADS", "content_hash", {
      type: Sequelize.STRING(128),
      allowNull: true,
    });
    await queryInterface.addIndex("ORIGINAL_UPLOADS", {
      fields: ["content_hash"],
      name: "idx_original_uploads_content_hash",
    });
    await queryInterface.addColumn("ORIGINAL_UPLOADS", "skip_thumbnail", {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });

    await queryInterface.createTable("DUPLICATE_UPLOAD_FLAGS", {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      new_original_upload_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: "ORIGINAL_UPLOADS", key: "id" },
        onDelete: "SET NULL",
      },
      existing_original_upload_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: "ORIGINAL_UPLOADS", key: "id" },
        onDelete: "SET NULL",
      },
      content_hash: {
        type: Sequelize.STRING(128),
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: "pending",
      },
      resolution: {
        type: Sequelize.STRING(32),
        allowNull: true,
      },
      moderator_user_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: true,
        references: { model: "USERS", key: "id" },
        onDelete: "SET NULL",
      },
      moderator_comment: {
        type: Sequelize.STRING(500),
        allowNull: true,
      },
      resolved_at: {
        type: Sequelize.DATE,
        allowNull: true,
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
        defaultValue: Sequelize.literal("CURRENT_TIMESTAMP"),
      },
    });

    await queryInterface.addIndex("DUPLICATE_UPLOAD_FLAGS", {
      fields: ["status"],
      name: "idx_duplicate_upload_flags_status",
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable("DUPLICATE_UPLOAD_FLAGS");
    await queryInterface.removeColumn("ORIGINAL_UPLOADS", "skip_thumbnail");
    await queryInterface.removeIndex(
      "ORIGINAL_UPLOADS",
      "idx_original_uploads_content_hash",
    );
    await queryInterface.removeColumn("ORIGINAL_UPLOADS", "content_hash");
  },
};
