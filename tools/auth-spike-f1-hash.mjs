#!/usr/bin/env node
/**
 * AUTH-01-SPIKE — F1 probe: does Better Auth 1.7.6 verify the password hash format that
 * `server/owned-postgres/sessions.mjs` writes?
 *
 * What it executes (no reasoning from docs):
 *   1. Builds a REAL credential row with `sessions.mjs`'s OWN code — it calls
 *      `createPostgresSessions(...).signUp(...)` against the disposable database and reads
 *      back `account.password`. (sessions.mjs does not export `hashPassword`, so calling its
 *      sign-up is the only faithful way to use "its own code".)
 *   2. Asks Better Auth's DEFAULT `verifyPassword` (from `better-auth/crypto`) to verify it.
 *   3. Asks a DEFAULT Better Auth instance to sign in with it.
 *   4. Wires the documented `emailAndPassword.password.hash` / `.verify` hooks with a copy of
 *      sessions.mjs's scrypt code and re-runs sign-in — the shim, if one is possible.
 *   5. Discrimination: the shim must still REJECT a wrong password, and a shim sign-up must
 *      produce a row the shim can read back.
 *
 * Run:  AUTHSPIKE_DEPS=/tmp/authspike-scratch AUTHSPIKE_PG_URL=... node tools/auth-spike-f1-hash.mjs
 * Exit code is always 0: this is a measurement, not a gate. The verdict is in the output.
 */
import { readFile } from 'node:fs/promises';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { loadDeps, DEFAULT_DEPS } from './auth-spike-deps.mjs';

const DB_URL = process.env.AUTHSPIKE_PG_URL
  || 'postgres://authspike:authspike@127.0.0.1:5432/authspike_spike';
const AUTH_SCHEMA = new URL('../spikes/auth-runtime/auth-schema.sql', import.meta.url);
const SESSIONS = new URL('../server/owned-postgres/sessions.mjs', import.meta.url);

const line = (t) => console.log(`\n=== ${t} ===`);
const log = (...a) => console.log(...a);

let deps;
try { deps = await loadDeps(); } catch (error) {
  console.error(`loadDeps failed (AUTHSPIKE_DEPS=${process.env.AUTHSPIKE_DEPS || DEFAULT_DEPS}): ${error.message}`);
  console.error(`Install one: mkdir -p ${DEFAULT_DEPS} && cd ${DEFAULT_DEPS} && npm init -y >/dev/null && npm i better-auth@1.7.6 pg@8.23.1`);
  process.exit(2);
}
const { betterAuth, crypto, Pool } = deps;

const pool = new Pool({ connectionString: DB_URL, max: 4 });
try {
  await pool.query('SELECT 1');
} catch (error) {
  console.error(`Cannot reach ${DB_URL}: ${error.message}`);
  process.exit(2);
}

// ---- reset a disposable schema (synthetic data only) -------------------------
await pool.query('DROP TABLE IF EXISTS "verification", "account", "session", "user" CASCADE');
await pool.query(await readFile(AUTH_SCHEMA, 'utf8'));

// ---- 1. a real hash, written by sessions.mjs's own sign-up -------------------
const { createPostgresSessions } = await import(SESSIONS.href);
const sessions = createPostgresSessions({ pool, adminPool: pool, allowance: null });
const EMAIL = 'spike-f1@example.test';
const PASSWORD = 'correct horse battery staple';
await sessions.signUp({ name: 'F1 Probe', email: EMAIL, password: PASSWORD });
const stored = (await pool.query(
  `SELECT a.password AS password FROM account a JOIN "user" u ON u.id = a."userId"
   WHERE u.email = $1 AND a."providerId" = 'credential'`, [EMAIL])).rows[0].password;

line('1. Hash produced by sessions.mjs itself');
log('email                 :', EMAIL);
log('stored account.password:', stored);
log('parts (colon-separated):', stored.split(':').length);
log('sessions.mjs source     : server/owned-postgres/sessions.mjs:27-31 (scryptSync, Node defaults)');

