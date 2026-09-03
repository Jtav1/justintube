'use strict';

// VIDEO_SUBTITLE moves from "one row per upload" to "many rows per upload"
// (e.g. one per language): adds a required `label` column and drops the
// unique constraint on `original_upload_id` that previously enforced at
// most one subtitle track per video.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("VIDEO_SUBTITLE", "label", {
      type: Sequelize.STRING(100),
      allowNull: true,
    });

    await queryInterface.sequelize.query(
      "UPDATE `VIDEO_SUBTITLE` SET `label` = CASE WHEN `source` = 'user' THEN 'Uploaded subtitle' ELSE 'Subtitle' END WHERE `label` IS NULL",
    );

    await queryInterface.changeColumn("VIDEO_SUBTITLE", "label", {
      type: Sequelize.STRING(100),
      allowNull: false,
    });

    await queryInterface.removeConstraint("VIDEO_SUBTITLE", "uq_video_subtitle_upload");
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.addConstraint("VIDEO_SUBTITLE", {
      fields: ["original_upload_id"],
      type: "unique",
      name: "uq_video_subtitle_upload",
    });
    await queryInterface.removeColumn("VIDEO_SUBTITLE", "label");
  },
};
