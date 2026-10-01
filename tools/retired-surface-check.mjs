#!/usr/bin/env node
/**
 * RETIRED-SURFACE-CHECK — the negative check for the file-based progress store.
 *
 * Named in `work/implementation/RETIRED-CHECKS.md` (the MFP-02b/MFP-11a row: *"the negative check that
 * matters is `retired-surface-check`: no `/api/progress` route, no progress file opened"*), promised
 * twice, and never written until now.
 *
 * WHY A NEGATIVE CHECK IS THE RIGHT VEHICLE HERE. The property is not "the learner can save progress";
 * it is **"the retired single-user store cannot come back"**. `/api/progress` attributes a caller by an
 * `x-b1prep-account` HEADER, never by a session, and a request without the header falls back to ONE
 * SHARED RECORD — which is why hosted mode answers 403 `legacy_progress_disabled` instead of serving it.
 * A positive test cannot notice the route quietly returning; this one can, and it runs with **no
 * database, no browser and no Docker** so it can be a CI step on any runner.
 *
 * DISCRIMINATION, measured rather than claimed. Written BEFORE the removal, this check was **red on the
 * un-retired tree**: `server.js` mounted three handlers (one literal per method), still carried the
 * hosted refusal code, and still imported the merge module. Those three legs changed colour with the
 * removal; the file-sentinel, configuration, client and front-page legs were already green and are here
 * to stay green.
 *
 * WHAT IT CANNOT SEE, said plainly: the auth wrap answers **before** any handler, so an anonymous caller
 * gets 401 (or 403 from the mutation/origin gate) whether or not the route exists. The absence of the
 * route is therefore observed through the refusal code that only existed for it and the handler literals
 * in `server.js` — and NOT by expecting a 404 anonymously, which the auth wrap makes indistinguishable
 * from a mounted-but-refused route. The authenticated 404 is asserted where a session exists:
 * `tools/docker-stack-check.mjs`.
 *
 * Usage: node tools/retired-surface-check.mjs
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const record = (id, property, ok, detail) => {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id}  ${property}`);
  if (detail) console.log(`      ${detail}`);
};
/** A measured fact that is not (yet) a pass/fail property. It changes no exit code. */
const note = (id, detail) => console.log(`NOTE  ${id}  ${detail}`);

/* ---------------------------------------------------------------- harness */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'retired-surface-'));
const sentinel = path.join(tmp, 'progress.json');
process.env.B1PREP_ENV_FILE = path.join(tmp, 'throwaway.env');
// THE SENTINEL IS THE POLYGRAPH. If any code path still opens a progress file, it lands here, and the
// directory is the only place it could land: nothing in the check points at the learner's own file.
process.env.B1PREP_PROGRESS_FILE = sentinel;
process.env.B1PREP_FORCE_OFFLINE = '1';
fs.writeFileSync(process.env.B1PREP_ENV_FILE, '# isolated: no provider key\n', 'utf8');

function request(port, method, pathname, { body = null, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { ...headers, ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) } },
      (res) => {
        let text = '';
        res.on('data', (c) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode, text }));
      },
    );
    req.on('error', reject);
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    if (payload) req.write(payload);
    req.end();
  });
}

