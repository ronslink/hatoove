/**
 * B1 Prep - local server for the telc Deutsch B1 adaptive trainer.
 *
 * Zero dependencies on purpose: only Node built-ins, so `node server.js` always works.
 * Responsibilities:
 *   1. serve ./public (the app) and ./data (content packs)
 *   2. hold the DeepSeek API key server-side so it never lands in browser storage
 *   3. proxy generation/grading requests to DeepSeek
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
const ENV_PATH = path.join(ROOT, '.env');
// Learner progress is kept here, on disk, as the durable source of truth. The browser's
// localStorage is only a fast local cache: it dies with site data, a different browser,
// or a changed port, which is exactly what you do not want days before an exam.
// B1PREP_PROGRESS_FILE lets a test instance write somewhere else, so running the test
// suite can never clobber real progress.
const PROGRESS_PATH = process.env.B1PREP_PROGRESS_FILE
  ? path.resolve(process.env.B1PREP_PROGRESS_FILE)
  : path.join(ROOT, 'progress.json');

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

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 10) return '****';
  return `${key.slice(0, 5)}...${key.slice(-4)}`;
}

function publicConfig() {
  const s = settings();
  return {
    configured: Boolean(s.apiKey),
    keyMasked: maskKey(s.apiKey),
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
    throw Object.assign(new Error('Invalid JSON body'), { status: 400 });
  }
}

/* --------------------------------------------------------------- progress */

/** Write atomically: a partial write must never destroy a week of study. */
async function writeProgress(data) {
  const tmp = `${PROGRESS_PATH}.tmp`;
  const body = JSON.stringify(data);
  await fsp.writeFile(tmp, body, 'utf8');
  try {
    // Keep one generation back, so a bad save is always recoverable.
    await fsp.copyFile(PROGRESS_PATH, `${PROGRESS_PATH}.bak`);
  } catch {
    /* no previous file yet */
  }
  await fsp.rename(tmp, PROGRESS_PATH);
  return body.length;
}

async function readProgress() {
  for (const p of [PROGRESS_PATH, `${PROGRESS_PATH}.bak`]) {
    try {
      const raw = await fsp.readFile(p, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.nodes && typeof parsed.nodes === 'object') {
        return { found: true, source: p === PROGRESS_PATH ? 'primary' : 'backup', state: parsed };
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

async function handleApi(req, res, pathname) {
  const method = req.method || 'GET';

  if (pathname === '/api/health' && method === 'GET') {
    sendJSON(res, 200, { ok: true, node: process.version, ...publicConfig() });
    return true;
  }

  if (pathname === '/api/progress' && method === 'GET') {
    const { found, source, state } = await readProgress();
    sendJSON(res, 200, found ? { ok: true, found: true, source, state } : { ok: true, found: false });
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
    try {
      // Merge rather than overwrite. Saves are debounced and can arrive from more than
      // one tab; a plain overwrite let a tab holding an older snapshot erase newer
      // answers after the fact. Merging is monotonic, so that cannot happen.
      const existing = await readProgress();
      const merged = existing.found ? mergeProgress(existing.state, state) : state;
      const bytes = await writeProgress(merged);

      const payload = { ok: true, bytes, savedAt: Date.now(), merged: existing.found };
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
    try {
      await fsp.rm(PROGRESS_PATH, { force: true });
      await fsp.rm(`${PROGRESS_PATH}.bak`, { force: true });
    } catch {
      /* already gone */
    }
    sendJSON(res, 200, { ok: true });
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
    if (typeof body.baseUrl === 'string' && body.baseUrl.trim()) updates.DEEPSEEK_BASE_URL = body.baseUrl.trim();
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

const server = http.createServer(async (req, res) => {
  const pathname = (() => {
    try {
      return new URL(req.url, 'http://127.0.0.1').pathname;
    } catch {
      return '/';
    }
  })();

  try {
    if (pathname.startsWith('/api/')) {
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
    if (!res.headersSent) sendJSON(res, err.status || 500, { ok: false, error: err.message });
    else res.end();
  }
});

// A portable launcher can choose its own port without rewriting the saved .env.
const PORT = Number(process.env.B1PREP_PORT) || Number(process.env.PORT) || 4321;
server.listen(PORT, '127.0.0.1', () => {
  const s = settings();
  const line = '='.repeat(58);
  console.log(line);
  console.log('  B1 Prep  -  telc Deutsch B1 adaptive trainer');
  console.log(line);
  console.log(`  App:      http://127.0.0.1:${PORT}`);
  console.log(`  DeepSeek: ${s.apiKey ? `key set (${maskKey(s.apiKey)}), model ${s.model}` : 'NO KEY - offline mode (open Settings to add one)'}`);
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