// ---- 2. Better Auth's DEFAULT verify, and its own hash format ----------------
line('2. Better Auth 1.7.6 default verifyPassword(better-auth/crypto)');
log('default hashPassword() example:', await crypto.hashPassword(PASSWORD));
log('(default hash parts          :', (await crypto.hashPassword(PASSWORD)).split(':').length, ')');
let defaultVerify;
try { defaultVerify = await crypto.verifyPassword({ hash: stored, password: PASSWORD }); }
catch (error) { defaultVerify = `THREW ${error.message}`; }
log('default verifyPassword(stored, realPassword) ->', defaultVerify);

// ---- 3. a default Better Auth instance cannot sign in ------------------------
const base = 'http://127.0.0.1:3999';
const common = {
  database: pool, baseURL: base, secret: 'auth-spike-f1-secret-not-a-real-secret-000000',
  trustedOrigins: [base], emailAndPassword: { enabled: true, minPasswordLength: 12 },
  rateLimit: { enabled: false }, telemetry: { enabled: false }, logger: { level: 'error' },
};
const authDefault = betterAuth(common);
line('3. Default Better Auth signInEmail (no hooks) against the sessions.mjs hash');
let defaultSignIn;
try {
  const r = await authDefault.api.signInEmail({ body: { email: EMAIL, password: PASSWORD }, returnHeaders: true });
  defaultSignIn = { ok: true, status: r.status, data: Object.keys(r.response ?? r) };
} catch (error) { defaultSignIn = { ok: false, status: error.status, body: error.body }; }
log('default sign-in ->', JSON.stringify(defaultSignIn));

// ---- 4. the shim: sessions.mjs's exact scrypt code in the documented hooks ---
const scryptHash = (password) => {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString('hex')}:${scryptSync(password, salt, 32).toString('hex')}`;
};
const scryptVerify = ({ hash, password }) => {
  const [scheme, saltHex, hashHex] = String(hash || '').split(':');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};
const authShim = betterAuth({
  ...common,
  emailAndPassword: { enabled: true, minPasswordLength: 12, password: { hash: scryptHash, verify: scryptVerify } },
});
line('4. Same instance with emailAndPassword.password.{hash,verify} = sessions.mjs scrypt');
let shimSignIn;
try {
  const r = await authShim.api.signInEmail({ body: { email: EMAIL, password: PASSWORD }, returnHeaders: true });
  shimSignIn = { ok: true, status: r.status, token: Boolean(r.response?.token), keys: Object.keys(r.response ?? r) };
} catch (error) { shimSignIn = { ok: false, status: error.status, body: error.body }; }
log('shim sign-in (real password) ->', JSON.stringify(shimSignIn));

line('5. Discrimination');
let wrong;
try {
  await authShim.api.signInEmail({ body: { email: EMAIL, password: 'wrong-password-entirely' } });
  wrong = { ok: true, NOTE: 'ACCEPTED A WRONG PASSWORD — the shim is broken' };
} catch (error) { wrong = { ok: false, status: error.status, code: error.body?.code }; }
log('shim sign-in (wrong password) ->', JSON.stringify(wrong));

const EMAIL2 = 'spike-f1-roundtrip@example.test';
await authShim.api.signUpEmail({ body: { name: 'F1 Roundtrip', email: EMAIL2, password: PASSWORD } });
const stored2 = (await pool.query(
  `SELECT a.password AS password FROM account a JOIN "user" u ON u.id = a."userId"
   WHERE u.email = $1 AND a."providerId" = 'credential'`, [EMAIL2])).rows[0].password;
log('shim sign-up wrote          :', stored2);
log('that is sessions.mjs shape  :', /^scrypt:[0-9a-f]+:[0-9a-f]+$/.test(stored2));
const roundtrip = await authShim.api.signInEmail({ body: { email: EMAIL2, password: PASSWORD } });
log('shim sign-in on shim row ok :', Boolean(roundtrip?.token ?? roundtrip?.user));

line('VERDICT (F1)');
log('default-compatible :', defaultVerify === true ? 'YES' : 'NO');
log('shim-possible      :', shimSignIn.ok && !wrong.ok ? 'YES (emailAndPassword.password.verify)' : 'NO/uncertain');

await pool.end();
