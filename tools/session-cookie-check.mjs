/** Offline factory/lifecycle proof only. No listener, PostgreSQL, provider or learner .env access. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { registerHooks } from 'node:module';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { parsePublicOrigin, readPublicOriginConfig } from '../server/public-origin.mjs';

const CODE = 'invalid_public_origin_configuration';
const credentialOrigin = new URL('https://example.invalid');
credentialOrigin.username = 'synthetic-user';
credentialOrigin.password = 'synthetic-password';
const checks = [];
const check = (name, run) => checks.push({ name, run });
const invalid = (error) => error?.code === CODE && error.message === CODE;
const envKeys = ['B1PREP_ENV_FILE', 'B1PREP_PUBLIC_ORIGIN', 'B1PREP_REQUIRE_HTTPS', 'B1PREP_SAAS'];
const savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
process.env.B1PREP_ENV_FILE = path.join(os.tmpdir(), `cookie-check-${randomUUID()}`, 'absent.env');
for (const key of envKeys.slice(1)) delete process.env[key];
const originalConnect = net.Socket.prototype.connect;
const originalListen = net.Server.prototype.listen;
const originalCreateServer = http.createServer;
let createdServers = 0;
net.Socket.prototype.connect = () => { throw new Error('offline_check_network_forbidden'); };
net.Server.prototype.listen = () => { throw new Error('offline_check_listener_forbidden'); };
http.createServer = (...args) => { createdServers++; return originalCreateServer(...args); };

// Only the pool-creation module is replaced. Account/world/session/API source executes unchanged.
const stub = { opened: 0, fixtureOpened: 0, current: null };
globalThis[Symbol.for('hatoove.cookie-check')] = stub;
const hooks = registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith('/server/owned-postgres/provision.mjs')) return { format: 'module', shortCircuit: true, source: `
      const s = globalThis[Symbol.for('hatoove.cookie-check')];
      export const persistentConfig = () => ({ schema: 'synthetic_cookie', roles: {} });
      export const openRuntimePools = async ({config}) => { s.opened++; return s.current.runtime(config); };
      export const persistentRolePool = () => s.current.pool();
      export const closeRuntimePools = async r => { for(const k of ['auth','learner','worker','deletion','payments','provisioner']) await r[k].end(); };
    ` };
    if (url.endsWith('/server/owned-postgres/bootstrap.mjs')) return { format: 'module', shortCircuit: true, source: `
      export async function createFixture() { globalThis[Symbol.for('hatoove.cookie-check')].fixtureOpened++; throw new Error('offline_check_fixture_forbidden'); }
    ` };
    return nextLoad(url, context);
  },
});

/** Small SQL-response fake, not PostgreSQL acceptance. Unexpected queries refuse rather than silently pass. */
function fakeDatabase() {
  let users = new Map(), accounts = new Map(), sessions = new Map(), transaction;
  const pools = [], calls = [];
  let failInsert = false;
  const result = (rows = []) => ({ rows, rowCount: rows.length });
  async function query(sql, params = []) {
    const text = (typeof sql === 'string' ? sql : sql.text).replace(/\s+/g, ' ').trim();
    calls.push({ text, params });
    if (text === 'BEGIN') { transaction = structuredClone({ users, accounts, sessions }); return result(); }
    if (text === 'COMMIT') { transaction = null; return result(); }
    if (text === 'ROLLBACK') { ({ users, accounts, sessions } = transaction); transaction = null; return result(); }
    if (text.startsWith('SELECT set_config(') || text.startsWith('DELETE FROM auth_throttle')) return result();
    if (text.startsWith('INSERT INTO auth_throttle')) return result([{ attempts: 1, at: new Date(), window_started_at: new Date() }]);
    if (text.startsWith('SELECT 1 FROM "user"')) return result([...users.values()].filter(u => u.email === params[0]));
    if (text.startsWith('INSERT INTO "user"')) { users.set(params[0], { id: params[0], name: params[1], email: params[2] }); return result(); }
    if (text.startsWith('INSERT INTO account')) { accounts.set(params[2], { id: params[0], userId: params[2], password: params[3] }); return result(); }
    if (text.startsWith('SELECT u.id AS "userId"')) {
      const user = [...users.values()].find(u => u.email === params[0]);
      return result(user ? [{ userId: user.id, password: accounts.get(user.id).password }] : []);
    }
    if (text.startsWith('INSERT INTO session')) {
      if (failInsert) throw new Error('synthetic_session_insert_refused');
      sessions.set(params[2], { id: params[0], expiresAt: new Date(Date.now() + params[1] * 1000), token: params[2], userId: params[3] }); return result();
    }
    if (text.startsWith('DELETE FROM session WHERE "expiresAt"')) {
      for (const [key, row] of sessions) if (row.expiresAt <= new Date()) sessions.delete(key);
      return result();
    }
    if (text === 'DELETE FROM session WHERE token = $1') { sessions.delete(params[0]); return result(); }
    if (text === 'DELETE FROM session WHERE "userId" = $1') {
      for (const [key, row] of sessions) if (row.userId === params[0]) sessions.delete(key);
      return result();
    }
    if (text.startsWith('SELECT id, "userId" AS "userId", "expiresAt" AS "expiresAt" FROM session')) return result(sessions.has(params[0]) ? [sessions.get(params[0])] : []);
    if (text.startsWith('SELECT s."userId" AS "userId"')) {
      const row = sessions.get(params[0]); return result(row ? [{ ...row, email: users.get(row.userId).email }] : []);
    }
    if (text.startsWith('SELECT a.id AS "accountId"')) {
      const row = accounts.get(params[0]); return result(row ? [{ accountId: row.id, password: row.password }] : []);
    }
    if (text.startsWith('UPDATE account SET password')) {
      [...accounts.values()].find(a => a.id === params[0]).password = params[1]; return result();
    }
    throw new Error('offline_check_unexpected_query');
  }
  function pool() {
    const value = Object.assign(new EventEmitter(), { options: {}, query, ended: false,
      connect: async () => ({ query, release() {} }), async end() { value.ended = true; } });
    pools.push(value); return value;
  }
  return { pool, pools, calls, set failInsert(value) { failInsert = value; },
    get sessions() { return sessions; }, get users() { return users; },
    runtime(config) { return { config, behind: { behind: false }, ...Object.fromEntries(
      ['auth', 'learner', 'worker', 'deletion', 'payments', 'provisioner'].map(key => [key, pool()])) }; } };
}

