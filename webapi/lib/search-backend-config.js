/**
 * Returns whether the Meilisearch-backed search backend should be used.
 * Split into its own tiny module (rather than living in lib/search.js) so
 * both lib/search.js and lib/search-reindex.js can depend on it without a
 * circular import between those two files.
 *
 * @returns {boolean} True when ENABLE_ADVANCED_SEARCH is the string "true".
 */
export function advancedSearchEnabled() {
  return String(process.env.ENABLE_ADVANCED_SEARCH || "").toLowerCase() === "true";
}
