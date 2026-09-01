"use strict";

// ORIGINAL_UPLOADS.has_video_stream: whether ffprobe found a genuine,
// decodable video stream (distinct from `media_type`, an extension-based
// guess made at upload time, and from video_width/video_height being
// non-null, which an embedded cover-art stream on an audio file can also
// produce). Set from the initial /transcode batch response
// (finalizeUploadTranscodes, webapi/routes/uploads.js). Nullable: null means
// "not probed yet or the probe failed" - only an explicit false means
// "definitely no video stream".

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("ORIGINAL_UPLOADS", "has_video_stream", {
      type: Sequelize.BOOLEAN,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn("ORIGINAL_UPLOADS", "has_video_stream");
  },
};
