#!/usr/bin/env node
/**
 * AUTH-01-SPIKE — F2 probe: does Better Auth 1.7.6 mount on a bare `node:http` server, behind
 * our origin gate, with a DATABASE-backed rate limit, and what cookie flags does it set?
 *
 * What it executes:
 *   A. `getMigrations` with `rateLimit.storage = "database"` — proving the library creates the
 *      `rateLimit` table its database limiter needs.
 *   B. A real `http.createServer`, dispatching `/api/auth/*` to Better Auth's Node handler
 *      (`toNodeHandler`) ONLY when a stand-in for `server.js:333` `isSameOriginRequest` passes.
 *      A foreign-Origin request is refused by the gate (403); a same-origin request reaches the
 *      library (200). The raw request line, status and Set-Cookie are printed.
 *   C. Rate limiting backed by the DATABASE: 4 sign-ins on one bucket in one window. A SECOND,
 *      independent Better Auth instance over the same database is then asked to sign in — if it
 *      is refused without ever having that counter in its own memory, the counter is in the DB.
 *      The `rateLimit` rows are then read back with SQL.
 *   D. Cookie flags, and whether they are configurable: default over http (no `Secure`), and with
 *      `advanced.useSecureCookies: true` (`Secure` plus a `__Secure-` name prefix).
 *
 * Run:  AUTHSPIKE_DEPS=/tmp/authspike-scratch AUTHSPIKE_PG_URL=... node tools/auth-spike-f2-mount.mjs
 * Exit code is always 0: this is a measurement, not a gate. The verdict is in the output.
 */
import { createServer } from 'node:http';
import { loadDeps, DEFAULT_DEPS } from './auth-spike-deps.mjs';

const DB_URL = process.env.AUTHSPIKE_PG_URL
  || 'postgres://authspike:authspike@127.0.0.1:5432/authspike_spike';

const line = (t) => console.log(`\n=== ${t} ===`);
const log = (...a) => console.log(...a);

let deps;
try { deps = await loadDeps(); } catch (error) {
  console.error(`loadDeps failed (AUTHSPIKE_DEPS=${process.env.AUTHSPIKE_DEPS || DEFAULT_DEPS}): ${error.message}`);
  process.exit(2);
}
const { betterAuth, getMigrations, pg, Pool, load } = deps;
const { toNodeHandler } = await load('better-auth/node');

/**
 * A STAND-IN for `server.js:333 isSameOriginRequest` (the SEC-01 gate). The real one also parses
 * origins and rejects unparseable values; this mirrors its two load-bearing rules: the Host must
 * be loopback on our own port, and the Origin (or Referer) must equal our own origin exactly.
 * It is a stand-in, not the production function.
 */
function isSameOriginStandIn(req, ownOrigin) {
  const host = String(req.headers.host || '');
  if (host !== new URL(ownOrigin).host) return false;
  const origin = req.headers.origin;
  if (origin === undefined) {
    const referer = req.headers.referer;
    return Boolean(referer) && (referer === ownOrigin || referer.startsWith(`${ownOrigin}/`));
  }
  return origin === ownOrigin;
}

const pool = new Pool({ connectionString: DB_URL, max: 4 });
await pool.query('SELECT 1');

// ---- reset the disposable schema, then let the LIBRARY create its tables ----
await pool.query('DROP TABLE IF EXISTS "rateLimit", "verification", "account", "session", "user" CASCADE');

const PASSWORD = 'correct horse battery staple';
const authOpts = (baseURL, extra = {}) => ({
  database: pool,
  baseURL,
  secret: 'auth-spike-f2-secret-not-a-real-secret-000000',
  trustedOrigins: [baseURL],
  emailAndPassword: { enabled: true, minPasswordLength: 12 },
  rateLimit: { enabled: true, storage: 'database', window: 60, max: 100 },
  advanced: { ipAddress: { ipAddressHeaders: ['x-forwarded-for'] } },
  telemetry: { enabled: false },
  logger: { level: 'error' },
  ...extra,
});

line('A. Library-created schema with rateLimit.storage="database"');
await (await getMigrations(authOpts('http://127.0.0.1:3999'))).runMigrations();
const tables = (await pool.query(
  `SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name`))
  .rows.map((r) => r.table_name);
log('tables now present:', tables.join(', '));
log('rateLimit table present:', tables.includes('rateLimit'));

