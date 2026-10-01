/**
 * COORD PROBE — do the remaining browser checks still have a server after MFP-00?
 *
 * `provider-config-browser-check.mjs:92` builds the server with `mod.createServer()` in-process,
 * and the architect review found that an in-process server keeps the library default
 * (`{ready:true, reason:'unset'}`), so it does NOT get the fail-closed treatment that
 * `node server.js` gets. This probe answers the one question that decides whether the remaining
 * browser checks are fixable or are testing a surface the product direction is deleting:
 * with no accounts configuration, does an in-process server serve the old surface?
 *
 * Read-only. No database, no browser, no provider.
 *
 * Usage: node tools/coord-inprocess-surface-probe.mjs
 */
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-inproc-'));
process.env.B1PREP_ENV_FILE = path.join(tmp, 'throwaway.env');
process.env.B1PREP_PROGRESS_FILE = path.join(tmp, 'progress.json');
process.env.B1PREP_FORCE_OFFLINE = '1';
fs.writeFileSync(process.env.B1PREP_ENV_FILE, '# isolated\n', 'utf8');

const mod = await import(new URL('../server.js', import.meta.url).href);
const server = mod.createServer();
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

function request(method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers }, (res) => {
      let t = '';
      res.on('data', (c) => { t += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: t.slice(0, 120) }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.end();
  });
}

const rows = [
  ['GET', '/api/health'],
  ['GET', '/api/ready'],
  ['GET', '/api/config'],
  ['GET', '/api/v1/account'],
  ['GET', '/api/progress'],
];

console.log('in-process createServer(), no accounts configuration:\n');
for (const [m, p] of rows) {
  try {
    const r = await request(m, p);
    console.log(`  ${String(r.status).padEnd(4)} ${m} ${p.padEnd(20)} ${r.text.replace(/\s+/g, ' ')}`);
  } catch (error) {
    console.log(`  ERR  ${m} ${p}  ${error.message}`);
  }
}

console.log('\nReading: 200 on /api/config or /api/progress means the in-process server still serves');
console.log('the OLD single-user surface, so the browser checks that use it are testing a surface the');
console.log('product direction is deleting - not a surface that needs repairing.');
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
