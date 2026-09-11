'use strict';

// Video list pages (GET /videos, /videos/featured, /videos/newest,
// /tags/:tag/videos, /feed/subscriptions) all filter VIDEO_METADATA by
// visibility and sort by created_at DESC. This composite index lets that
// filter+sort be served without a full table scan/filesort, matching
// (visibility, created_at) column order because the dominant traffic
// pattern (anonymous, public-only) filters by visibility first.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.addIndex("VIDEO_METADATA", {
      fields: ["visibility", "created_at"],
      name: "idx_video_metadata_visibility_created_at",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex(
      "VIDEO_METADATA",
      "idx_video_metadata_visibility_created_at",
    );
  },
};
