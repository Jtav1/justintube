/**
 * Jest configuration for the Justintube API test suite.
 *
 * The project is native ESM (`"type": "module"`), so tests run under Node's
 * experimental VM modules loader (see the `test` script). No transform is
 * configured; sources and tests are executed as-is.
 *
 * @type {import('jest').Config}
 */
export default {
  testEnvironment: "node",
  setupFiles: ["<rootDir>/tests/setup/env.js"],
  testMatch: ["<rootDir>/tests/**/*.test.js"],
  // Each test file gets a fresh module registry so lib/db.js re-initializes its
  // per-worker SQLite backend from the env configured in tests/setup/env.js.
  clearMocks: true,
};
