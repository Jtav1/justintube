// CommonJS on purpose: this directory has its own package.json with
// "type": "commonjs" so sequelize-cli (which requires() this file and every
// migration/seeder under db/) keeps working even though webapi/package.json
// itself is "type": "module". Do not move this file out of db/.
"use strict";

const path = require("node:path");
require("dotenv").config({ path: path.resolve(__dirname, "..", ".env") });

const DB_CLIENT = (process.env.DB_CLIENT || "sqlite").toLowerCase();

// Mirrors lib/db.js's `define` block: table/column naming must match the
// hand-written Sequelize models exactly, or migrations will create schema
// the models can't see (or vice versa).
const define = {
  freezeTableName: true,
  underscored: true,
};

/**
 * Builds the sqlite connection config, matching lib/db.js's SQLITE_FILE
 * resolution (relative to the webapi/ directory, not this db/ directory).
 *
 * @returns {object} sequelize-cli environment config for sqlite.
 */
function sqliteConfig() {
  const configured = process.env.SQLITE_FILE || "db/data/justintube.sqlite";
  const storage = path.isAbsolute(configured)
    ? configured
    : path.resolve(__dirname, "..", configured);
  return {
    dialect: "sqlite",
    storage,
    define,
  };
}

/**
 * Builds the mysql connection config, matching lib/db.js's MYSQL_* env vars.
 *
 * @returns {object} sequelize-cli environment config for mysql.
 */
function mysqlConfig() {
  return {
    dialect: "mysql",
    username: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT) || 3306,
    define,
    dialectOptions: {
      charset: "utf8mb4",
    },
  };
}

const config = DB_CLIENT === "mysql" ? mysqlConfig() : sqliteConfig();

// Justintube picks its dialect from DB_CLIENT, not NODE_ENV, so every
// sequelize-cli environment resolves to the same config.
module.exports = {
  development: config,
  test: config,
  production: config,
};
