import request from "supertest";
import { createApp } from "../../index.js";

/**
 * Builds the Express app and wraps it in a supertest client. The app is created
 * without listening on a socket (see the start guard in `index.js`), so the
 * returned agent drives requests entirely in-process.
 *
 * @returns {import('supertest').SuperTest<import('supertest').Test>} Supertest client bound to a fresh app.
 */
export function createTestClient() {
  return request(createApp());
}
