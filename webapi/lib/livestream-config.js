/**
 * Returns whether the livestreaming feature (stream keys, the LIVESTREAMS
 * model, and the public/internal livestream routes) is enabled. Split into
 * its own tiny module, mirroring `search-backend-config.js`, so both the
 * route mounting in `routes/stubs.js`/`index.js` and the public config
 * endpoint in `routes/public-config.js` can depend on it without duplicating
 * the env var check.
 *
 * @returns {boolean} True when ENABLE_LIVESTREAM is the string "true".
 */
export function livestreamEnabled() {
  return String(process.env.ENABLE_LIVESTREAM || "").toLowerCase() === "true";
}
