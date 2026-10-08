/**
 * PILOT-FEEDBACK-01 (FB-E) — the ONE path whose request body is an IMAGE rather than JSON.
 *
 * WHY A SHARED MODULE. Two places have to agree about it and they are in different files:
 *
 *   * `server.js` admits the request: it refuses any `POST`/`PUT`/`PATCH` without `Content-Type: application/json`
 *     with a 415, BEFORE the owned API is reached. A real screenshot never got past it — the reviewer put it as
 *     "the screenshot upload can't be reached through the real server", and it is why amendment A15 was
 *     incomplete on its own.
 *   * `server/owned-api.mjs` then hands the route raw bytes and a larger limit, because `decodeBody` would decode
 *     them as UTF-8 and fault `invalid_utf8` on perfectly good image data.
 *
 * If those two ever disagreed, the failure would be silent in one direction (the API ready to accept a body the
 * server never delivers) and a 415 in the other. One definition is the only version of this that stays true, and
 * `server/public-origin.mjs` is the same pattern for the same reason.
 *
 * The pattern is anchored at both ends and matches ONLY a PUT to a feedback screenshot: any other method or path
 * must keep the JSON requirement.
 */

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

export const SCREENSHOT_UPLOAD_PATH = new RegExp(`^/api/v1/feedback/${UUID}/screenshot$`);

/** True only for the one request whose body is an image rather than JSON. */
export function isBinaryUploadPath(method, rawPath) {
  if (String(method || '').toUpperCase() !== 'PUT') return false;
  return SCREENSHOT_UPLOAD_PATH.test(String(rawPath ?? '').split('?')[0]);
}
