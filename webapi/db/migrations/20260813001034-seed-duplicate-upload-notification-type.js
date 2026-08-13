'use strict';

// Adds the "duplicate_upload" NOTIFICATION_TYPES row introduced alongside
// duplicate-upload detection (see DEFAULT_NOTIFICATION_TYPES in lib/seed.js,
// which keeps seeding it idempotently on every boot - this migration only
// needs to get a fresh, never-booted database, e.g. CI/test setup, to the
// same starting state). Follows the delta-migration convention documented in
// 20260808235625-seed-reference-data.js rather than editing that file.

const NOW = new Date();

const NOTIFICATION_TYPE = {
  name: "duplicate_upload",
  description: "Possible duplicate upload flagged for review",
  enabled: true,
};

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkInsert(
      "NOTIFICATION_TYPES",
      [{ ...NOTIFICATION_TYPE, created_at: NOW, updated_at: NOW }],
      { ignoreDuplicates: true },
    );
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete("NOTIFICATION_TYPES", {
      name: NOTIFICATION_TYPE.name,
    });
  },
};
