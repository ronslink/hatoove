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
// F-5: the copies the app leaves beside the record. `writeProgress` leaves `.bak`/`.tmp`,
// tools/recover-progress.js leaves `.pre-recovery`, and tools/sync-home.js leaves
// `progress.json.before-ssd-sync-<id>.bak`. None is visible in the UI, so before this fix
// a learner who "deleted everything" still left their text in them. A full delete must
// reach every copy the app created on this install.
const SYNC_BACKUP_PREFIX = 'before-ssd-sync-';
const SYNC_BACKUP_SUFFIX = '.bak';
// What a full local delete deliberately cannot reach, stated rather than guessed. Returned
// by DELETE and printed by the portable build, so `deleted: true` is never read as "every
// copy on every medium is gone".
const OUTSIDE_DELETION_SCOPE = Object.freeze([
  'Copies on removable media: the portable build copies .env and the progress files onto the media, and a delete on the install cannot reach media that is not attached.',
  "A progress export the browser downloaded to the learner's Downloads folder.",
  'The provider key and settings in .env: that is configuration, not learner progress.',
]);

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
 * What the learner UI is allowed to know about the stored configuration.
 *
 * SEC-04, finding F-7: this used to also carry `keyMasked: <first 5>...<last 4>`, i.e.
 * nine characters of the API key, and /api/health and /api/config serve this object
 * without authentication. The server binds 127.0.0.1, so those characters were never
 * remotely reachable and are not a usable credential - but a status display does not need
 * any character of the key at all. `configured` plus `model` is what the Settings pill
 * shows, so that is what is returned. Do not add key material back here, and do not add a
 * per-key fingerprint to replace it (see work/implementation/SEC-04.md).
 */
function publicConfig() {
  const s = settings();
  return {
    configured: Boolean(s.apiKey),
    model: s.model,
    baseUrl: s.baseUrl,
    examDate: s.examDate,
  };
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
    '# B1 Prep configuration - maintained by the app Settings page.',
    '# Get a DeepSeek key at https://platform.deepseek.com/api_keys',
    '',
    ...keys.map((k) => `${k}=${merged[k]}`),
    '',
  ];
  await fsp.writeFile(ENV_PATH, lines.join('\n'), 'utf8');
  for (const [k, v] of Object.entries(merged)) {
    if (v === '') delete process.env[k];
    else process.env[k] = v;
  }
  return publicConfig();
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
 */
function isSameOriginRequest(req, ownPort) {
  const port = String(ownPort);
  const hostUrl = parseOriginLike(`http://${req.headers.host || ''}`);
  if (!hostUrl || !isLoopbackHostname(hostUrl.hostname)) return false;
  if ((hostUrl.port || '80') !== port) return false;

  const origin = req.headers.origin;
  if (origin === undefined) {
    const referer = req.headers.referer;
    if (!referer) return false;
    const refUrl = parseOriginLike(referer);
    return Boolean(refUrl) && refUrl.protocol === 'http:' && isLoopbackHostname(refUrl.hostname) && (refUrl.port || '80') === port;
  }
  const originUrl = parseOriginLike(origin);
  return Boolean(originUrl) && originUrl.protocol === 'http:' && isLoopbackHostname(originUrl.hostname) && (originUrl.port || '80') === port;
}

/** Tolerates parameters such as "; charset=utf-8", rejects anything else. */
function hasJsonContentType(req) {
  return /^application\/json\s*(?:;|$)/i.test(String(req.headers['content-type'] || '').trim());
}

/**
 * A saved baseUrl is where the learner's stored key is sent as a bearer token, so an
 * unauthenticated caller must not be able to point it at an arbitrary host. https is
 * required; http is allowed only for a loopback host, which keeps the documented local
 * mock-provider development path working.
 */
