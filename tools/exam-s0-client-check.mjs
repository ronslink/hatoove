/** Exact objective versions AND the preparation context are required at the browser transport boundary. No network or DB. */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceArg = process.argv.indexOf('--source-root');
if (sourceArg !== -1 && (!process.argv[sourceArg + 1] || process.argv[sourceArg + 1].startsWith('--'))) {
  throw new Error('--source-root needs an explicit checkout path');
}
const root = sourceArg === -1 ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') : path.resolve(process.argv[sourceArg + 1]);
const { createApi } = await import(pathToFileURL(path.join(root, 'public/app/api.js')).href);
const requests = [];
let expired = false;
const invalidations = [];
// EXAM-S1: every objective read/answer is scoped to one owned, active preparation the client selected.
const PREPARATION = '11111111-2222-4333-8444-555555555555';
const api = createApi({
  onSessionInvalid: reason => invalidations.push(reason),
  fetchImpl: async (url, init = {}) => {
    requests.push({ url, ...init });
    const status = expired ? 401 : 200;
    return { ok: status === 200, status, json: async () => url === '/api/auth/get-session'
      ? { user: { id: 'synthetic-owner' } } : { correct: true } };
  },
});
let passed = 0;
const check = async (name, run) => { await run(); console.log('PASS ' + name); passed++; };
assert.equal((await api.session()).ok, true);
// The selection carries context only; the server still verifies ownership, state and exam identity.
assert.equal(api.preparations.select({ id: PREPARATION, state: 'active' }), true);
const scoped = (path) => path.includes('?') ? `${path}&preparationId=${PREPARATION}` : `${path}?preparationId=${PREPARATION}`;

await check('missing or empty read version fails before making a request', async () => {
  const before = requests.length;
  for (const version of [undefined, null, '', '  ', 2]) {
    const response = await api.objectiveSets.read('same-id', version);
    assert.equal(response.status, 422);
    assert.equal(response.ok, false);
  }
  assert.equal(requests.length, before);
});
await check('selected v2 is encoded into the read under the verified account', async () => {
  assert.equal((await api.objectiveSets.read('same/id', 'v2')).ok, true);
  const request = requests.at(-1);
  assert.equal(request.url, scoped('/api/v1/objective-sets/same%2Fid?version=v2'));
  assert.equal(request.headers['X-Hatoove-Account'], 'synthetic-owner');
});
await check('missing or empty answer version is rejected without writing', async () => {
  const before = requests.length;
  for (const version of [undefined, null, '', '  ', 2]) {
    const response = await api.practice.answer('same-id', { version, itemId: '1', answer: 'b' });
    assert.equal(response.status, 422);
    assert.equal(response.ok, false);
  }
  assert.equal((await api.practice.answer('same-id')).status, 422);
  assert.equal(requests.length, before);
});
await check('answer retains the selected v2 and exact item/response', async () => {
  const body = { version: 'v2', itemId: '1', answer: 'b' };
  assert.equal((await api.practice.answer('same/id', body)).ok, true);
  const request = requests.at(-1);
  assert.equal(request.url, '/api/v1/objective-sets/same%2Fid/answers');
  assert.equal(request.method, 'POST');
  assert.deepEqual(JSON.parse(request.body), { ...body, preparationId: PREPARATION });
  assert.equal(request.headers['X-Hatoove-Account'], 'synthetic-owner');
});
await check('v1 is still available when explicitly selected', async () => {
  assert.equal((await api.objectiveSets.read('same-id', 'v1')).ok, true);
  assert.equal(requests.at(-1).url, scoped('/api/v1/objective-sets/same-id?version=v1'));
});
await check('a read without a selected preparation is refused before any request', async () => {
  const unscoped = createApi({ onSessionInvalid: () => {}, fetchImpl: async (url, init = {}) => {
    requests.push({ url, ...init });
    return { ok: true, status: 200, json: async () => ({ user: { id: 'synthetic-owner' } }) };
  } });
  assert.equal((await unscoped.session()).ok, true);
  const before = requests.length;
  assert.equal((await unscoped.objectiveSets.read('same-id', 'v2')).error, 'preparation_required');
  assert.equal(requests.length, before, 'no context means no request');
});
await check('exact-version writes retain the expired-session fence', async () => {
  expired = true;
  assert.equal((await api.objectiveSets.read('same-id', 'v2')).status, 401);
  const before = requests.length;
  assert.equal((await api.practice.answer('same-id', { version: 'v2', itemId: '1', answer: 'b' })).status, 401);
  assert.equal(requests.length, before);
  assert.ok(invalidations.includes('session_expired'));
});
console.log(`${passed} passed; source ${root}. Synthetic transport only; rendered behavior has a separate check.`);
