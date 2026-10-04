/** PostgreSQL transport, bounded allocations and lazily resolved operator credentials. */
import { openSync, readSync, closeSync, fstatSync, readFileSync, constants } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { isIP } from 'node:net';

const DEFAULT_MAX = Object.freeze({ auth: 4, learner: 4, worker: 4, deletion: 4, payments: 4, provisioner: 2, admin: 2, migration: 2 });
const RUNTIME_ROLES = ['auth', 'learner', 'worker', 'deletion', 'payments', 'provisioner'];
const own = (value, key) => Object.hasOwn(value, key);
const fail = (code = 'postgres_configuration_invalid') => { throw Object.assign(new Error(code), { code }); };
const integer = (value, min, max) => {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) fail();
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) fail();
  return number;
};
const setting = (env, key, fallback, min, max) => own(env, key) ? integer(env[key], min, max) : fallback;

function caBundle(path) {
  let fd;
  try {
    if (typeof path !== 'string' || !path) fail();
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) fail();
    const bytes = readFileSync(fd);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const certificates = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
    if (!certificates?.length || text.replace(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g, '').trim()) fail();
    for (const certificate of certificates) new X509Certificate(certificate);
    return text;
  } catch { fail('postgres_tls_ca_invalid'); }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* fixed errors only */ } }
}

export function connectionSettings(env = {}) {
  const mode = own(env, 'OWNAPI_PG_TLS_MODE') ? env.OWNAPI_PG_TLS_MODE : 'disable';
  if (!['disable', 'verify-full'].includes(mode)) fail();
  if (mode === 'disable' && own(env, 'OWNAPI_PG_TLS_CA_FILE')) fail();
  const ssl = mode === 'disable' ? false : Object.freeze({ rejectUnauthorized: true,
    ...(own(env, 'OWNAPI_PG_TLS_CA_FILE') ? { ca: caBundle(env.OWNAPI_PG_TLS_CA_FILE) } : {}) });
  const maxima = Object.freeze(Object.fromEntries(Object.entries(DEFAULT_MAX).map(([role, value]) =>
    [role, setting(env, `OWNAPI_PG_POOL_${role.toUpperCase()}_MAX`, value, 1, 10)])));
  const runnerMax = setting(env, 'OWNAPI_PG_WORKER_RUNNER_POOL_MAX', 2, 1, 10);
  const apps = setting(env, 'OWNAPI_PG_APP_REPLICAS', 1, 1, 10);
  const workers = setting(env, 'OWNAPI_PG_WORKER_REPLICAS', 1, 1, 10);
  const roleTotals = Object.freeze({ ...Object.fromEntries(RUNTIME_ROLES.map(role => [role, maxima[role] * apps])),
    learner: (maxima.learner + 1) * apps, worker: maxima.worker * apps + runnerMax * workers,
    admin: maxima.admin, migration: maxima.migration });
  if (Object.values(roleTotals).some(value => value > 10)) fail('postgres_role_budget_exceeded');
  const total = Object.values(roleTotals).reduce((sum, value) => sum + value, 0);
  const budget = setting(env, 'OWNAPI_PG_CONNECTION_BUDGET', null, 1, 1000);
  if (budget !== null && total > budget) fail('postgres_connection_budget_exceeded');
  const required = own(env, 'OWNAPI_PG_REQUIRE_PASSWORDS') ? env.OWNAPI_PG_REQUIRE_PASSWORDS : '0';
  if (!['0', '1'].includes(required)) fail();
  return Object.freeze({ ssl, maxima, runnerMax, apps, workers, roleTotals, total, budget,
    requirePasswords: required === '1',
    connectionTimeoutMillis: setting(env, 'OWNAPI_PG_CONNECT_TIMEOUT_MS', undefined, 250, 30000) });
}

function validPassword(value, required) {
  if (value === null || value === undefined) {
    if (required) fail('postgres_password_required');
    return null;
  }
  // Literal credentials are exact: only a file may have one terminal line ending.
  if (typeof value !== 'string' || !value || /[\r\n\0]/.test(value) || Buffer.byteLength(value, 'utf8') > 4096 ||
      new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(value)) !== value) fail('postgres_secret_invalid');
  return value;
}

function secretFile(path) {
  let fd;
  try {
    if (typeof path !== 'string' || !path) fail();
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4098) fail();
    // Bounded read also handles a file growing after fstat. Never read a whole secret of arbitrary size.
    const bytes = Buffer.alloc(4099);
    let count = 0, size;
    while (count < bytes.length && (size = readSync(fd, bytes, count, bytes.length - count, null)) > 0) count += size;
    if (count > 4098) fail();
    const value = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, count)).replace(/\r?\n$/, '');
    return validPassword(value, true);
  } catch { fail('postgres_secret_invalid'); }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* no secret-bearing OS errors */ } }
}

/** Keep the existing writable password properties; file reads occur only when that credential is used. */
export function credentialProperty(target, property, env, key) {
  const hasLiteral = own(env, key), hasFile = own(env, `${key}_FILE`);
  const literal = env[key], file = env[`${key}_FILE`];
  const localTrust = !own(env, 'OWNAPI_PG_REQUIRE_PASSWORDS') || env.OWNAPI_PG_REQUIRE_PASSWORDS === '0';
  Object.defineProperty(target, property, { enumerable: true, configurable: true,
    get() {
      if (hasLiteral && hasFile) fail('postgres_secret_conflict');
      // The retained developer Compose supplies an empty literal. Never extend this exception to files or strict mode.
      if (hasLiteral && literal === '' && localTrust) return null;
      return hasFile ? secretFile(file) : hasLiteral ? validPassword(literal, false) : null;
    },
    set(value) { Object.defineProperty(target, property, { enumerable: true, configurable: true, writable: true, value }); },
  });
}

export function selectedPassword(config, role) {
  const value = role === 'admin' ? config.admin.password : config.passwords[role];
  return validPassword(value, config.connection?.requirePasswords === true);
}

/** Select an allocation, then apply an optional lowering cap. Endpoint fields always come from the caller's config. */
export function poolConnectionOptions(config, role, { allocation = 'role', max } = {}) {
  const settings = config.connection || connectionSettings();
  if (!own(settings.maxima, role) || !['role', 'worker-runner'].includes(allocation) ||
      (allocation === 'worker-runner' && role !== 'worker')) fail();
  const ceiling = allocation === 'worker-runner' ? settings.runnerMax : settings.maxima[role];
  if (max !== undefined && (!Number.isInteger(max) || max < 1 || max > 10 || max > ceiling)) fail('postgres_pool_cap_invalid');
  const { host, port, database } = config.admin;
  if (typeof host !== 'string' || !host || /[\s\0]/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof database !== 'string' || !database || database.includes('\0')) fail();
  if (settings.ssl && !isIP(host) && (host.length > 253 || !host.split('.').every(label =>
    /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label)))) fail('postgres_tls_host_invalid');
  const user = role === 'admin' ? config.admin.user : config.roles[role];
  if (typeof user !== 'string' || !user || user.includes('\0')) fail();
  return { host, port, database, user, password: selectedPassword(config, role), max: max ?? ceiling,
    ssl: settings.ssl ? { ...settings.ssl } : false,
    ...(settings.connectionTimeoutMillis === undefined ? {} : { connectionTimeoutMillis: settings.connectionTimeoutMillis }) };
}