function validateBaseUrl(raw) {
  const url = parseOriginLike(raw);
  if (!url) {
    throw Object.assign(new Error('baseUrl must be a valid absolute URL.'), { status: 400, code: 'invalid_base_url' });
  }
  if (url.protocol === 'https:') return raw.replace(/\/+$/, '');
  if (url.protocol === 'http:' && isLoopbackHostname(url.hostname)) return raw.replace(/\/+$/, '');
  throw Object.assign(new Error('baseUrl must use https, or http only for a loopback host.'), { status: 400, code: 'invalid_base_url' });
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

/**
 * True when `p` exists. `fsp.rm(..., { force: true })` is silent for a missing file, so
 * the delete path needs a real check to report exactly what it removed.
 */
async function pathExists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * The `progress.json.before-ssd-sync-<id>.bak` copies `tools/sync-home.js` leaves beside
 * the record. They hold the learner's full text, so a full delete must reach them too.
 */
async function syncBackupsBeside(progressPath) {
  const dir = path.dirname(progressPath);
  const prefix = `${path.basename(progressPath)}.${SYNC_BACKUP_PREFIX}`;
  try {
    const names = await fsp.readdir(dir);
    return names.filter((name) => name.startsWith(prefix) && name.endsWith(SYNC_BACKUP_SUFFIX)).map((name) => path.join(dir, name));
  } catch {
    return [];
  }
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

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    sendJSON(res, 200, { ok: true, node: process.version, ...publicConfig() });
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
      // F-5: remove every copy the app left beside the record, not just the record. A
      // copy the learner never asked for must not outlive "delete everything": the
      // one-generation `.bak`, a leftover `.tmp`, the recovery tool's `.pre-recovery`,
      // and the home-sync tool's `.before-ssd-sync-<id>.bak` copies all hold their text.
      const candidates = [
        paths.progress,
        `${paths.progress}.bak`,
        // A leftover temp file from an interrupted write would otherwise be renamed
        // into place by the next save and resurrect the record.
        `${paths.progress}.tmp`,
        `${paths.progress}.pre-recovery`,
        ...(await syncBackupsBeside(paths.progress)),
      ];
      const removed = [];
      for (const candidate of candidates) {
        if (!(await pathExists(candidate))) continue;
        try {
          await fsp.rm(candidate, { force: true });
          removed.push(path.basename(candidate));
        } catch {
          /* already gone */
        }
      }
      // The tombstone (.rev) is kept on purpose: it is what refuses a pre-delete write,
      // and it holds no learner text. The media copy is named, never claimed as deleted.
      sendJSON(res, 200, { ok: true, scope: 'all', deleted: true, rev, removed, outsideScope: OUTSIDE_DELETION_SCOPE });
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

  if (pathname === '/api/config' && method === 'GET') {
    sendJSON(res, 200, publicConfig());
    return true;
  }

  if (pathname === '/api/config' && method === 'POST') {
    const body = await readJSON(req);
    const updates = {};
    if (typeof body.apiKey === 'string') updates.DEEPSEEK_API_KEY = body.apiKey.trim();
    if (typeof body.model === 'string' && body.model.trim()) updates.DEEPSEEK_MODEL = body.model.trim();
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) updates.DEEPSEEK_BASE_URL = validateBaseUrl(body.baseUrl.trim());
    if (typeof body.examDate === 'string') updates.EXAM_DATE = body.examDate.trim();
    const cfg = await saveEnv(updates);
    sendJSON(res, 200, { ...cfg, saved: Object.keys(updates) });
    return true;
  }

  if (pathname === '/api/ai' && method === 'POST') {
    const body = await readJSON(req);
    try {
      const result = await callDeepSeek({
        messages: body.messages,
        model: body.model,
        temperature: body.temperature,
        json: body.json !== false,
        maxTokens: body.maxTokens,
        timeoutMs: body.timeoutMs,
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
 */
export function createServer({ ownedApi = null } = {}) {
  return http.createServer(async (req, res) => {
    const pathname = (() => {
      try {
        return new URL(req.url, 'http://127.0.0.1').pathname;
      } catch {
        return '/';
      }
    })();

    try {
      if (pathname.startsWith('/api/')) {
        const method = req.method || 'GET';
        if (method !== 'GET' && method !== 'HEAD') {
          if (!isSameOriginRequest(req, req.socket.localPort)) {
            sendJSON(res, 403, { ok: false, code: 'origin_rejected', error: 'Cross-origin API request rejected.' });
            return;
          }
          if (BODY_METHODS.has(method) && !hasJsonContentType(req)) {
            sendJSON(res, 415, { ok: false, code: 'json_required', error: 'Content-Type must be application/json.' });
            return;
          }
        }
        // OWNAPI-01 mount: opt-in only. Active solely when a caller injects an owned API
        // (server/owned-api.mjs); `node server.js` never does. Placed after the SEC-01 gate,
        // which has already rejected any foreign mutation, hence originChecked: true.
        if (ownedApi && ownedApi.matches(pathname)) return void (await ownedApi.handleNode(req, res, { originChecked: true }));
        const handled = await handleApi(req, res, pathname);
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
  server.listen(PORT, '127.0.0.1', () => {
    const s = settings();
    const line = '='.repeat(58);
    console.log(line);
    console.log('  B1 Prep  -  telc Deutsch B1 adaptive trainer');
    console.log(line);
    console.log(`  App:      http://127.0.0.1:${PORT}`);
    // SEC-04: the banner used to echo <first 5>...<last 4> of the key. A console line does
    // not need key characters either, so it only reports that one is set.
    console.log(`  DeepSeek: ${s.apiKey ? `key set (value hidden), model ${s.model}` : 'NO KEY - offline mode (open Settings to add one)'}`);
    console.log(`  Exam:     ${s.examDate || 'not set (open Settings to add your date)'}`);
    console.log(`  Progress: ${PROGRESS_PATH}`);
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
