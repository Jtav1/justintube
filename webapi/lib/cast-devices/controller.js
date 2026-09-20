import { Client, DefaultMediaReceiver } from "castv2-client";
import { CastServiceError } from "../cast/errors.js";
import { logger } from "../logger.js";

/**
 * How long to wait for a device to accept a TCP connection before giving up.
 * Chromecasts that have dropped off the network otherwise hang the request.
 * Only guards the connect step - once `client.connect` calls back, the device
 * is reachable and any further delay (launch, load, a transport command) is a
 * real device/media concern, not a reachability one, so it isn't bounded here.
 *
 * @type {number}
 */
const CONNECT_TIMEOUT_MS = 8000;

/**
 * Opens a connection to a Chromecast and launches the default media receiver.
 * Every exported helper below funnels through this, so connection handling and
 * teardown live in exactly one place.
 *
 * @param {{host: string, port: number}} device Target device.
 * @param {(player: object, done: (err: Error|null, result?: unknown) => void) => void} run
 *   Callback invoked with the launched receiver.
 * @returns {Promise<unknown>} Whatever `run` passes to its callback.
 * @throws {CastServiceError} 504 when the device can't be reached.
 */
function withReceiver(device, run) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;

    /**
     * Resolves or rejects once, always closing the socket first.
     *
     * @param {Error|null} err Failure, if any.
     * @param {unknown} [result] Success value.
     * @returns {void}
     */
    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      try {
        client.close();
      } catch {
        // Already closed - nothing to do.
      }
      if (err) reject(err);
      else resolve(result);
    }

    const connectTimer = setTimeout(() => {
      finish(new CastServiceError(504, "device_unreachable", "The cast device did not respond."));
    }, CONNECT_TIMEOUT_MS);

    client.on("error", (err) => {
      logger.warn({ err, host: device.host }, "[cast-devices] client error");
      finish(new CastServiceError(504, "device_unreachable", "Could not reach the cast device."));
    });

    client.connect({ host: device.host, port: device.port }, () => {
      clearTimeout(connectTimer);
      client.launch(DefaultMediaReceiver, (err, player) => {
        if (err) {
          finish(
            new CastServiceError(502, "device_error", "The cast device refused the request."),
          );
          return;
        }
        run(player, finish);
      });
    });
  });
}

/**
 * Starts playback of a media URL on a device.
 *
 * The Chromecast fetches `mediaUrl` itself, so it must be reachable from the
 * device's network and readable without the caller's session cookie - see
 * PUBLIC_API_URL in the device-cast config.
 *
 * @param {object} params
 * @param {{host: string, port: number}} params.device Target device.
 * @param {string} params.mediaUrl Absolute, device-reachable media URL.
 * @param {string} params.title Shown on the TV.
 * @param {string} [params.contentType] MIME type of the media.
 * @param {string} [params.imageUrl] Optional poster shown on the TV.
 * @returns {Promise<object>} The device's media status.
 */
export function playOnDevice({ device, mediaUrl, title, contentType = "video/mp4", imageUrl }) {
  return withReceiver(device, (player, done) => {
    const media = {
      contentId: mediaUrl,
      contentType,
      streamType: "BUFFERED",
      metadata: {
        type: 0,
        metadataType: 0,
        title,
        images: imageUrl ? [{ url: imageUrl }] : undefined,
      },
    };
    player.load(media, { autoplay: true }, (err, status) => {
      if (err) {
        done(new CastServiceError(502, "device_error", "The cast device rejected the media."));
        return;
      }
      done(null, status);
    });
  });
}

/**
 * Transport commands `controlDevice` knows how to send. Doubles as the
 * command-to-method map, since the Media player's method names match ours.
 *
 * @type {Record<string, string>}
 */
const CONTROL_ACTIONS = { play: "play", pause: "pause", stop: "stop" };

/**
 * Sends a transport command to whatever is already playing on a device.
 * Route-level validation (`routes/cast-devices.js`) is expected to reject
 * unknown commands before this is ever called, but an unrecognized command is
 * logged and dropped here too rather than ever reaching `player[action]`,
 * which would throw on an undefined method.
 *
 * @param {object} params
 * @param {{host: string, port: number}} params.device Target device.
 * @param {"play"|"pause"|"stop"} params.command Transport command.
 * @returns {Promise<object|null>} The device's media status, if it reported
 *   one, or null when the command was invalid and dropped.
 */
export function controlDevice({ device, command }) {
  const action = CONTROL_ACTIONS[command];
  if (!action) {
    logger.error({ command }, "[cast-devices] dropped an unrecognized control command");
    return Promise.resolve(null);
  }

  return withReceiver(device, (player, done) => {
    player.getStatus((statusErr, status) => {
      if (statusErr || !status) {
        done(new CastServiceError(409, "nothing_playing", "That device isn't playing anything."));
        return;
      }
      player[action]((err, updated) => {
        if (err) {
          done(new CastServiceError(502, "device_error", "The cast device refused the command."));
          return;
        }
        done(null, updated ?? null);
      });
    });
  });
}
