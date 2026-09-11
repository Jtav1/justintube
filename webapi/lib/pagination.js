/**
 * Shared page/limit query-param parsing used by paginated list endpoints
 * (`me.js`, `users.js`).
 */

/**
 * Maximum page size accepted by paginated list endpoints.
 *
 * @type {number}
 */
export const MAX_LIMIT = 99;

/**
 * Default page size for paginated list endpoints.
 *
 * @type {number}
 */
export const DEFAULT_LIMIT = 20;

/**
 * Parses and validates `page`/`limit` query params shared across paginated
 * list endpoints.
 *
 * @param {import('express').Request['query']} query Raw Express query object.
 * @returns {{ok: true, page: number, limit: number}|{ok: false, message: string}}
 *   Parsed pagination or a validation error.
 */
export function parsePagination(query) {
  const pageRaw = query.page === undefined ? 1 : Number(query.page);
  if (!Number.isInteger(pageRaw) || pageRaw < 1) {
    return { ok: false, message: "page must be a positive integer." };
  }

  const limitRaw = query.limit === undefined ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(limitRaw) || limitRaw < 1) {
    return { ok: false, message: "limit must be a positive integer." };
  }
  if (limitRaw > MAX_LIMIT) {
    return { ok: false, message: "limit must be less than 100." };
  }

  return { ok: true, page: pageRaw, limit: limitRaw };
}
