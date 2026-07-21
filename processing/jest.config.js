/** @type {import('jest').Config} */
const config = {
  testEnvironment: "node",
  transform: {},
  setupFiles: ["<rootDir>/tests/setup/env.js"],
  testMatch: ["**/tests/**/*.test.js"],
};

export default config;
