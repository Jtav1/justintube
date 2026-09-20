import { Bonjour } from "bonjour-service";
import {
  castDiscoveryInterface,
  castDiscoveryTimeoutMs,
  castStaticDevices,
} from "./config.js";
import { logger } from "../logger.js";

/**
 * Stable identifier for a discovered device. Chromecasts advertise a UUID in
 * their TXT record; fall back to host:port so a device missing the field is
 * still addressable across requests.
 *
 * @param {{id?: string, host: string, port: number}} device Partial device.
 * @returns {string} Identifier used as the `:id` route param.
 */
function deviceIdFor(device) {
  return device.id || `${device.host}:${device.port}`;
}

/**
 * Normalizes a bonjour service record into our device shape. Chromecast TXT
 * records carry the friendly name in `fn` and the model in `md`; `name` alone
 * is the mangled service name, so prefer `fn` for anything user-facing.
 *
 * @param {object} service A bonjour-service record.
 * @returns {{id: string, name: string, model: string|null, host: string, port: number, source: string}}
 *   Normalized device.
 */
function normalizeService(service) {
  const txt = service.txt ?? {};
  const host = service.referer?.address || service.addresses?.[0] || service.host;
  const port = service.port || 8009;
  const device = {
    id: txt.id || `${host}:${port}`,
    name: txt.fn || service.name || host,
    model: txt.md || null,
    host,
    port,
    source: "mdns",
  };
  device.id = deviceIdFor(device);
  return device;
}

/**
 * Builds the normalized device list for every statically configured entry.
 * Shared by {@link discoverCastDevices} (which merges it with mDNS results)
 * and {@link findCastDevice} (which checks it first, with no network
 * round-trip).
 *
 * @returns {Array<{id: string, name: string, model: null, host: string, port: number, source: string}>}
 *   Normalized static devices.
 */
function buildStaticDeviceList() {
  return castStaticDevices().map((device) => ({
    id: deviceIdFor(device),
    name: device.host,
    model: null,
    host: device.host,
    port: device.port,
    source: "static",
  }));
}

/**
 * How long a cached discovery result stays valid for a cast session. Long
 * enough to cover a burst of play/control calls against devices already seen
 * in the last `GET /cast-devices` without paying another mDNS sweep for each
 * one; short enough that a device that's gone offline doesn't linger
 * indefinitely in a stale session's cache.
 *
 * @type {number}
 */
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Per-cast-session cache of the last mDNS discovery sweep, keyed on
 * `req.sessionID` (a stable string for the life of the session) rather than
 * `req.session` itself - express-session deserializes a fresh `Session`
 * object from the store on every request, even for the same underlying
 * session, so object identity would never survive between requests.
 *
 * @type {Map<string, {devices: Array<object>, expiresAt: number}>}
 */
const sessionDeviceCache = new Map();

/**
 * Reads the cached discovery result for a session, if present and unexpired.
 *
 * @param {string|undefined} sessionId `req.sessionID`.
 * @returns {Array<object>|undefined} Cached devices, or undefined when unset
 *   or expired.
 */
function getCachedDevices(sessionId) {
  if (!sessionId) {
    return undefined;
  }
  const entry = sessionDeviceCache.get(sessionId);
  if (!entry) {
    return undefined;
  }
  if (entry.expiresAt <= Date.now()) {
    sessionDeviceCache.delete(sessionId);
    return undefined;
  }
  return entry.devices;
}

/**
 * Stores a fresh discovery result against a session.
 *
 * @param {string|undefined} sessionId `req.sessionID`.
 * @param {Array<object>} devices Devices to cache.
 * @returns {void}
 */
function setCachedDevices(sessionId, devices) {
  if (sessionId) {
    sessionDeviceCache.set(sessionId, { devices, expiresAt: Date.now() + SESSION_CACHE_TTL_MS });
  }
}

/**
 * Browses the local network for Chromecasts over mDNS, merged with any
 * statically configured devices. Static entries are included unconditionally
 * (they exist precisely because discovery can't see them) and win on id
 * collisions, so an operator can always override a flaky advertisement.
 *
 * Resolves after a fixed listening window rather than streaming, because the
 * REST surface is a simple list endpoint - mDNS never signals "done". Caches
 * the result against `sessionId` (when given) so a later `findCastDevice`
 * call in the same cast session can skip another sweep.
 *
 * @param {string} [sessionId] `req.sessionID` to cache the result against.
 * @returns {Promise<Array<object>>} Discovered devices, name-sorted.
 */
export async function discoverCastDevices(sessionId) {
  const statics = buildStaticDeviceList();

  const discovered = new Map();
  let bonjour;
  try {
    bonjour = new Bonjour({ interface: castDiscoveryInterface() });
  } catch (err) {
    // A bad CAST_DISCOVERY_INTERFACE shouldn't take the endpoint down - the
    // statically configured devices are still perfectly usable.
    logger.warn({ err }, "[cast-devices] mDNS browser failed to start");
    setCachedDevices(sessionId, statics);
    return statics;
  }

  try {
    await new Promise((resolve) => {
      const browser = bonjour.find({ type: "googlecast" }, (service) => {
        try {
          const device = normalizeService(service);
          if (device.host) {
            discovered.set(device.id, device);
          }
        } catch (err) {
          logger.warn({ err }, "[cast-devices] skipped an unparseable mDNS record");
        }
      });
      setTimeout(() => {
        browser.stop();
        resolve();
      }, castDiscoveryTimeoutMs());
    });
  } finally {
    bonjour.destroy();
  }

  for (const device of statics) {
    discovered.set(device.id, device);
  }

  const devices = [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name));
  setCachedDevices(sessionId, devices);
  return devices;
}

/**
 * Resolves a device id to a connectable host/port. Checks the static list
 * first (no network round-trip), then the session's cached discovery result,
 * then falls back to a fresh discovery sweep.
 *
 * @param {string} id Device id from {@link discoverCastDevices}.
 * @param {string} [sessionId] `req.sessionID` to check/refresh the cache
 *   against.
 * @returns {Promise<object|null>} The device, or null when it can't be found.
 */
export async function findCastDevice(id, sessionId) {
  const staticMatch = buildStaticDeviceList().find((device) => device.id === id);
  if (staticMatch) {
    return staticMatch;
  }

  const cached = getCachedDevices(sessionId);
  const cachedMatch = cached?.find((device) => device.id === id);
  if (cachedMatch) {
    return cachedMatch;
  }

  const devices = await discoverCastDevices(sessionId);
  return devices.find((device) => device.id === id) ?? null;
}
