'use strict';

// Reference/lookup data for ROLES, ACCESS_PERMISSIONS, NOTIFICATION_TYPES,
// and THEMES — fixed rows that back FK columns (USERS.role_id,
// VIDEO_ACCESS.permission_id, etc.) much like an enum table would. This is a
// snapshot of the seed values in webapi/lib/seed.js at the time this
// migration was written (DEFAULT_ROLES, DEFAULT_ACCESS_PERMISSIONS,
// DEFAULT_NOTIFICATION_TYPES, SEEDED_THEMES) — lib/seed.js keeps running on
// every boot as the idempotent runtime source of truth, so this migration
// only needs to get a *fresh* database (no boot yet, e.g. CI/test setup that
// runs migrations without booting the app) to the same starting state.
// `ignoreDuplicates` makes `up` a no-op wherever lib/seed.js already created
// a row first, so this is safe to run in either order.
//
// If DEFAULT_ROLES/DEFAULT_ACCESS_PERMISSIONS/DEFAULT_NOTIFICATION_TYPES/
// SEEDED_THEMES change later, add a *new* migration for the delta — don't
// edit this file (see CLAUDE.md's "Database schema changes" policy).

const NOW = new Date();

const ROLES = [
  { name: "admin", description: "Full administrative access to the platform.", enabled: true },
  { name: "moderator", description: "Can moderate content and manage other users.", enabled: true },
  { name: "uploader", description: "Verified user who can upload and manage their own videos.", enabled: true },
  { name: "viewer", description: "Default role that can watch and engage.", enabled: true },
  { name: "locked", description: "Account restricted from most actions.", enabled: true },
];

const ACCESS_PERMISSIONS = [
  { name: "view", description: "Can view the private video/playlist." },
  {
    name: "edit",
    description:
      "Can view and update metadata/content (and, for playlists, add/remove items), " +
      "but cannot delete, change visibility, or manage sharing.",
  },
];

const NOTIFICATION_TYPES = [
  { name: "subscription", description: "New video from one of your subscriptions", enabled: true },
  { name: "like", description: "New like received", enabled: true },
  { name: "comment", description: "New comment received", enabled: true },
  { name: "subscriber", description: "New subscriber", enabled: true },
  { name: "moderation", description: "Moderator actions", enabled: true },
  { name: "account", description: "Account status changes", enabled: true },
  { name: "admin", description: "Sitewide alerts & messages", enabled: true },
  { name: "report", description: "Report submissions and moderator updates", enabled: true },
];

// Mirrors PUBLIC_THEME_OWNER in webapi/lib/models/theme.js.
const PUBLIC_THEME_OWNER = "public";

const THEMES = [
  {
    name: "Light",
    theme_owner: PUBLIC_THEME_OWNER,
    is_default: true,
    color1: "E5E4E7",
    color2: "FFFFFF",
    color3: "6B6375",
    color4: "08060D",
    color5: "378bfa",
  },
  {
    name: "Dark",
    theme_owner: PUBLIC_THEME_OWNER,
    is_default: false,
    color1: "2E303A",
    color2: "16171D",
    color3: "9CA3AF",
    color4: "F3F4F6",
    color5: "2e62ff",
  },
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    await queryInterface.bulkInsert(
      "ROLES",
      ROLES.map((row) => ({ ...row, created_at: NOW, updated_at: NOW })),
      { ignoreDuplicates: true },
    );
    await queryInterface.bulkInsert(
      "ACCESS_PERMISSIONS",
      ACCESS_PERMISSIONS.map((row) => ({ ...row, created_at: NOW, updated_at: NOW })),
      { ignoreDuplicates: true },
    );
    await queryInterface.bulkInsert(
      "NOTIFICATION_TYPES",
      NOTIFICATION_TYPES.map((row) => ({ ...row, created_at: NOW, updated_at: NOW })),
      { ignoreDuplicates: true },
    );

    // THEMES has no DB-level unique constraint on `name` (unlike the tables
    // above) — lib/seed.js's seedThemes() dedupes at the app layer via
    // findOrCreate({ where: { name, themeOwner } }), so `ignoreDuplicates`
    // here would silently insert duplicate Light/Dark rows if this migration
    // runs against a database lib/seed.js already seeded. Filter in JS first
    // to match that same (name, theme_owner) semantics.
    const [existingThemes] = await queryInterface.sequelize.query(
      "SELECT name FROM THEMES WHERE theme_owner = :themeOwner",
      { replacements: { themeOwner: PUBLIC_THEME_OWNER } },
    );
    const existingThemeNames = new Set(existingThemes.map((row) => row.name));
    const missingThemes = THEMES.filter((row) => !existingThemeNames.has(row.name));
    if (missingThemes.length > 0) {
      await queryInterface.bulkInsert(
        "THEMES",
        missingThemes.map((row) => ({ ...row, created_at: NOW, updated_at: NOW })),
      );
    }
  },

  async down(queryInterface) {
    await queryInterface.bulkDelete("THEMES", {
      name: THEMES.map((row) => row.name),
      theme_owner: PUBLIC_THEME_OWNER,
    });
    await queryInterface.bulkDelete("NOTIFICATION_TYPES", {
      name: NOTIFICATION_TYPES.map((row) => row.name),
    });
    await queryInterface.bulkDelete("ACCESS_PERMISSIONS", {
      name: ACCESS_PERMISSIONS.map((row) => row.name),
    });
    await queryInterface.bulkDelete("ROLES", {
      name: ROLES.map((row) => row.name),
    });
  },
};