function cookie(response, secure, cleared = false) {
  const value = response.headers['set-cookie'];
  assert.equal(typeof value, 'string');
  assert.equal(value.includes('; Secure'), secure);
  assert.match(value, /^hatoove_owned_session=[A-Za-z0-9_-]*; Path=\/; HttpOnly; SameSite=Lax/);
  assert.equal(value.includes('Max-Age=0'), cleared);
  assert.equal(value.includes('Domain='), false);
  assert.equal(value.includes('Expires='), false);
  return value.split(';')[0];
}
const request = (api, route, body = {}, headers = {}) => api.handle({ method: 'POST', path: route,
  headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), originChecked: true });

try {
  const { loadOwnedApi } = await import('../server/accounts.mjs');
  const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
  const { createPostgresSessions } = await import('../server/owned-postgres/sessions.mjs');
  const { createServer } = await import('../server.js');

  check('canonical HTTP/HTTPS, ports, IPv6 and one optional slash', () => {
    for (const origin of ['https://example.invalid', 'http://localhost:4321', 'http://127.0.0.1:8123', 'https://[::1]:8443', 'https://xn--bcher-kva.example']) {
      assert.equal(parsePublicOrigin(origin), origin); assert.equal(parsePublicOrigin(`${origin}/`), origin);
    }
    assert.equal(readPublicOriginConfig({ B1PREP_PUBLIC_ORIGIN: 'https://example.invalid/' }).secureCookies, true);
  });
  check('absent/blank local behavior is retained even with SaaS enabled', () => {
    for (const value of [undefined, null, '', ' \t\r\n', '\u00a0']) {
      assert.deepEqual(readPublicOriginConfig({ B1PREP_PUBLIC_ORIGIN: value, B1PREP_SAAS: '1' }),
        { publicOrigin: null, requireHttps: false, secureCookies: false });
    }
  });
  check('reject noncanonical and malformed origins with no supplied-value disclosure', () => {
    for (const value of [credentialOrigin.href, 'https://example.invalid/path', 'https://example.invalid?',
      'https://example.invalid#', 'https://example.invalid//', 'https://example.invalid/.', 'https://example.invalid:443',
      'HTTPS://example.invalid', 'https://EXAMPLE.invalid', 'https://bücher.example', 'http://127.1',
      'https://example.invalid\\@evil.invalid', ' https://example.invalid', 'https://example.invalid\n',
      'https://exam\tple.invalid', 'ftp://example.invalid', '//example.invalid', 'null', false, 0, {}, []]) {
      assert.throws(() => parsePublicOrigin(value), invalid);
    }
    let coerced = false;
    assert.throws(() => parsePublicOrigin({ toString() { coerced = true; return 'https://example.invalid'; } }), invalid);
    assert.equal(coerced, false);
  });
  check('HTTPS requirement is strict absent/0/1 and requires HTTPS', () => {
    for (const flag of ['', 'true', 'false', ' 1', '1\n', 1, 0, true, false, null]) {
      assert.throws(() => readPublicOriginConfig({ B1PREP_REQUIRE_HTTPS: flag }), invalid);
    }
    for (const value of [undefined, '', ' ', 'http://localhost:4321']) {
      assert.throws(() => readPublicOriginConfig({ B1PREP_REQUIRE_HTTPS: '1', B1PREP_PUBLIC_ORIGIN: value }), invalid);
    }
    assert.equal(readPublicOriginConfig({ B1PREP_REQUIRE_HTTPS: '0' }).requireHttps, false);
    assert.ok(Object.isFrozen(readPublicOriginConfig({ B1PREP_REQUIRE_HTTPS: '1', B1PREP_PUBLIC_ORIGIN: 'https://example.invalid' })));
  });
  check('server constructor refuses configuration before creating an HTTP server', () => {
    const before = createdServers;
    process.env.B1PREP_REQUIRE_HTTPS = '1';
    assert.throws(() => createServer(), invalid);
    process.env.B1PREP_PUBLIC_ORIGIN = credentialOrigin.href;
    assert.throws(() => createServer(), invalid);
    assert.equal(createdServers, before);
    process.env.B1PREP_PUBLIC_ORIGIN = 'https://example.invalid';
    const server = createServer(); assert.equal(server.listening, false); server.removeAllListeners();
    delete process.env.B1PREP_REQUIRE_HTTPS; delete process.env.B1PREP_PUBLIC_ORIGIN;
  });
  check('direct account runtime validates before opening any pool, including disabled accounts', async () => {
    const before = stub.opened;
    for (const env of [{ B1PREP_REQUIRE_HTTPS: '1' }, { B1PREP_PUBLIC_ORIGIN: 'not-an-origin' },
      { B1PREP_REQUIRE_HTTPS: 'invalid', B1PREP_PUBLIC_ORIGIN: 'https://example.invalid' }]) {
      await assert.rejects(loadOwnedApi({ env }), invalid);
      await assert.rejects(loadOwnedApi({ env: { ...env, B1PREP_ACCOUNTS: '1', OWNAPI_PG_DATABASE: 'synthetic' } }), invalid);
    }
    assert.equal(stub.opened, before);
    assert.equal(await loadOwnedApi({ env: {} }), null);
  });
  check('world and direct sessions validate before touching fixture/pool state', async () => {
    await assert.rejects(createPostgresWorld({ requireHttps: true }), invalid);
    await assert.rejects(createPostgresWorld({ publicOrigin: 'https://example.invalid/path' }), invalid);
    assert.equal(stub.fixtureOpened, 0);
    assert.throws(() => createPostgresSessions({ publicOrigin: 'invalid' }), invalid);
    assert.throws(() => createPostgresSessions({ publicOrigin: 'https://example.invalid', requireHttps: '1' }), invalid);
  });

  for (const [label, origin, secure] of [['HTTPS', 'https://example.invalid/', true], ['local HTTP', 'http://localhost:4321', false], ['unconfigured SaaS fixture', undefined, false]]) {
    check(`actual account/world/API lifecycle uses ${label} configuration and ignores forwarding`, async () => {
      const db = fakeDatabase(); stub.current = db;
      const env = { B1PREP_ACCOUNTS: '1', OWNAPI_PG_DATABASE: 'synthetic', B1PREP_SAAS: '1',
        ...(origin ? { B1PREP_PUBLIC_ORIGIN: origin } : {}), ...(secure ? { B1PREP_REQUIRE_HTTPS: '1' } : {}) };
      const loaded = await loadOwnedApi({ env });
      try {
        assert.equal(loaded.fixture.publicOrigin, origin ? parsePublicOrigin(origin) : null);
        const spoofed = { host: secure ? 'localhost' : 'https.example.invalid', origin: 'https://evil.invalid',
          forwarded: 'proto=https;host=evil.invalid', 'x-forwarded-proto': secure ? 'http' : 'https',
          'x-forwarded-host': 'evil.invalid' };
        const credentials = { email: `${label.replaceAll(' ', '-')}@example.invalid`, password: 'synthetic-password' };
        const signedUp = await request(loaded.api, '/api/auth/sign-up/email', { ...credentials, name: 'Synthetic' }, spoofed);
        assert.equal(signedUp.status, 200); const first = cookie(signedUp, secure);
        const oldToken = first.split('=')[1]; assert.ok(db.sessions.has(oldToken));
        // A later caller mutation cannot change the session factory's fixed policy.
        env.B1PREP_PUBLIC_ORIGIN = secure ? 'http://localhost:4321' : 'https://example.invalid';
        const signedIn = await request(loaded.api, '/api/auth/sign-in/email', credentials, { ...spoofed, cookie: first });
        assert.equal(signedIn.status, 200); const second = cookie(signedIn, secure);
        assert.notEqual(first, second); assert.equal(db.sessions.has(oldToken), false);
        const refused = await request(loaded.api, '/api/auth/sign-in/email', { ...credentials, password: 'wrong' }, spoofed);
        assert.equal(refused.status, 401); assert.equal(refused.headers['set-cookie'], undefined);
        const signedOut = await request(loaded.api, '/api/auth/sign-out', {}, { ...spoofed, cookie: second });
        assert.equal(signedOut.status, 200); cookie(signedOut, secure, true); assert.equal(db.sessions.size, 0);
        const emptySignOut = await request(loaded.api, '/api/auth/sign-out', {}, spoofed);
        cookie(emptySignOut, secure, true);
      } finally { await loaded.close(); }
      assert.ok(db.pools.every(pool => pool.ended));
    });
  }
  check('direct world argument and fixture origin both reach actual sessions', async () => {
    for (const options of [{ publicOrigin: 'https://example.invalid', requireHttps: true }, {}]) {
      const db = fakeDatabase(), pool = db.pool();
      const world = await createPostgresWorld({ fixture: { auth: pool, learner: pool, admin: pool,
        publicOrigin: 'https://example.invalid/', requireHttps: true }, ...options });
      const signed = await world.sessions.signUp({ name: 'Synthetic', email: 'world@example.invalid', password: 'synthetic' });
      assert.match(signed.setCookie, /; Secure$/); assert.match((await world.sessions.signOut({})).setCookie, /; Secure$/);
    }
  });
  check('password rotation, expiry/sweep and configured TTL remain intact', async () => {
    const db = fakeDatabase(), pool = db.pool();
    const sessions = createPostgresSessions({ pool, adminPool: pool, publicOrigin: 'https://example.invalid', sessionTtlSeconds: 41 });
    const first = (await sessions.signUp({ name: 'Synthetic', email: 'rotate@example.invalid', password: 'original' })).setCookie.split(';')[0];
    const next = await sessions.changePassword({ cookie: first }, { currentPassword: 'original', newPassword: 'replacement' });
    assert.match(next.setCookie, /; Secure$/); assert.equal(await sessions.getSession({ cookie: first }), null);
    const token = next.setCookie.split(';')[0];
    assert.ok(await sessions.getSession({ cookie: token }));
    for (const row of db.sessions.values()) row.expiresAt = new Date(0);
    assert.equal(await sessions.getSession({ cookie: token }), null);
    await sessions.signIn({ email: 'rotate@example.invalid', password: 'replacement' });
    assert.equal(db.sessions.size, 1);
    assert.ok(db.calls.filter(c => c.text.startsWith('INSERT INTO session')).every(c => c.params[1] === 41));
  });
  check('failed session creation rolls back and never returns a cookie', async () => {
    const db = fakeDatabase(), pool = db.pool(); db.failInsert = true;
    const sessions = createPostgresSessions({ pool, adminPool: pool, publicOrigin: 'https://example.invalid' });
    await assert.rejects(sessions.signUp({ name: 'Synthetic', email: 'failure@example.invalid', password: 'synthetic' }), /synthetic_session_insert_refused/);
    assert.equal(db.users.size, 0); assert.equal(db.sessions.size, 0);
    assert.ok(db.calls.some(c => c.text === 'ROLLBACK'));
  });

  for (const { name, run } of checks) { await run(); console.log(`PASS ${name}`); }
  console.log(`Session cookie: ${checks.length} offline checks passed; no network, listener or database.`);
} finally {
  hooks.deregister(); delete globalThis[Symbol.for('hatoove.cookie-check')];
  net.Socket.prototype.connect = originalConnect; net.Server.prototype.listen = originalListen;
  http.createServer = originalCreateServer;
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key]; else process.env[key] = savedEnv[key];
  }
}