let server = null;
const started = Date.now();
try {
  const mod = await import(new URL('../server.js', import.meta.url).href);
  server = mod.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  /* -------------------------------------------- the retired store leaves no trace */

  const body = { rev: 1, state: { nodes: { 'tag:x': { n: 1, c: 1 } }, history: [] } };
  const legacy = [
    ['GET', await request(port, 'GET', '/api/progress')],
    ['POST', await request(port, 'POST', '/api/progress', { body })],
    ['DELETE', await request(port, 'DELETE', '/api/progress?scope=all')],
    ['GET(scoped)', await request(port, 'GET', '/api/progress', { headers: { 'x-b1prep-account': 'someone-else' } })],
  ];
  // `legacy_progress_disabled` was the hosted refusal, and it exists ONLY because the route does. It is
  // the observable that disappears with the route, and unlike a 404 it survives the auth wrap, which
  // answers before any handler is reached. The SOURCE is checked as well as the responses: in-process
  // (no SaaS configuration) the mutation guard answers first, so the code can be present and still not
  // appear in a body — which is exactly how a leg goes quietly non-discriminating.
  const serverSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const refusal = legacy.filter(([, res]) => /legacy_progress_disabled/.test(res.text));
  const inSource = /legacy_progress_disabled/.test(serverSource);
  record(
    'R1 refusal code gone',
    'legacy_progress_disabled exists nowhere: not in a response and not in server.js',
    refusal.length === 0 && !inSource,
    legacy.map(([m, res]) => `${m} ${res.status}${/legacy_progress_disabled/.test(res.text) ? '(legacy!)' : ''}`).join(' · ')
      + (inSource ? ' · still defined in server.js' : ''),
  );

  const handlers = serverSource.match(/pathname === '\/api\/progress'/g) || [];
  record(
    'R2 no handler mounted',
    'server.js mounts no /api/progress handler',
    handlers.length === 0,
    handlers.length ? `${handlers.length} handler(s) still in server.js` : 'no handler literal in server.js',
  );

  /* --------------------------------------------------- no file was ever opened */

  const touched = fs.existsSync(sentinel);
  const siblings = fs.readdirSync(tmp).filter((f) => f !== 'throwaway.env');
  record(
    'R3 no progress file',
    'the server never creates or opens a progress file (sentinel path stays untouched)',
    !touched && siblings.length === 0,
    touched || siblings.length ? `created ${JSON.stringify(siblings)}` : `nothing written to ${path.basename(tmp)}`,
  );

  /* ------------------------------------------------------ the server is detached */

  /*
   * THE SERVER-SIDE PROPERTY IS DETACHMENT, not the file's absence — and that distinction is measured,
   * not assumed. `public/js/progress-merge.js` is also imported by the BROWSER-side legacy store
   * (`public/js/store.js`), which eleven checks still drive, so deleting the file now would cascade
   * through the SPA retirement instead of this slice. What must be true here is that nothing the SERVER
   * runs can reach it; the file goes with the SPA, in the next stage.
   */
  const serverImports = /(?:^|\n)\s*import[^;\n]*progress-merge/.test(serverSource) || /from\s+['"][^'"]*progress-merge['"]/.test(serverSource);
  record(
    'R4 server detached',
    'server.js imports nothing from the retired store',
    !serverImports,
    serverImports ? 'server.js still imports progress-merge' : 'no import of it survives in server.js',
  );

  const legacyModule = path.join(ROOT, 'public', 'js', 'progress-merge.js');
  if (fs.existsSync(legacyModule)) {
    note('R4b module on borrowed time',
      'public/js/progress-merge.js still exists for the BROWSER-side legacy store (public/js/store.js imports it); '
      + 'it is deleted with the SPA, and until then it has no server-side caller and no route');
  }

  /* ------------------------------------------- nobody advertises it any more */

  const config = await request(port, 'GET', '/api/config');
  let payload = null;
  try { payload = JSON.parse(config.text); } catch { /* a refusal or a 404 may carry no JSON */ }
  const advertised = payload ? JSON.stringify(payload).match(/progress/i) : null;
  record(
    'R5 not advertised',
    'no served configuration names a progress file or its mode',
    advertised === null,
    advertised ? `GET /api/config mentions ${advertised[0]}` : `GET /api/config -> ${config.status}, no progress field`,
  );

  /* --------------------------------------------- the client cannot ask for it */

  const client = fs.readFileSync(path.join(ROOT, 'public', 'app', 'api.js'), 'utf8');
  record(
    'R6 client clean',
    'the shipped client holds no path to the retired store',
    !client.includes('/api/progress'),
    client.includes('/api/progress') ? 'public/app/api.js contains /api/progress' : 'public/app/api.js has no /api/progress',
  );

  /* ------------------------------------------- the old front page stays retired */

  const home = await request(port, 'GET', '/');
  record(
    'R7 front page',
    'the root serves the brand site and not the retired Certa application',
    home.status === 200 && /Know the exam/.test(home.text) && !/Certa/i.test(home.text),
    `GET / -> ${home.status}, Certa=${/Certa/i.test(home.text)}`,
  );
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed in ${Date.now() - started}ms`);
console.log('No database, no browser, no Docker: this check is a CI step on any runner.\n');
process.exit(failed ? 1 : 0);
