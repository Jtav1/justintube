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
 * Browses the local network for Chromecasts over mDNS, merged with any
 * statically configured devices. Static entries are included unconditionally
 * (they exist precisely because discovery can't see them) and win on id
 * collisions, so an operator can always override a flaky advertisement.
 *
 * Resolves after a fixed listening window rather than streaming, because the
 * REST surface is a simple list endpoint - mDNS never signals "done".
 *
 * @returns {Promise<Array<object>>} Discovered devices, name-sorted.
 */
export async function discoverCastDevices() {
  const statics = castStaticDevices().map((device) => ({
    id: deviceIdFor(device),
    name: device.host,
    model: null,
    host: device.host,
    port: device.port,
    source: "static",
  }));

  const discovered = new Map();
  let bonjour;
  try {
    bonjour = new Bonjour({ interface: castDiscoveryInterface() });
  } catch (err) {
    // A bad CAST_DISCOVERY_INTERFACE shouldn't take the endpoint down - the
    // statically configured devices are still perfectly usable.
    logger.warn({ err }, "[cast-devices] mDNS browser failed to start");
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

  return [...discovered.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Resolves a device id to a connectable host/port. Checks the static list
 * first (no network round-trip), then falls back to a discovery sweep.
 *
 * @param {string} id Device id from {@link discoverCastDevices}.
 * @returns {Promise<object|null>} The device, or null when it can't be found.
 */
export async function findCastDevice(id) {
  const statics = castStaticDevices().map((device) => ({
    id: deviceIdFor(device),
    name: device.host,
    model: null,
    host: device.host,
    port: device.port,
    source: "static",
  }));
  const staticMatch = statics.find((device) => device.id === id);
  if (staticMatch) {
    return staticMatch;
  }

  const devices = await discoverCastDevices();
  return devices.find((device) => device.id === id) ?? null;
}
