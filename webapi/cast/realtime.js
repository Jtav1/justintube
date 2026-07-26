import { Server } from 'socket.io';
import { attachCastGateway } from './gateway.js';
import { createCastPersistence } from './persistence.js';
import { createSessionStore } from './session-store.js';

/**
 * Wires Socket.IO onto the HTTP server and attaches the CAST gateway.
 *
 * Kept out of index.js so `createApp()` stays a pure Express factory.
 *
 * @param {import('node:http').Server} httpServer HTTP server wrapping the Express app.
 * @returns {import('socket.io').Server} The Socket.IO server (CAST namespace attached).
 */
export function createRealtime(httpServer) {
  const io = new Server(httpServer, {
    cors: { origin: true },
  });

  const persistence = createCastPersistence();
  const sessionStore = createSessionStore(persistence);
  attachCastGateway(io, sessionStore);

  return io;
}
