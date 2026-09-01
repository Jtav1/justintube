"use strict";

// ORIGINAL_UPLOADS.embed_video_*: an audio-only upload's thumbnail-image +
// audio MP4, muxed purely so link-unfurl bots that only render `og:video`
// (Discord in particular, which ignores `og:audio`) have something genuinely
// playable to embed. Null until an "embed" processing job completes (see
// `enqueueAudioEmbedVideo` in webapi/routes/uploads.js); always null for
// video uploads.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("ORIGINAL_UPLOADS", "embed_video_storage_path", {
      type: Sequelize.STRING(512),
      allowNull: true,
    });
    await queryInterface.addColumn("ORIGINAL_UPLOADS", "embed_video_width", {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
    await queryInterface.addColumn("ORIGINAL_UPLOADS", "embed_video_height", {
      type: Sequelize.INTEGER.UNSIGNED,
      allowNull: true,
    });
    await queryInterface.addColumn("ORIGINAL_UPLOADS", "embed_video_is_default", {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("ORIGINAL_UPLOADS", "embed_video_is_default");
    await queryInterface.removeColumn("ORIGINAL_UPLOADS", "embed_video_height");
    await queryInterface.removeColumn("ORIGINAL_UPLOADS", "embed_video_width");
    await queryInterface.removeColumn("ORIGINAL_UPLOADS", "embed_video_storage_path");
  },
};
