/**
 * B1 Prep - local server for the telc Deutsch B1 adaptive trainer.
 *
 * Zero dependencies on purpose: only Node built-ins, so `node server.js` always works.
 * Responsibilities:
 *   1. serve ./public (the app) and ./data (content packs)
 *   2. hold the DeepSeek API key server-side so it never lands in browser storage
 *   3. proxy generation/grading requests to DeepSeek
 *   4. reject cross-origin state changes, so a page the learner visits cannot retarget
 *      the stored key or spend their credit (see isSameOriginRequest)
 *
 * Binds to 127.0.0.1 only, because it stores an API key.
 */

import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { mergeProgress, progressEqual } from './public/js/progress-merge.js';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
// .env holds the provider key and the saved settings. B1PREP_ENV_FILE lets the
// origin/authorization tests write to a throwaway path, so a test run can never touch
// the learner's real .env (the same idea as B1PREP_PROGRESS_FILE below).
const ENV_PATH = process.env.B1PREP_ENV_FILE
  ? path.resolve(process.env.B1PREP_ENV_FILE)
  : path.join(ROOT, '.env');
// Learner progress is kept here, on disk, as the durable source of truth. The browser's
// localStorage is only a fast local cache: it dies with site data, a different browser,
// or a changed port, which is exactly what you do not want days before an exam.
// B1PREP_PROGRESS_FILE lets a test instance write somewhere else, so running the test
// suite can never clobber real progress.
const PROGRESS_PATH = process.env.B1PREP_PROGRESS_FILE
  ? path.resolve(process.env.B1PREP_PROGRESS_FILE)
  : path.join(ROOT, 'progress.json');
// SEC-05 (finding F-2 race): a monotonic revision, persisted *beside* the progress
// record. Ordinary POSTs still merge - that protection is deliberate and stays - but a
// reset has to be able to invalidate a write that left before it. The revision, plus the
// high-water mark of the last delete (`deletedThrough`), is what a stale write is refused
// against.
//
// It lives in its own file rather than inside progress.json because a full reset deletes
// progress.json: a revision stored inside the record would be destroyed by exactly the
// delete it exists to survive. Beside the record it survives the delete and a restart.
const PROGRESS_REV_PATH = `${PROGRESS_PATH}.rev`;
// The revision of a server that has never accepted a write or a delete.
const INITIAL_REV = 0;
// F-4: account-scoped records. A request may name an account with the header below; its
// record then lives in its own file beside the legacy one. A request without the header
// keeps the legacy unscoped path byte-for-byte, which is what a pre-account install still
// uses. This is attribution/isolation of accounts that share one machine, NOT an
// authentication boundary - see work/implementation/F4-SCOPE-01.md.
const ACCOUNT_HEADER = 'x-b1prep-account';
// An opaque account id. No dots, so it can never collide with the .bak/.tmp/.rev suffixes.
const ACCOUNT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
// The unscoped paths: the legacy single-user record.
const LEGACY_PATHS = Object.freeze({ accountId: null, progress: PROGRESS_PATH, rev: PROGRESS_REV_PATH });

/**
 * Resolve the progress paths for a request. An invalid account token is a 400 rather than
 * a silent fallback, so a malformed scope can never be mistaken for the legacy record.
 */
function accountPaths(req) {
  const raw = req.headers[ACCOUNT_HEADER];
  if (raw === undefined) return LEGACY_PATHS;
  const value = Array.isArray(raw) ? raw[0] : String(raw);
  const id = value.trim();
  if (!ACCOUNT_ID_RE.test(id)) {
    throw Object.assign(new Error('Invalid account scope'), { status: 400, code: 'invalid_account' });
  }
  return { accountId: id, progress: `${PROGRESS_PATH}.${id}`, rev: `${PROGRESS_PATH}.${id}.rev` };
}

/* ------------------------------------------------------- hosted (SaaS) mode */

/**
 * SAAS-RUNTIME-01 (issue #63 step A). The hosted runtime is opt-in and **off by default**
 * (`B1PREP_SAAS=1`). A plain `node server.js` keeps the local single-user install - the
 * file-based progress record and the single-user AI path - but it is **not byte-identical** to
 * the pre-slice server. The A2 hardenings below apply in every mode by design: `/api/ai`
 * requires a session whenever a session port is mounted, the caller's model is discarded, the
 * input is bounded, the AI body is capped at 256 KB, and `/api/ai/test` needs the operator
 * opt-in **and** an operator token. `GET /api/ready` is new. None of them is reachable from the
 * shipped client; the five observable differences are listed in `work/implementation/SAAS-RUNTIME-01.md`.
 *
 * Hosted mode changes four things, and they are all refusals rather than features:
 *   * the legacy file-based progress routes - the `x-b1prep-account` owner selector and its
 *     unscoped fallback - are unavailable; they were attribution, never authentication
 *     (HOSTED-BLOCKERS B5);
 *   * `/api/ai` requires a verified session, ignores the caller's model and bounds the input
 *     server-side (HOSTED-BLOCKERS B6); `/api/ai/test` becomes operator-only;
 *   * a missing auth/database configuration, or a failed initialisation, fails closed: learner
 *     routes answer 503 and `GET /api/ready` reports not ready - it never downgrades to
 *     anonymous single-user behaviour;
 *   * the trusted origin is the deployment's own public origin (`B1PREP_PUBLIC_ORIGIN`, exact).
 *     The bind stays loopback; a same-host reverse proxy is the deployment shape, so the
 *     request's Host is the public name rather than 127.0.0.1.
 *
 * `B1PREP_SAAS` is the explicit flag. It is off by default and it is *not* a local-install
 * setting; see `work/implementation/SAAS-RUNTIME-01.md`.
 */
function isSaasMode(env = process.env) {
  return env.B1PREP_SAAS === '1';
}

/** The deployment's own public origin, or null. http/https, origin only (no path/query/hash). */
function configuredPublicOrigin(env = process.env) {
  const raw = String(env.B1PREP_PUBLIC_ORIGIN || '').trim();
  if (!raw) return null;
  const url = parseOriginLike(raw);
  if (!url || url.search || url.hash || (url.pathname !== '' && url.pathname !== '/')) return null;
  return url;
}

