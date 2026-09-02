'use strict';

// VIDEO_SUBTITLE: the caption/subtitle track for an original upload, always
// stored as WebVTT (.vtt) regardless of source — either auto-extracted from
// an embedded subtitle stream in the original file (source: "auto") or
// uploaded directly by the owner/admin as .srt/.vtt, converted to .vtt on
// the way in if needed (source: "user"). One row per upload, same shape as
// VIDEO_THUMBNAIL. ORIGINAL_UPLOADS.skip_auto_subtitles mirrors
// skip_thumbnail: once set, no further auto-extraction may overwrite a
// user-provided subtitle track.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("VIDEO_SUBTITLE", {
      id: {
        type: Sequelize.INTEGER.UNSIGNED,
        autoIncrement: true,
        primaryKey: true,
      },
      original_upload_id: {
        type: Sequelize.INTEGER.UNSIGNED,
        allowNull: false,
        unique: "uq_video_subtitle_upload",
        references: { model: "ORIGINAL_UPLOADS", key: "id" },
        onDelete: "CASCADE",
      },
      subtitle_filename: {
        type: Sequelize.STRING(255),
        allowNull: false,
      },
      source: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: "auto",
      },
      created_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updated_at: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });

    await queryInterface.addColumn("ORIGINAL_UPLOADS", "skip_auto_subtitles", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("ORIGINAL_UPLOADS", "skip_auto_subtitles");
    await queryInterface.dropTable("VIDEO_SUBTITLE");
  },
};
