/**
 * Returns whether the CAST shared-watch-session feature (routes/cast.js and
 * the `/cast` Socket.IO namespace) is enabled. Split into its own tiny
 * module, mirroring `livestream-config.js`, so both the route mounting in
 * `routes/stubs.js`/`index.js` and the public config endpoint in
 * `routes/public-config.js` can depend on it without duplicating the env var
 * check. Unlike `ENABLE_LIVESTREAM`, this defaults to enabled: CAST needs no
 * extra infrastructure (it reuses the webapi process/port), so there's no
 * reason to make operators opt in explicitly.
 *
 * @returns {boolean} True unless ENABLE_CAST is explicitly set to a
 *   non-"true" value.
 */
export function castEnabled() {
  const raw = process.env.ENABLE_CAST;
  if (raw === undefined || raw === "") {
    return true;
  }
  return String(raw).toLowerCase() === "true";
}