/**
 * A1. The legacy progress record is refused in hosted mode. Deliberately a 403 with a code
 * rather than a 404: the route exists in the code and its removal is planned with the
 * persistence migration, so an operator should be able to tell "disabled" from "typo".
 */
const LEGACY_PROGRESS_REFUSAL = Object.freeze({
  status: 403,
  code: 'legacy_progress_disabled',
  error: 'The file-based progress record is not available on a hosted deployment. Learner progress is served by the account-scoped attempt routes.',
});

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/* ------------------------------------------------------------------ config */

function parseEnvText(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (val.length > 1 && ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

function readEnvFile() {
  try {
    return parseEnvText(fs.readFileSync(ENV_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function loadEnvIntoProcess() {
  for (const [k, v] of Object.entries(readEnvFile())) {
    if (v !== '') process.env[k] = v;
  }
}
loadEnvIntoProcess();

const ENV_ORDER = ['DEEPSEEK_API_KEY', 'DEEPSEEK_MODEL', 'DEEPSEEK_BASE_URL', 'EXAM_DATE', 'PORT'];

function settings() {
  // B1PREP_FORCE_OFFLINE=1 makes the server behave as if no key were configured, so the
  // offline test suite stays deterministic on a machine that has a real key saved,
  // without anyone having to delete it.
  const forcedOffline = process.env.B1PREP_FORCE_OFFLINE === '1';
  return {
    apiKey: forcedOffline ? '' : String(process.env.DEEPSEEK_API_KEY || '').trim(),
    model: String(process.env.DEEPSEEK_MODEL || 'deepseek-chat').trim() || 'deepseek-chat',
    baseUrl: String(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').trim().replace(/\/+$/, ''),
    examDate: String(process.env.EXAM_DATE || '').trim(),
  };
}

/**
 * What a route is allowed to report about server configuration.
 *
 * PROVIDER-CONFIG-01 (D1). SEC-04 / F-7 had already stopped serving characters of the key,
 * but GET /api/config and /api/health still reported `configured` (whether a key exists)
 * plus `model`/`baseUrl` (the operator's provider setup), and POST /api/config let the
 * browser write the key and base URL into the server's .env. On a hosted service that is an
 * operator control handed to a tenant. The provider key, base URL and model now come from
 * server environment configuration only, and **no route reports anything about the key** -
 * not its characters, not its presence, not a hint. `configured` is a presence report, so
 * it is gone; a client that used to branch on it learns that AI is unavailable when the
 * call fails, which is how a hosted client behaves.
 *
 * The two read routes therefore carry only non-key state:
 *   * GET /api/health carries a bare liveness payload (`ok`, `node`) for supervision;
 *   * GET /api/config carries the learner's own non-provider preference (`examDate`), and only
 *     on the local single-user install - on a hosted runtime the whole route is absent
 *     (CONFIG-ANON-01, see the route comment in handleApi), because a machine-global examDate
 *     is readable by every visitor.
 * Do not add a key-derived field back here - not a length, not a fingerprint, not a
 * presence flag (see work/implementation/PROVIDER-CONFIG-01.md, D1.2).
 */
function publicConfig() {
  return { examDate: settings().examDate };
}

async function saveEnv(updates) {
  const merged = { ...readEnvFile() };
  for (const [k, v] of Object.entries(updates)) {
    if (v === undefined || v === null) continue;
    merged[k] = String(v);
  }
  const keys = [
    ...ENV_ORDER.filter((k) => k in merged),
    ...Object.keys(merged).filter((k) => !ENV_ORDER.includes(k)),
  ];
  const lines = [
    '# B1 Prep configuration.',
    '# The provider key, base URL and model are operator settings: set DEEPSEEK_API_KEY,',
    '# DEEPSEEK_BASE_URL and DEEPSEEK_MODEL in the server environment, never through a route.',
    '',
    ...keys.map((k) => `${k}=${merged[k]}`),
    '',
  ];
  await fsp.writeFile(ENV_PATH, lines.join('\n'), 'utf8');
  for (const [k, v] of Object.entries(merged)) {
    if (v === '') delete process.env[k];
    else process.env[k] = v;
  }
  return Object.keys(updates);
}

/* -------------------------------------------------------------------- http */

function sendJSON(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limitBytes = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJSON(req, limitBytes) {
  const raw = await readBody(req, limitBytes);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error('Invalid JSON body'), { status: 400, code: 'invalid_json' });
  }
}

/* ------------------------------------------------------- request boundary */

// The API can rewrite .env (including where the key is sent) and spend the learner's
// provider credit. The server binds 127.0.0.1 only, so no other machine can connect;
// but the learner's own browser can still be pointed at this port by any page they
// visit. The same-origin policy stops that page from *reading* the response, not from
// *sending* the request, so the server itself must reject foreign state changes.
//
// Precedent: spikes/auth-runtime/server.mjs rejects a non-GET whose Origin is not the
// server's own base URL with 403 origin_rejected, and requires application/json.
//
// Deliberate choices for the cases the finding leaves open:
//   * A missing Origin is NOT treated as same-origin. Browsers send Origin on every
//     non-GET request, including same-origin fetch and form posts, so trusting an
//     absent header would leave exactly the blind-POST path this closes. When Origin
//     is absent we fall back to Referer; if neither identifies this server, we reject.
//   * `Origin: null` (a sandboxed iframe, a data: or file: page) is rejected too, since
//     it marks an opaque origin rather than this app.
//   * The Host header must also name a loopback host on the port we are listening on,
//     so a DNS-rebinding name cannot reach the API even with a matching Origin.
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
/** Methods whose bodies this server parses as JSON. */
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

function parseOriginLike(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

function isLoopbackHostname(hostname) {
  return LOOPBACK_HOSTNAMES.has(hostname) || hostname === '::ffff:127.0.0.1';
}

/**
 * True only when a state-changing API request comes from this server's own origin.
 * `ownPort` is the local socket port, so this also works on an ephemeral test port.
 *
 * Local mode (default): the trusted origin is loopback on this port, exactly as before.
 * Hosted mode (`B1PREP_SAAS=1`): the trusted origin is `B1PREP_PUBLIC_ORIGIN` - the
 * deployment's own public origin, exact (A4). The loopback list is *not* consulted there,
 * because behind a same-host reverse proxy the request's Host is the public name; the bind
 * stays loopback and a foreign origin is refused in both modes.
 */
function isSameOriginRequest(req, ownPort, { saas = false, origin = null } = {}) {
  if (saas) {
    if (!origin) return false;
    if (!hostMatchesOrigin(origin, req.headers.host)) return false;
    const header = req.headers.origin;
    if (header !== undefined) return originMatches(origin, header);
    const referer = req.headers.referer;
    return referer ? originMatches(origin, referer) : false;
  }
  const port = String(ownPort);
  const hostUrl = parseOriginLike(`http://${req.headers.host || ''}`);
  if (!hostUrl || !isLoopbackHostname(hostUrl.hostname)) return false;
  if ((hostUrl.port || '80') !== port) return false;

  const requestOrigin = req.headers.origin;
  if (requestOrigin === undefined) {
    const referer = req.headers.referer;
    if (!referer) return false;
    const refUrl = parseOriginLike(referer);
    return Boolean(refUrl) && refUrl.protocol === 'http:' && isLoopbackHostname(refUrl.hostname) && (refUrl.port || '80') === port;
  }
  const originUrl = parseOriginLike(requestOrigin);
  return Boolean(originUrl) && originUrl.protocol === 'http:' && isLoopbackHostname(originUrl.hostname) && (originUrl.port || '80') === port;
}

/**
 * F3 (independent review `saas-runtime-review-hermes-20261001-a`). Strict admission check on a
 * value that is about to be parsed as an origin.
 *
 * `new URL()` follows WHATWG normalisation, which treats a BACKSLASH in a special-scheme URL as a
 * path separator. So `https://app.example.test\@attacker.example` parses with the host
 * `app.example.test` and the rest as a path, i.e. it is **accepted as an exact match** against a
 * configured origin. A browser cannot produce such an `Origin` header — it serialises
 * `scheme://host[:port]` — and a non-browser client that forges headers was never constrained by
 * this check, so this is **not an exploit path**. It is fixed anyway because the check *claims*
 * exact equality, and a security control should refuse input it cannot interpret literally rather
 * than lean on the parser's leniency.
 *
 * Deliberately narrow: it rejects only characters that can change how the value parses. A hostname
 * is letters, digits, dots and hyphens (and brackets for IPv6); a port is digits.
 */
function hasUnparseableOriginCharacters(raw) {
  const value = String(raw || '');
  // Control characters, whitespace inside the value, and the backslash WHATWG turns into a path break.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f\\]/.test(value)) return true;
  // The value must look like scheme://host[:port] with nothing after the authority.
  return !/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[A-Za-z0-9.\-[\]:]+$/.test(value);
}

/** scheme+host+port equality against the configured origin (default ports normalised by URL). */
function originMatches(configured, value) {
  if (hasUnparseableOriginCharacters(value)) return false;
  const url = parseOriginLike(String(value));
  return Boolean(url) && `${url.protocol}//${url.host}` === `${configured.protocol}//${configured.host}`;
}

/**
 * The Host header names the configured origin's host. An explicit port must match the
 * configured one; a Host without a port matches, because a reverse proxy usually forwards
 * `Host: app.example.com` for an https origin on its default port.
 */
function hostMatchesOrigin(configured, hostHeader) {
  const raw = String(hostHeader || '');
  if (hasUnparseableOriginCharacters(`http://${raw}`)) return false;
  const url = parseOriginLike(`http://${raw}`);
  if (!url || url.hostname !== configured.hostname) return false;
  if (!url.port) return true;
  return url.port === (configured.port || (configured.protocol === 'https:' ? '443' : '80'));
}

/** Tolerates parameters such as "; charset=utf-8", rejects anything else. */
function hasJsonContentType(req) {
  return /^application\/json\s*(?:;|$)/i.test(String(req.headers['content-type'] || '').trim());
}

/* --------------------------------------------------------------- progress */

/** Write atomically: a partial write must never destroy a week of study. */
async function writeProgress(data, paths = LEGACY_PATHS) {
  const tmp = `${paths.progress}.tmp`;
  const body = JSON.stringify(data);
  await fsp.writeFile(tmp, body, 'utf8');
  try {
    // Keep one generation back, so a bad save is always recoverable.
    await fsp.copyFile(paths.progress, `${paths.progress}.bak`);
  } catch {
    /* no previous file yet */
  }
  await fsp.rename(tmp, paths.progress);
  return body.length;
}

/**
 * Replace the stored record without keeping the previous generation.
 *
 * Used by the scoped delete (clearing the error notebook): the learner asked for that
 * text to be gone, and `writeProgress` would copy the record that still contains it to
 * `progress.json.bak`. The write itself stays atomic (temp file + rename), so the rest
 * of the progress is not at risk; only the one-generation backup is dropped, because
 * keeping it would keep exactly the entries the learner deleted.
 */
async function writeProgressScoped(data, paths = LEGACY_PATHS) {
  const tmp = `${paths.progress}.tmp`;
  const body = JSON.stringify(data);
  await fsp.writeFile(tmp, body, 'utf8');
  await fsp.rename(tmp, paths.progress);
  await fsp.rm(`${paths.progress}.bak`, { force: true });
  return body.length;
}

/**
 * Read the revision marker. Missing or unreadable means the initial state (revision 0,
 * no delete yet), so a progress.json written before this change keeps working.
 */
async function readRevision(paths = LEGACY_PATHS) {
  const whole = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  try {
    const parsed = JSON.parse(await fsp.readFile(paths.rev, 'utf8'));
    return { rev: whole(parsed?.rev), deletedThrough: whole(parsed?.deletedThrough) };
  } catch {
    return { rev: INITIAL_REV, deletedThrough: 0 };
  }
}

/** Persist the revision marker atomically, so a crash cannot leave it half-written. */
async function writeRevision(marker, paths = LEGACY_PATHS) {
  const tmp = `${paths.rev}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify({ rev: marker.rev, deletedThrough: marker.deletedThrough }), 'utf8');
  await fsp.rename(tmp, paths.rev);
}

/**
 * Decide whether an incoming write may be applied.
 *
 * The monotonic merge must stay: a partial write from one tab must never erase newer
 * answers from another, so an ordinary write that is merely behind the current revision
 * is still merged. The one case that must be refused is a write that left *before a
 * delete*: `deletedThrough` is the revision the last delete produced, and a snapshot older
 * than that would restore the record the learner just deleted (the F-2 race).
 *
 * Deliberate choices, so they are not re-litigated by accident:
 *   * Missing `rev` (a lean client that only posts `{state}`): accepted while no delete
 *     has ever happened, so an existing simple client keeps working; refused once a
 *     delete has advanced the revision, because such a write cannot be proven newer than
 *     the delete and silently accepting it would reopen exactly this hole.
 *   * `rev` ahead of the stored one: accepted. It means this server lost its marker (a
 *     restored backup, a copied progress.json), and refusing would discard learner
 *     evidence. It cannot cross a delete, because the comparison is against
 *     `deletedThrough`, not against `rev`.
 */
function classifyWrite(rawRev, marker) {
  const hasRev = typeof rawRev === 'number' && Number.isFinite(rawRev);
  if (!hasRev) {
    return marker.deletedThrough > 0
      ? { accept: false, reason: 'missing_revision_after_delete', revision: INITIAL_REV }
      : { accept: true, revision: INITIAL_REV };
  }
  const rev = Math.max(0, Math.floor(rawRev));
  if (rev < marker.deletedThrough) return { accept: false, reason: 'older_than_delete', revision: rev };
  return { accept: true, revision: rev };
}

async function readProgress(paths = LEGACY_PATHS) {
  for (const p of [paths.progress, `${paths.progress}.bak`]) {
    try {
      const raw = await fsp.readFile(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.nodes && typeof parsed.nodes === 'object') {
        return { found: true, source: p === paths.progress ? 'primary' : 'backup', state: parsed };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return { found: false, source: null, state: null };
}

const ALLOWED_STATIC_ROOTS = [PUBLIC_DIR, DATA_DIR];

function resolveStatic(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const rel = decoded.replace(/^\/+/, '');
  const base = rel.startsWith('data/') ? DATA_DIR : PUBLIC_DIR;
  const sub = rel.startsWith('data/') ? rel.slice('data/'.length) : rel;
  const target = path.resolve(base, sub || 'index.html');
  if (!ALLOWED_STATIC_ROOTS.some((root) => target === root || target.startsWith(root + path.sep))) return null;
  return target;
}

async function serveStatic(req, res, pathname) {
  const target = resolveStatic(pathname === '/' ? '/index.html' : pathname);
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }
  const file = stat.isDirectory() ? path.join(target, 'index.html') : target;
  try {
    const data = await fsp.readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/* ---------------------------------------------------------------- deepseek */

class ApiError extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function callDeepSeek({ messages, model, temperature, json, maxTokens, timeoutMs }) {
  const s = settings();
  if (!s.apiKey) {
    throw new ApiError('No DeepSeek API key configured.', 400, 'NO_KEY');
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new ApiError('messages[] is required.', 400, 'BAD_REQUEST');
  }

  const body = {
    model: model || s.model,
    messages,
    temperature: typeof temperature === 'number' ? temperature : 0.85,
    stream: false,
    max_tokens: Number.isFinite(maxTokens) ? maxTokens : 4096,
  };
  if (json) body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  // Observed generation times are ~4-10s, with a 9-call mock finishing in ~12s. 120s is
  // a ~10x margin, and bounds how long a stalled request can hang the learner.
  const timer = setTimeout(() => controller.abort(), Number.isFinite(timeoutMs) ? timeoutMs : 120000);
  try {
    const res = await fetch(`${s.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${s.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();

    if (!res.ok) {
      let detail = text.slice(0, 600);
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.error?.message || detail;
      } catch {
        /* keep raw text */
      }
      const code = res.status === 401 ? 'BAD_KEY' : res.status === 402 ? 'NO_CREDIT' : res.status === 429 ? 'RATE_LIMIT' : 'UPSTREAM';
      throw new ApiError(`DeepSeek ${res.status}: ${detail}`, res.status, code);
    }

    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new ApiError('DeepSeek returned a non-JSON envelope.', 502, 'BAD_ENVELOPE');
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new ApiError('DeepSeek returned an empty completion.', 502, 'EMPTY');
    }
    return {
      content,
      usage: payload.usage || null,
      model: payload.model || body.model,
      finishReason: payload?.choices?.[0]?.finish_reason || null,
    };
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (err.name === 'AbortError') throw new ApiError('DeepSeek request timed out.', 504, 'TIMEOUT');
    throw new ApiError(`Could not reach DeepSeek: ${err.message}`, 502, 'NETWORK');
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ routes */

// A2 bounds. The caller may send a timeout and a token limit, but the server decides the
// ceiling; a request cannot ask for an unbounded completion or an unbounded hang.
const AI_BODY_LIMIT_BYTES = 256 * 1024;
const AI_MAX_MESSAGES = 40;
const AI_MAX_CHARS_PER_MESSAGE = 24000;
const AI_MAX_TOKENS = 4096;
const AI_MIN_TIMEOUT_MS = 1000;
const AI_MAX_TIMEOUT_MS = 120000;

// F1. `/api/ai/test` is operator-only, and *operator* is not a learner session. The first
// version gated it on `B1PREP_AI_TEST` alone, so with that single variable set an anonymous
// same-origin caller - or any signed-in learner - reached the provider with the operator's
// key and spent the operator's credits. A flag must never be the only thing between a learner
// and a credit-spending route, and this runtime's session port has no operator principal, so a
// learner cookie cannot be one. The diagnostic therefore needs two independent operator facts:
// the opt-in flag AND a dedicated operator token that only the server operator holds. Neither a
// learner session nor an anonymous caller can present it, in every configuration.
const AI_TEST_TOKEN_HEADER = 'x-b1prep-operator-token';

/** The operator token, from the dedicated header or `Authorization: Bearer`. */
function operatorTokenFrom(req) {
  const header = req.headers[AI_TEST_TOKEN_HEADER];
  if (typeof header === 'string' && header !== '') return header;
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
  return match ? match[1].trim() : null;
}

/** Constant-time comparison; a missing on either side is never a match. */
function operatorTokenMatches(provided, expected) {
  if (typeof provided !== 'string' || provided === '' || typeof expected !== 'string' || expected === '') return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The refusal for `POST /api/ai/test`, or null when the operator credential is present. It
 * deliberately never consults a session: a verified learner session is not an operator.
 */
function aiTestRefusal(req, env = process.env) {
  const message = 'POST /api/ai/test is operator-only. A learner session is never sufficient.';
  if (env.B1PREP_AI_TEST !== '1') {
    return { status: 403, code: 'ai_test_operator_only', error: `${message} Set B1PREP_AI_TEST=1 in the server environment to enable the diagnostic.` };
  }
  if (!env.B1PREP_AI_TEST_TOKEN) {
    return { status: 403, code: 'ai_test_operator_only', error: `${message} No operator token is configured.` };
  }
  if (!operatorTokenMatches(operatorTokenFrom(req), env.B1PREP_AI_TEST_TOKEN)) {
    return { status: 403, code: 'ai_test_operator_only', error: `${message} Present the operator token.` };
  }
  return null;
}

/**
 * Validate and bound an `/api/ai` body. The model is deliberately absent: it is operator
 * configuration (`DEEPSEEK_MODEL`), and a caller-supplied model is discarded, not honoured.
 */
function validateAiRequest(body) {
  const messages = body && body.messages;
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > AI_MAX_MESSAGES) {
    throw Object.assign(new Error(`messages[] must be an array of 1..${AI_MAX_MESSAGES}`), { status: 422, code: 'invalid_messages' });
  }
  for (const m of messages) {
    if (!m || typeof m !== 'object' || typeof m.role !== 'string' || typeof m.content !== 'string'
      || m.content.length > AI_MAX_CHARS_PER_MESSAGE) {
      throw Object.assign(new Error('each message needs a string role and a string content within the limit'), { status: 422, code: 'invalid_messages' });
    }
  }
  const number = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const maxTokens = number(body.maxTokens);
  const timeoutMs = number(body.timeoutMs);
  return {
    messages,
    temperature: clamp(number(body.temperature) ?? 0.85, 0, 2),
    json: body.json !== false,
    maxTokens: maxTokens === null ? AI_MAX_TOKENS : clamp(Math.floor(maxTokens), 1, AI_MAX_TOKENS),
    timeoutMs: timeoutMs === null ? AI_MAX_TIMEOUT_MS : clamp(Math.floor(timeoutMs), AI_MIN_TIMEOUT_MS, AI_MAX_TIMEOUT_MS),
  };
}

/**
 * The verified session behind a request, resolved through the owned API's own session port.
 * There is no second identity source: a header, a body field or a query never names an account.
 * Returns null when there is no session, when accounts are not mounted, or when the port is not
 * configured - all three are "no identity", and the AI routes refuse on any of them.
 */
async function requestIdentity(owned, req) {
  if (!owned) return null;
  try {
    const reply = await owned.handle({ method: 'GET', path: '/api/auth/get-session', headers: req.headers });
    if (!reply || reply.status !== 200) return null;
    const parsed = JSON.parse(reply.body);
    const user = parsed && parsed.user;
    return user && typeof user.id === 'string' && user.id.trim() !== '' ? { id: user.id, email: user.email || null } : null;
  } catch {
    return null;
  }
}

async function handleApi(req, res, pathname, ctx = {}) {
  const method = req.method || 'GET';
  const { owned = null, saas = false } = ctx;
  // A2. Identity is required on the AI routes in hosted mode, and whenever accounts are
  // mounted (then a session exists and it is the only acceptable source of it). A plain local
  // install with accounts off keeps its single-user AI path, which is the local contract.
  const identityRequired = saas || Boolean(owned);

  if (pathname === '/api/health' && method === 'GET') {
    // Liveness only: a supervised service needs this, and it must reveal nothing about the
    // provider key. No `configured`, no `model`, no `baseUrl` (D1.2).
    sendJSON(res, 200, { ok: true, node: process.version });
    return true;
  }

  // A3 readiness. /api/health must keep answering while the process is up; this route says
  // whether learner traffic can be served at all, so a supervisor never has to guess from 503s.
  if (pathname === '/api/ready' && method === 'GET') {
    const readiness = ctx.readiness || { ready: false, reason: 'starting' };
    sendJSON(res, readiness.ready ? 200 : 503, {
      ok: readiness.ready,
      ready: readiness.ready,
      mode: readiness.ready ? (saas ? 'saas' : 'local') : 'unconfigured',
      reason: readiness.reason || (readiness.ready ? 'ready' : 'not_ready'),
    });
    return true;
  }

  // A1 / HOSTED-BLOCKERS B5. The file-based progress routes are attributed by a caller header,
  // never authenticated, and a request without the header falls back to a shared record. In the
  // hosted runtime they are unavailable - refused before any path is resolved, so neither another
  // account's file nor the shared one can be named, read, written or deleted by an anonymous
  // caller. (Removal of the routes themselves - with the `x-b1prep-account` selector, the file,
  // its backups and its revision handling - is SAAS-RETIRE-01; this slice only makes the entry
  // point fail closed without its account/database configuration, see below.)
  if (saas && pathname === '/api/progress') {
    sendJSON(res, LEGACY_PROGRESS_REFUSAL.status, { ok: false, code: LEGACY_PROGRESS_REFUSAL.code, error: LEGACY_PROGRESS_REFUSAL.error });
    return true;
  }

  if (pathname === '/api/progress' && method === 'GET') {
    const paths = accountPaths(req);
    const { found, source, state } = await readProgress(paths);
    // A GET only reports the revision; it never advances it, so a client can learn the
    // value it must send with its next write without disturbing anyone else.
    const { rev } = await readRevision(paths);
    sendJSON(
      res,
      200,
      found
        ? { ok: true, found: true, source, rev, state, accountId: paths.accountId }
        : { ok: true, found: false, rev, accountId: paths.accountId }
    );
    return true;
  }

  if (pathname === '/api/progress' && method === 'POST') {
    // Generous limit: history plus the error notebook can legitimately reach a megabyte.
    const body = await readJSON(req, 16 * 1024 * 1024);
    const state = body?.state;
    if (!state || typeof state !== 'object' || !state.nodes || typeof state.nodes !== 'object') {
      sendJSON(res, 400, { ok: false, error: 'state.nodes is required' });
      return true;
    }
    // SEC-05: refuse a write that left before the last delete. The revision the client
    // believes it is updating travels with the write; a stale one gets 409 and no write.
    const paths = accountPaths(req);
    const marker = await readRevision(paths);
    const verdict = classifyWrite(body?.rev, marker);
    if (!verdict.accept) {
      sendJSON(res, 409, {
        ok: false,
        code: 'stale_revision',
        reason: verdict.reason,
        error:
          verdict.reason === 'missing_revision_after_delete'
            ? 'A reset has happened and this write carries no revision. Re-read /api/progress before saving.'
            : 'A reset invalidated this write. Re-read /api/progress before saving.',
        rev: marker.rev,
        deletedThrough: marker.deletedThrough,
      });
      return true;
    }
    try {
      // Merge rather than overwrite. Saves are debounced and can arrive from more than
      // one tab; a plain overwrite let a tab holding an older snapshot erase newer
      // answers after the fact. Merging is monotonic, so that cannot happen.
      const existing = await readProgress(paths);
      const merged = existing.found ? mergeProgress(existing.state, state) : state;
      const bytes = await writeProgress(merged, paths);
      // Every accepted write advances the revision, so a later delete always outranks
      // every write that left before it. `max` keeps it monotonic even for a client that
      // somehow arrived with a higher revision than this server has issued.
      const rev = Math.max(marker.rev, verdict.revision) + 1;
      await writeRevision({ rev, deletedThrough: marker.deletedThrough }, paths);

      const payload = { ok: true, bytes, savedAt: Date.now(), merged: existing.found, rev };
      // Only send the state back when the merge actually recovered something the
      // caller was missing, so ordinary saves stay cheap.
      if (!progressEqual(state, merged)) payload.state = merged;
      sendJSON(res, 200, payload);
    } catch (err) {
      sendJSON(res, 500, { ok: false, error: `Could not save progress: ${err.message}` });
    }
    return true;
  }

  if (pathname === '/api/progress' && method === 'DELETE') {
    // SEC-02 fix for finding F-2: a user-visible reset must really delete.
    // POST keeps merging on purpose (a partial write must never erase a week of study),
    // so deletion is a separate, explicitly scoped operation. `scope` defaults to 'all'
    // for the existing reset path. An unrecognised scope is rejected instead of
    // guessing, so a typo can never delete more (or less) than the caller asked for.
    let scope = 'all';
    try {
      scope = new URL(req.url, 'http://127.0.0.1').searchParams.get('scope') || 'all';
    } catch {
      /* unreachable: the pathname was parsed from the same URL */
    }
    const paths = accountPaths(req);

    if (scope === 'all') {
      // SEC-05: leave a tombstone before removing anything. The revision is recorded
      // *first*, so a crash between the two steps leaves it high (which only costs the
      // next writer a re-read) rather than low (which would let a pre-delete write
      // through). Every write that left before this delete is now below `deletedThrough`
      // and is refused instead of restoring the record.
      let rev;
      try {
        const marker = await readRevision(paths);
        rev = marker.rev + 1;
        await writeRevision({ rev, deletedThrough: rev }, paths);
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: `Could not record the reset: ${err.message}` });
        return true;
      }
      try {
        await fsp.rm(paths.progress, { force: true });
        await fsp.rm(`${paths.progress}.bak`, { force: true });
        // A leftover temp file from an interrupted write would otherwise be renamed
        // into place by the next save and resurrect the record.
        await fsp.rm(`${paths.progress}.tmp`, { force: true });
      } catch {
        /* already gone */
      }
      sendJSON(res, 200, { ok: true, scope: 'all', deleted: true, rev });
      return true;
    }

    if (scope === 'errors') {
      const existing = await readProgress(paths);
      // The notebook clear moves the revision too: an in-flight save still carrying the
      // cleared entries must not merge them back.
      let rev;
      try {
        const marker = await readRevision(paths);
        rev = marker.rev + 1;
        await writeRevision({ rev, deletedThrough: rev }, paths);
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: `Could not clear the notebook: ${err.message}` });
        return true;
      }
      if (!existing.found) {
        sendJSON(res, 200, { ok: true, scope: 'errors', existed: false, cleared: 0, rev });
        return true;
      }
      try {
        await writeProgressScoped({ ...existing.state, errors: [], updatedAt: Date.now() }, paths);
      } catch (err) {
        sendJSON(res, 500, { ok: false, error: `Could not clear the notebook: ${err.message}` });
        return true;
      }
      const cleared = Array.isArray(existing.state.errors) ? existing.state.errors.length : 0;
      sendJSON(res, 200, { ok: true, scope: 'errors', existed: true, cleared, rev });
      return true;
    }

    sendJSON(res, 400, { ok: false, code: 'invalid_scope', error: `Unknown delete scope: ${scope}` });
    return true;
  }

  // CONFIG-ANON-01. The machine-global config route is not served on a hosted runtime.
  //
  // POST /api/config required no identity: it refused only the provider field *names* and then
  // handed everything else to saveEnv, which wrote the shared .env file and assigned it into
  // process.env. With B1PREP_SAAS=1 and no cookie at all, {"examDate":"2099-01-01"} returned
  // 200, rewrote EXAM_DATE=2099-01-01 in the env file, and every visitor then read the
  // attacker's date from GET /api/config. The same-origin gate is satisfied by design (a
  // browser supplies Origin) and the handler never consulted identity - while the learner
  // route one line away refused. GET /api/config reports the same machine-global value to
  // every visitor, so the read goes with the write.
  //
  // On a hosted runtime neither method is handled: the request falls through to the generic
  // 404, exactly like any other unknown endpoint (this is deletion, not an identity gate on a
  // machine-global write). The learner's exam date lives in GET/PUT /api/v1/settings, per
  // account under the session-derived owner. The local single-user install (B1PREP_SAAS off)
  // keeps the route: it has no visitors to protect it from, its only write consumer is its own
  // settings view, and removing it belongs to the local-install cutover, not this slice.
  // See work/implementation/CONFIG-ANON-01.md.
  if (saas && pathname === '/api/config') {
    return false;
  }

  if (pathname === '/api/config' && method === 'GET') {
    sendJSON(res, 200, publicConfig());
    return true;
  }

  if (pathname === '/api/config' && method === 'POST') {
    const body = await readJSON(req);
    // D1.1: the provider is operator configuration. A browser may not set, change or read
    // the key, the base URL or the model. Those attempts are refused with a clear status
    // rather than silently ignored, and nothing is written to the environment file.
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const refused = ['apiKey', 'baseUrl', 'model'].filter((field) => Object.hasOwn(keys, field));
    if (refused.length) {
      sendJSON(res, 403, {
        ok: false,
        code: 'provider_config_is_operator_only',
        error: 'The provider configuration (' + refused.join(', ') + ') is set by the server operator, not from the browser.',
        refused,
      });
      return true;
    }
    const updates = {};
    if (typeof keys.examDate === 'string') updates.EXAM_DATE = keys.examDate.trim();
    const saved = await saveEnv(updates);
    sendJSON(res, 200, { ok: true, ...publicConfig(), saved });
    return true;
  }

  if (pathname === '/api/ai' && method === 'POST') {
    // A2.1: an anonymous caller must never reach the operator's provider key. With accounts
    // mounted (or in hosted mode) the session is required; without either, this is the local
    // single-user install and the request proceeds.
    if (identityRequired && !(await requestIdentity(owned, req))) {
      sendJSON(res, 401, { ok: false, code: 'unauthenticated', error: 'A signed-in session is required for the AI routes.' });
      return true;
    }
    const body = await readJSON(req, AI_BODY_LIMIT_BYTES);
    let params;
    try {
      params = validateAiRequest(body);
    } catch (err) {
      sendJSON(res, err.status || 422, { ok: false, code: err.code || 'invalid_request', error: err.message });
      return true;
    }
    try {
      // A2.2: the caller's `model` is not passed. The model is operator configuration
      // (`DEEPSEEK_MODEL`) exactly as the provider is (D1), so `callDeepSeek` falls back to
      // the operator's model. Nothing a request says can change it.
      const result = await callDeepSeek({
        messages: params.messages,
        temperature: params.temperature,
        json: params.json,
        maxTokens: params.maxTokens,
        timeoutMs: params.timeoutMs,
      });
      sendJSON(res, 200, { ok: true, ...result });
    } catch (err) {
      sendJSON(res, err.status || 500, {
        ok: false,
        code: err.code || 'ERROR',
        error: err.message,
      });
    }
    return true;
  }

  if (pathname === '/api/ai/test' && method === 'POST') {
    // A2.4 / F1: a diagnostic that spends the operator's credits is operator-only, and an
    // operator is not a learner session. Both the opt-in flag and a dedicated operator token
    // are required; an anonymous caller and a signed-in learner are both refused, in every
    // configuration, before any provider call.
    const refusal = aiTestRefusal(req);
    if (refusal) {
      sendJSON(res, refusal.status, { ok: false, code: refusal.code, error: refusal.error });
      return true;
    }
    try {
      const result = await callDeepSeek({
        messages: [
          { role: 'system', content: 'Antworte ausschliesslich mit JSON.' },
          { role: 'user', content: 'Gib genau dieses JSON zurueck: {"ok":true}' },
        ],
        temperature: 0,
        json: true,
        maxTokens: 32,
        timeoutMs: 30000,
      });
      sendJSON(res, 200, { ok: true, model: result.model, sample: result.content.trim().slice(0, 120) });
    } catch (err) {
      sendJSON(res, err.status || 500, { ok: false, code: err.code || 'ERROR', error: err.message });
    }
    return true;
  }

  return false;
}

/**
 * Build the HTTP server without listening, so a test can start it in-process on an
 * ephemeral port (see tools/server-origin-check.mjs).
 *
 * `ownedApi` may be a handle (`{ api }`, as `loadOwnedApi()` returns) or the API itself. It
 * is read per request, so a caller may also set `server.ownedApi` after construction - which
 * is how `node server.js` mounts accounts once the database is ready, without delaying the
 * listening socket.
 */
export function createServer({ ownedApi = null } = {}) {
  const resolveOwnedApi = (server) => {
    const value = server.ownedApi !== undefined && server.ownedApi !== null ? server.ownedApi : ownedApi;
    if (!value) return null;
    return typeof value.matches === 'function' ? value : value.api || null;
  };
  return http.createServer(async (req, res) => {
    const pathname = (() => {
      try {
        return new URL(req.url, 'http://127.0.0.1').pathname;
      } catch {
        return '/';
      }
    })();

    try {
      const saas = isSaasMode();
      const origin = configuredPublicOrigin();
      const serverRef = req.socket.server;
      // Fail closed (SAAS-MODEL-01 Step 2). The runtime is a multi-user service: it is ready
      // only once its account/database configuration has loaded. `node server.js` ALWAYS sets
      // `saasReadiness`; an unset value (an in-process `createServer()` used by a unit check)
      // keeps the library default. The gate below is no longer conditioned on `B1PREP_SAAS`:
      // omitting the mode flag must not re-open the single-user path.
      const readiness = (serverRef && serverRef.saasReadiness) || { ready: true, reason: 'unset' };
      if (pathname.startsWith('/api/')) {
        const method = req.method || 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
          if (!isSameOriginRequest(req, req.socket.localPort, { saas, origin })) {
            sendJSON(res, 403, { ok: false, code: 'origin_rejected', error: 'Cross-origin API request rejected.' });
            return;
          }
          if (BODY_METHODS.has(method) && !hasJsonContentType(req)) {
            sendJSON(res, 415, { ok: false, code: 'json_required', error: 'Content-Type must be application/json.' });
            return;
          }
        }
        // Fail closed, in every mode. While the runtime is not ready - the account/database
        // configuration is missing, still loading, or failed - every API route except liveness
        // and readiness refuses. It never answers as a single-user app, and the refusal is a
        // 503 with a short reason token rather than an anonymous fallback.
        if (!readiness.ready && pathname !== '/api/health' && pathname !== '/api/ready') {
          sendJSON(res, 503, { ok: false, code: 'not_ready', error: `The hosted runtime is not ready (${readiness.reason || 'starting'}).` });
          return;
        }
        // Owned-API mount: opt-in only (B1PREP_ACCOUNTS=1, see server/accounts.mjs). With
        // accounts off this is inactive and the single-user behaviour is unchanged. Placed
        // after the SEC-01 gate, which has already rejected any foreign mutation, hence
        // originChecked: true - the owned API must never re-check what is already enforced,
        // or a rejected request would be handled twice.
        const owned = resolveOwnedApi(req.socket.server);
        if (owned && owned.matches(pathname)) return void (await owned.handleNode(req, res, { originChecked: true }));
        const handled = await handleApi(req, res, pathname, { owned, saas, origin, readiness });
        if (!handled) sendJSON(res, 404, { ok: false, error: `Unknown endpoint ${pathname}` });
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Method not allowed');
        return;
      }
      await serveStatic(req, res, pathname);
    } catch (err) {
      const payload = { ok: false, error: err.message };
      if (err && err.code) payload.code = err.code;
      if (!res.headersSent) sendJSON(res, err.status || 500, payload);
      else res.end();
    }
  });
}

// `node server.js` starts the learner's server; merely importing the module does not.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  const server = createServer();
  // A portable launcher can choose its own port without rewriting the saved .env.
  const PORT = Number(process.env.B1PREP_PORT) || Number(process.env.PORT) || 4321;
  // PILOT-01b: the bind host comes from configuration. It defaults to loopback, so running on a
  // developer's machine is unchanged and nothing is exposed by accident. A container must set
  // `B1PREP_BIND=0.0.0.0`, because a process listening on a container's own loopback cannot be
  // reached through a published port at all - the container would answer nothing.
  const BIND_HOST = String(process.env.B1PREP_BIND || '').trim() || '127.0.0.1';
  // Fail closed from the first request (SAAS-MODEL-01 Step 2). The runtime is NOT ready until
  // its account/database configuration has loaded, in EVERY mode - the old `!isSaasMode()`
  // default is gone, because omitting `B1PREP_SAAS` must no longer re-open a single-user app.
  server.saasReadiness = { ready: false, reason: 'starting' };

  /*
   * Accounts (A-01 mount). The account/database configuration is now REQUIRED: the absence of
   * `B1PREP_ACCOUNTS`/`OWNAPI_PG_DATABASE` is an error, not a local mode. Loading is deliberately
   * *after* the socket starts, so the socket exists before a slow database is ready - but until it
   * loads, readiness stays false and every learner route answers 503. A failure never downgrades
   * to single-user; it stays not-ready and names the missing or failed configuration. No
   * credential or connection string is ever printed.
   */
  import('./server/accounts.mjs').then(async ({ loadOwnedApi, accountsConfig, accountsSummary }) => {
    const config = accountsConfig();
    const saas = isSaasMode();
    let summary = accountsSummary(null, config);
    if (config.enabled) {
      try {
        const loaded = await loadOwnedApi();
        if (loaded) {
          server.ownedApi = loaded.api;
          summary = accountsSummary(loaded, config);
          // MFP-01: the runtime never migrates. If the applied head is behind what this code
          // expects, readiness is `schema_behind` -- /api/ready refuses (503) and names it, so
          // an operator runs `node server/migrate.mjs`. /api/health keeps answering (liveness
          // is not readiness). The runtime holds no migration credentials, so it CANNOT apply
          // the pending migration even by accident.
          server.saasReadiness = loaded.schemaBehind && loaded.schemaBehind.behind
            ? { ready: false, reason: 'schema_behind' }
            : { ready: true, reason: 'ready' };
          const shutdown = () => { loaded.close().finally(() => process.exit(0)); };
          process.once('SIGINT', shutdown);
          process.once('SIGTERM', shutdown);
        } else {
          server.saasReadiness = { ready: false, reason: 'accounts_unavailable' };
        }
      } catch (error) {
        // Say what failed, never the credentials: `error.message` from `pg` can contain the
        // host and database but not the password. The detail goes to the operator console only;
        // the readiness reason stays a short token that is safe on an anonymous route.
        const detail = error && error.message ? error.message : error;
        server.saasReadiness = { ready: false, reason: 'accounts_failed' };
        summary = `accounts: FAILED to load (${detail}) - the runtime refuses learner routes (503)`;
      }
    } else {
      // The configuration is absent. That is a misconfiguration of the entry point, not a
      // single-user install. Fail closed and name the missing configuration (never a credential).
      server.saasReadiness = { ready: false, reason: config.reason };
      summary = `accounts: off (${config.reason}) - the runtime refuses learner routes (503)`;
    }
    console.log(`  Accounts: ${summary}`);
    console.log(`  Readiness: ${server.saasReadiness.ready ? 'ready' : `NOT READY (${server.saasReadiness.reason})`}`);
  }).catch((error) => {
    server.saasReadiness = { ready: false, reason: 'accounts_unavailable' };
    console.log(`  Accounts: wiring unavailable (${error && error.message ? error.message : error})`);
  });

  server.listen(PORT, BIND_HOST, () => {
    const s = settings();
    const line = '='.repeat(58);
    console.log(line);
    console.log('  B1 Prep  -  telc Deutsch B1 adaptive trainer');
    console.log(line);
    console.log(`  App:      http://${BIND_HOST === '0.0.0.0' || BIND_HOST === '::' ? 'localhost' : BIND_HOST}:${PORT}`);
    // SEC-04: the banner used to echo <first 5>...<last 4> of the key. A console line does
    // not need key characters either, so it only reports that one is set. This is the
    // operator's console, not a route: the learner UI is told nothing about the key (D1).
    console.log(`  DeepSeek: ${s.apiKey ? `key set (value hidden), model ${s.model}` : 'NO KEY - offline mode (set DEEPSEEK_API_KEY in the server environment)'}`);
    console.log(`  Exam:     ${s.examDate || 'not set (set EXAM_DATE, or use the learner settings page)'}`);
    if (isSaasMode()) {
      const o = configuredPublicOrigin();
      console.log(`  SaaS:     hosted runtime - trusted origin ${o ? o.origin : 'NOT CONFIGURED (mutations are refused)'}`);
    }
    // The single-user file record is retired in every mode: the runtime is a multi-user service
    // that fails closed without its account/database configuration (SAAS-MODEL-01 Step 2).
    console.log(`  Progress: file record disabled (account-scoped attempts)`);
    console.log(line);
    console.log('  Ctrl+C to stop.');
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // The common case is a second double-click on the desktop shortcut, not a
      // misconfiguration, so say that first rather than alarming the learner.
      console.error('');
      console.error(`  B1 Prep is already running - nothing to do.`);
      console.error(`  Open or refresh:  http://127.0.0.1:${PORT}`);
      console.error('');
      console.error(`  (Port ${PORT} is occupied. To run a second copy, set a different PORT in .env.)`);
      console.error('');
    } else {
      console.error(err);
    }
    process.exit(1);
  });
}
