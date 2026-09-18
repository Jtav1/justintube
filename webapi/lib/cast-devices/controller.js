import { Client, DefaultMediaReceiver } from "castv2-client";
import { CastServiceError } from "../cast/errors.js";
import { logger } from "../logger.js";

/**
 * How long to wait for a device to accept a TCP connection before giving up.
 * Chromecasts that have dropped off the network otherwise hang the request.
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
      clearTimeout(timer);
      try {
        client.close();
      } catch {
        // Already closed - nothing to do.
      }
      if (err) reject(err);
      else resolve(result);
    }

    const timer = setTimeout(() => {
      finish(new CastServiceError(504, "device_unreachable", "The cast device did not respond."));
    }, CONNECT_TIMEOUT_MS);

    client.on("error", (err) => {
      logger.warn({ err, host: device.host }, "[cast-devices] client error");
      finish(new CastServiceError(504, "device_unreachable", "Could not reach the cast device."));
    });

    client.connect({ host: device.host, port: device.port }, () => {
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
 * Sends a transport command to whatever is already playing on a device.
 *
 * @param {object} params
 * @param {{host: string, port: number}} params.device Target device.
 * @param {"play"|"pause"|"stop"} params.command Transport command.
 * @returns {Promise<object|null>} The device's media status, if it reported one.
 */
export function controlDevice({ device, command }) {
  return withReceiver(device, (player, done) => {
    player.getStatus((statusErr, status) => {
      if (statusErr || !status) {
        done(new CastServiceError(409, "nothing_playing", "That device isn't playing anything."));
        return;
      }
      const action = { play: "play", pause: "pause", stop: "stop" }[command];
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
