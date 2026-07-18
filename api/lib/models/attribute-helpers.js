import { DataTypes } from "sequelize";
import { sequelize } from "../db.js";

/**
 * Builds a Sequelize DATE attribute with a SQL CURRENT_TIMESTAMP default so raw
 * INSERTs (not just model.create) receive a value.
 *
 * @param {string} field Snake_case column name to store in the database.
 * @returns {object} Sequelize attribute definition.
 */
export function timestampColumn(field) {
  return {
    type: DataTypes.DATE,
    allowNull: false,
    defaultValue: sequelize.literal("CURRENT_TIMESTAMP"),
    field,
  };
}

/**
 * Builds a constrained string attribute that rejects values outside `values`
 * at the Sequelize validation layer (SQLite stores ENUM as unconstrained TEXT).
 *
 * @param {string[]} values Allowed string values.
 * @param {object} [options] Extra attribute options (allowNull, defaultValue, …).
 * @returns {object} Sequelize attribute definition.
 */
export function constrainedString(values, options = {}) {
  return {
    type: DataTypes.STRING(16),
    validate: { isIn: [values] },
    ...options,
  };
}
