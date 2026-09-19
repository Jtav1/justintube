'use strict';

// Widens CAST_SESSIONS.playback_updated_at from DATETIME to DATETIME(3).
//
// The CAST playback clock is "stored position + elapsed time since
// playback_updated_at" (lib/cast/queue-service.js#effectivePosition), and every
// member's player corrects itself against the result. MySQL's DATETIME keeps
// whole seconds only, so the millisecond part of that timestamp was rounded away
// on write and read back up to half a second off - noise that lands directly in
// each client's drift calculation.
//
// SQLite stores dates as ISO strings and keeps milliseconds already, and its
// ALTER support is limited enough that a changeColumn there is a table rebuild
// for no gain, so this only runs on MySQL. See lib/models/cast-session.js.

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    if (queryInterface.sequelize.getDialect() !== "mysql") {
      return;
    }
    await queryInterface.changeColumn("CAST_SESSIONS", "playback_updated_at", {
      type: Sequelize.DATE(3),
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    if (queryInterface.sequelize.getDialect() !== "mysql") {
      return;
    }
    await queryInterface.changeColumn("CAST_SESSIONS", "playback_updated_at", {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },
};
