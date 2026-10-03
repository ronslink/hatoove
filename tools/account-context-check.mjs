/** Stale tabs must never follow another tab's account cookie. Offline, synthetic identities only. */
import assert from 'node:assert/strict';
import { createApi } from '../public/app/api.js';
import { createOwnedApi } from '../server/owned-api.mjs';
import { createMemoryDatastore, createMemorySessions } from './owned-api-check.mjs';

const store = createMemoryDatastore();
// EXAM-S1: registration provisions the initial preparation + (owner, exam) balance, as the PostgreSQL
// registration transaction does. Without a provisioner a new account would have neither.
const sessions = createMemorySessions({ provision: store.provision });
const deleted = [];
const server = createOwnedApi({ datastore: store.port, sessions, settings: store.settings,
  accountDeletion: { async deleteAccount(owner) { deleted.push(owner); return { existed: true, removed: {} }; } } });
let cookie = '';
const calls = [];
async function fetchImpl(path, init = {}) {
  calls.push({ path, ...init });
  const res = await server.handle({ method: init.method || 'GET', path,
    headers: { ...init.headers, cookie }, body: init.body, originChecked: true });
  if (res.headers['set-cookie']) cookie = res.headers['set-cookie'].split(';')[0];
  return { status: res.status, ok: res.status >= 200 && res.status < 300, json: async () => JSON.parse(res.body) };
}
const notifications = [];
const fresh = () => createApi({ fetchImpl, onSessionInvalid: reason => notifications.push(reason) });
let passed = 0;
async function check(name, test) { await test(); passed++; console.log(`PASS ${name}`); }
const a = fresh();
await a.auth.signUp('Synthetic A', 'context-a@example.invalid', 'synthetic-password');
const cookieA = cookie;
const idA = (await a.session()).data.user.id;
const b = fresh();
await b.auth.signUp('Synthetic B', 'context-b@example.invalid', 'synthetic-password');
let cookieB = cookie;
const idB = (await b.session()).data.user.id;

await check('stale A account deletion refuses B cookie before any deletion', async () => {
  assert.equal((await a.account.remove()).error, 'account_changed');
  assert.deepEqual(deleted, []);
  assert.equal(calls.at(-1).headers['X-Hatoove-Account'], idA);
  assert.equal((await b.account.read()).data.id, idB);
});
await check('a frozen tab makes no further owned requests or automatic rebinding', async () => {
  const count = calls.length;
  for (const result of [await a.settings.write(0, { language: 'ar' }), await a.auth.signOut(), await a.session()]) {
    assert.equal(result.error, 'account_changed');
  }
  assert.equal(calls.length, count);
  assert.equal(cookie, cookieB);
});
await check('server refuses stale settings, signout, reads and creation independently of client', async () => {
  for (const [path, method, body] of [
    ['/api/v1/settings', 'PUT', { expectedRevision: 0, settings: { language: 'ar' } }],
    ['/api/auth/sign-out', 'POST', {}], ['/api/auth/get-session', 'GET'],
    ['/api/v1/account', 'GET'], ['/api/v1/attempts', 'POST', {}],
    ['/api/v1/export', 'GET'],
  ]) {
    const result = await fetchImpl(path, { method, headers: { 'X-Hatoove-Account': idA, 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
    assert.equal(result.status, 409, path);
    assert.deepEqual(await result.json(), { error: 'account_changed' });
  }
  assert.equal(cookie, cookieB);
  assert.equal((await b.settings.read()).data.revision, 0);
  cookie = cookieA;
  assert.equal((await fresh().session()).data.user.id, idA);
  assert.equal((await store.settings.read(idA)).revision, 0);
  cookie = cookieB;
});
await check('fresh B tab acts on B and matching account checks preserve API behavior', async () => {
  const result = await b.settings.write(0, { language: 'en' });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await b.settings.read()).data.settings.language, 'en');
  const noHeader = await fetchImpl('/api/v1/account');
  assert.equal((await noHeader.json()).id, idB);
});
await check('unbound tab refuses mutations and owned reads without fetching', async () => {
  const client = fresh(); const count = calls.length;
  assert.equal((await client.account.remove()).error, 'account_context_required');
  assert.equal((await client.settings.read()).error, 'account_context_required');
  assert.equal(calls.length, count);
});
await check('same account session rotation keeps bound tab usable', async () => {
  await fresh().auth.signIn('context-b@example.invalid', 'synthetic-password');
  assert.notEqual(cookie, cookieB);
  cookieB = cookie;
  assert.equal((await b.session()).data.user.id, idB);
  assert.equal((await b.account.read()).ok, true);
});
await check('expired session freezes owned work and preserves the boundary on later sign-in', async () => {
  const client = fresh(); await client.session();
  cookie = '';
  assert.equal((await client.session()).error, 'session_expired');
  cookie = cookieA;
  assert.equal((await client.account.read()).error, 'session_expired');
});
await check('response arriving after invalidation cannot render stale data', async () => {
  let finish;
  const client = createApi({ onSessionInvalid() {}, fetchImpl: async (path, init) => {
    const response = await fetchImpl(path, init);
    if (path === '/api/v1/settings') return { ...response, json: () => new Promise(resolve => { finish = async () => resolve(await response.json()); }) };
    return response;
  } });
  await client.session();
  const late = client.settings.read();
  while (!finish) await new Promise(resolve => setImmediate(resolve));
  cookie = cookieB;
  assert.equal((await client.account.read()).error, 'account_changed');
  await finish();
  assert.deepEqual(await late, { ok: false, status: 409, data: null, error: 'stale_session' });
});
await check('untrusted response identity cannot silently replace boot identity', async () => {
  let identity = idA;
  const client = createApi({ onSessionInvalid() {}, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ user: { id: identity } }) }) });
  await client.session(); identity = idB;
  assert.equal((await client.session()).error, 'account_changed');
});
assert.ok(notifications.includes('account_changed'));
assert.deepEqual(deleted, []);
console.log(`${passed}/${passed} account-context checks passed (memory handler and actual client; no database/browser).`);
