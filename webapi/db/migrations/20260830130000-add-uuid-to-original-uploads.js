"use strict";

// ORIGINAL_UPLOADS.uuid: internal on-disk storage filename (no extension),
// distinct from the public-facing `video_id`. Added nullable here since
// existing rows have no value yet - backfilled by
// `npm run migrate-upload-storage` (see webapi/scripts/), which also
// physically moves each upload's file into its new per-user subfolder. Only
// once every row has been backfilled does the Sequelize model's
// `allowNull: false` become meaningful for new writes.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn("ORIGINAL_UPLOADS", "uuid", {
      type: Sequelize.STRING(36),
      allowNull: true,
    });
    await queryInterface.addIndex("ORIGINAL_UPLOADS", {
      fields: ["uuid"],
      unique: true,
      name: "uq_original_uploads_uuid",
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex("ORIGINAL_UPLOADS", "uq_original_uploads_uuid");
    await queryInterface.removeColumn("ORIGINAL_UPLOADS", "uuid");
  },
};