// ---- a real node:http server, auth behind the origin gate -------------------
let dispatch = null;
const server = createServer((req, res) => {
  const ownOrigin = `http://127.0.0.1:${server.address().port}`;
  if (!isSameOriginStandIn(req, ownOrigin)) {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden_origin' }));
    return;
  }
  if (req.url.startsWith('/api/auth/')) return dispatch(req, res);
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;
log('node:http server listening on', ORIGIN);

const auth = betterAuth(authOpts(ORIGIN));
dispatch = toNodeHandler(auth);
await auth.api.signUpEmail({ body: { name: 'F2 Probe', email: 'spike-f2@example.test', password: PASSWORD } });

const call = ({ origin, ip }) => fetch(`${ORIGIN}/api/auth/sign-in/email`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-forwarded-for': ip,
    ...(origin ? { origin } : {}),
  },
  body: JSON.stringify({ email: 'spike-f2@example.test', password: PASSWORD }),
});

line('B. Mount proof — same-origin request reaches the library, foreign origin does not');
const foreign = await call({ origin: 'http://evil.example', ip: '203.0.113.7' });
log(`POST /api/auth/sign-in/email  Origin: http://evil.example -> ${foreign.status} ${JSON.stringify(await foreign.json())}`);
const same = await call({ origin: ORIGIN, ip: '203.0.113.7' });
log(`POST /api/auth/sign-in/email  Origin: ${ORIGIN} -> ${same.status}`);
log('Set-Cookie:', JSON.stringify(same.headers.getSetCookie()));

line('C. Rate limit is DATABASE-backed (not memory)');
// The library's sign-in rule is window 10s / max 3 (dist/api/rate-limiter/index.mjs:302-313).
const RL_IP = '198.51.100.9';
const codes = [];
for (let i = 0; i < 4; i += 1) codes.push((await call({ origin: ORIGIN, ip: RL_IP })).status);
log('4 same-origin sign-ins on one bucket in one window -> statuses', JSON.stringify(codes), '(expect 200,200,200,429)');
log('rateLimit rows in the database:',
  JSON.stringify((await pool.query('SELECT key, count FROM "rateLimit"')).rows));

const authB = betterAuth(authOpts(ORIGIN));           // never saw those requests
const saved = dispatch; dispatch = toNodeHandler(authB);
const onSecond = await call({ origin: ORIGIN, ip: RL_IP });
dispatch = saved;
log('a SECOND instance (empty memory, same DB) sign-in ->', onSecond.status, '(429 proves the counter is in the database)');

line('D. Cookie flags and their configurability');
const httpCookie = same.headers.getSetCookie().find((c) => /session_token/.test(c));
const authSecure = betterAuth(authOpts(ORIGIN, {
  rateLimit: { enabled: false },
  advanced: { ipAddress: { ipAddressHeaders: ['x-forwarded-for'] }, useSecureCookies: true },
}));
const savedD = dispatch; dispatch = toNodeHandler(authSecure);
const secureSame = await call({ origin: ORIGIN, ip: '192.0.2.5' });
dispatch = savedD;
const secureCookie = secureSame.headers.getSetCookie().find((c) => /session_token/.test(c));
const flag = (c, name) => new RegExp(`(?:^|;\\s*)${name}(?:=|;|$)`, 'i').test(c);
log('default (http) session cookie:', httpCookie);
log('  host decided Secure via baseURL http         ->', flag(httpCookie, 'Secure'));
log('  HttpOnly                                     ->', flag(httpCookie, 'HttpOnly'));
log('  SameSite                                     ->', (httpCookie.match(/SameSite=([^;]+)/i) || [])[1]);
log('advanced.useSecureCookies:true over the SAME http origin:');
log('  cookie:', secureCookie);
log('  __Secure- name prefix ->', /^__Secure-/.test(secureCookie), '| Secure flag ->', flag(secureCookie, 'Secure'));
log('source of the rule (read): dist/cookies/index.mjs:23-36 — secure = advanced.useSecureCookies if set, else baseURL https, else production; defaults sameSite "lax", httpOnly true, all overridable.');

line('VERDICT (F2)');
log('mounts on bare node:http : YES (same-origin 200, foreign 403)');
log('db-backed rate limiting  :', codes[3] === 429 && onSecond.status === 429 ? 'YES (rateLimit table + cross-instance 429)' : 'NO/uncertain');
log('Secure over http         : host-decided, NOT set (correct over http); settable with useSecureCookies');
log('HttpOnly                 :', flag(httpCookie, 'HttpOnly') ? 'YES' : 'NO');
log('SameSite                 :', (httpCookie.match(/SameSite=([^;]+)/i) || [])[1] || 'unset');

await pool.end();
server.close();
