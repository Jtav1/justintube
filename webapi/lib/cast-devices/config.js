/**
 * Config for device casting: pushing a video to a physical Chromecast from
 * the server rather than from the browser. Kept separate from
 * `lib/cast-config.js` (the shared watch-party feature) because the two are
 * unrelated despite the shared "cast" name - a watch party needs no hardware,
 * while this needs the API process to sit on the same L2 network as the TV.
 *
 * Defaults to disabled, like ENABLE_LIVESTREAM and unlike ENABLE_CAST: mDNS
 * discovery sends multicast traffic and only works with host networking, so
 * operators should opt in.
 *
 * @returns {boolean} True only when ENABLE_DEVICE_CAST is exactly "true".
 */
export function deviceCastEnabled() {
  return String(process.env.ENABLE_DEVICE_CAST ?? "").toLowerCase() === "true";
}

/**
 * The network interface address mDNS discovery should bind to. Necessary on
 * hosts with several interfaces (VPNs like Tailscale, Docker/Hyper-V virtual
 * switches), where the default bind picks the wrong one and discovery finds
 * nothing. Empty means "let the OS choose".
 *
 * @returns {string|undefined} An IPv4 address, or undefined when unset.
 */
export function castDiscoveryInterface() {
  const raw = process.env.CAST_DISCOVERY_INTERFACE;
  return raw ? String(raw).trim() : undefined;
}

/**
 * How long a discovery sweep listens for responses before answering.
 *
 * @returns {number} Milliseconds.
 */
export function castDiscoveryTimeoutMs() {
  const raw = Number(process.env.CAST_DISCOVERY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 5000;
}

/**
 * Chromecasts that can't be discovered over mDNS, configured as a
 * comma-separated list of `host` or `host:port` entries. mDNS is blocked more
 * often than operators expect - across VLANs, by AP isolation, by host
 * firewalls, and inside Docker bridge networks - so a manual path is the
 * difference between the feature working and not existing.
 *
 * @returns {Array<{host: string, port: number}>} Parsed static devices.
 */
export function castStaticDevices() {
  const raw = process.env.CAST_STATIC_DEVICES;
  if (!raw) {
    return [];
  }
  return String(raw)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [host, port] = entry.split(":");
      return { host: host.trim(), port: Number(port) > 0 ? Number(port) : 8009 };
    })
    .filter((device) => device.host);
}

/**
 * The base URL a Chromecast should fetch media from. The device resolves this
 * itself, so it must be reachable from the TV's network - "localhost" points
 * the Chromecast at itself and always fails.
 *
 * @returns {string} Base URL without a trailing slash.
 */
export function castMediaBaseUrl() {
  const raw = process.env.PUBLIC_API_URL || `http://localhost:${process.env.PORT || 3000}`;
  return String(raw).replace(/\/+$/, "");
}
