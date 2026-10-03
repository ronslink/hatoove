#!/usr/bin/env node
/**
 * API-SPEC-01 — does `docs/openapi.yaml` match the server that is actually running?
 *
 * A specification nobody checks is a description of an intention. This reads the document, extracts
 * every operation it declares, and probes each one against a LIVE server to confirm it behaves the
 * way the document says it does.
 *
 * WHAT IT PROVES
 *   For every operation in the spec: the route EXISTS on the running server, and an anonymous caller
 *   gets exactly what the operation's `security` declares — `401` for a route requiring a session,
 *   and something other than `401` for the two liveness routes that are deliberately public.
 *
 * WHAT IT DOES NOT PROVE
 *   That a response BODY matches its schema, that a signed-in caller succeeds, or that the documented
 *   status codes are exhaustive. It is a surface-and-auth check, not a contract test. The body shapes
 *   belong to the per-slice checks (`docker-stack-check`, `journey-api-check`).
 *
 * WHY IT PARSES THE YAML BY HAND
 *   The root application is deliberately dependency-free (`"dependencies": {}`), so there is no YAML
 *   parser available and adding one to run a check would break a property the repository protects.
 *   The scanner below relies only on this document's own consistent structure, which we control, and
 *   it fails loudly if it finds no operations rather than silently passing.
 *
 * Usage:
 *   node tools/api-spec-check.mjs --base=http://127.0.0.1:<disposable-app-port>
 *   tools/docker-stack-check.mjs invokes this against its synthetic Compose project.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(ROOT, 'docs', 'openapi.yaml');
const baseArg = process.argv.find((a) => a.startsWith('--base='));
if (!baseArg) throw new Error('API-SPEC-01 requires an explicit disposable --base URL; run tools/docker-stack-check.mjs');
const target = new URL(baseArg.slice('--base='.length));
if (target.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(target.hostname)
    || !target.port || ['4300', '55440'].includes(target.port) || target.username || target.password
    || target.pathname !== '/' || target.search || target.hash) {
  throw new Error('API-SPEC-01 requires a disposable loopback app port, never the learner preview');
}
const BASE = target.origin;

const results = [];
const pass = (id, detail) => { results.push('PASS'); console.log(`PASS ${id}`); if (detail) console.log(`     ${detail}`); };
const fail = (id, detail) => { results.push('FAIL'); console.log(`FAIL ${id}`); if (detail) console.log(`     ${detail}`); };

console.log(`\n=== API-SPEC-01 — spec vs ${BASE} ===\n`);

const text = readFileSync(SPEC, 'utf8');

/**
 * Split the document into one block per path. Path keys sit at two-space indentation under `paths:`,
 * and operations sit under them; scanning the raw text is enough for a document whose shape we own.
 */
const operations = [];
const pathBlocks = text.split(/^  (?=\/api\/)/m).slice(1);
for (const block of pathBlocks) {
  const pathMatch = /^(\/api\/[^\s:]+):/.exec(block);
  if (!pathMatch) continue;
  const pathname = pathMatch[1];
  const publicByDesign = /^\s+security: \[\]/m.test(block);
  for (const methodMatch of block.matchAll(/^ {4}(get|head|post|put|delete|patch):/gm)) {
    operations.push({ pathname, method: methodMatch[1].toUpperCase(), publicByDesign });
  }
}

/*
 * EXIT WITHOUT `process.exit()` — and this is a correctness fix, not tidiness.
 *
 * `process.exit()` tears the process down immediately, and `fetch` keeps keep-alive sockets alive. On
 * Windows the race between that teardown and a socket closing trips a libuv assertion
 * (`!(handle->flags & UV_HANDLE_CLOSING)`), which ABORTS the process. Measured, not theorised: three
 * consecutive identical runs exited 0, then aborted with `0xC0000409`, then exited 0 again — so the
 * check's verdict was unreliable roughly one run in three, and it misled the person reading it (me: the
 * first suspicion was a real defect in the check).
 *
 * Setting `exitCode` instead lets the runtime drain its own handles: the verdict is the same and the
 * process cannot abort on the way out.
 */
function finish(code) {
  process.exitCode = code;
}

if (!operations.length) {
  fail('S0-spec-parseable', `no operations found in ${path.relative(ROOT, SPEC)} — the scanner found nothing, so it cannot verify anything`);
  console.log('\n0 passed, 1 failed\n');
  finish(1);
}
pass('S0-spec-parseable', `${operations.length} operation(s) declared across ${pathBlocks.length} path(s)`);

/** An anonymous request in the exact shape a route requires, so the auth answer is the only variable. */
async function probe({ pathname, method }) {
  const headers = {};
  if (!['GET','HEAD'].includes(method)) { headers.origin = BASE; headers['content-type'] = 'application/json'; }
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers,
      body: ['GET','HEAD'].includes(method) ? undefined : '{}',
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    return res.status;
  } catch (error) {
    return { error: error.message };
  }
}

const publicOps = operations.filter((o) => o.publicByDesign);
const gatedOps = operations.filter((o) => !o.publicByDesign);

for (const op of publicOps) {
  const status = await probe(op);
  if (status === 401) fail(`S-public ${op.method} ${op.pathname}`, 'declared public (security: []) but refused an anonymous caller with 401');
  else if (typeof status !== 'number') fail(`S-public ${op.method} ${op.pathname}`, `unreachable: ${status.error}`);
  else pass(`S-public ${op.method} ${op.pathname}`, `anonymous -> ${status} (public by declaration)`);
}

for (const op of gatedOps) {
  const status = await probe(op);
  if (status === 401) pass(`S-gated  ${op.method} ${op.pathname}`, 'anonymous -> 401 (auth-wrapped, as declared)');
  else if (typeof status !== 'number') fail(`S-gated  ${op.method} ${op.pathname}`, `unreachable: ${status.error}`);
  else fail(`S-gated  ${op.method} ${op.pathname}`, `declared to require a session but answered ${status} to an anonymous caller`);
}

/*
 * THE SPEC MUST NOT DOCUMENT A ROUTE THAT DOES NOT EXIST — rewritten 2 October 2026 (SPA-RETIRE 6).
 *
 * This block used to REQUIRE `/api/config` and `/api/ai` to be present, on the reasoning that "an
 * undocumented retired route is how a route quietly comes back". That reasoning held while they were
 * retired-but-PRESENT. They are now DELETED from `server.js` (SPA-RETIRE 6), so the requirement inverts:
 * a spec that documents a route an operator could still call is the defect, and the negative check that
 * keeps the route gone is `tools/retired-surface-check.mjs` (legs R8/R9).
 *
 * Both directions are asserted, in the shape the `/api/progress` leg already uses: no PATH KEY may be
 * declared, and the REMOVAL must be recorded in a comment — because a spec forbidden to name a retired
 * route cannot say it was ever there, and losing that record is how it comes back.
 */
for (const route of ['/api/progress', '/api/config', '/api/ai']) {
  const pathKey = new RegExp(`^ {2}${route.replace(/\//g, '\\/')}:( |$)`, 'm');
  if (pathKey.test(text)) fail(`S-absent ${route}`, 'the spec still declares a path for a route that is deleted: remove it, and let retired-surface-check guard its absence');
  else pass(`S-absent ${route}`, 'no path key declared, because the route no longer exists');
  const recorded = new RegExp(`^[ \\t]*#.*${route.replace(/\//g, '\\/')}.*REMOVED`, 'm');
  if (recorded.test(text)) pass(`S-recorded ${route} removal`, 'the spec records WHY the route is absent, which a bare deletion would lose');
  else fail(`S-recorded ${route} removal`, 'the spec no longer records that this route was removed and when; that record is how the next reader avoids re-adding it');
}
/*
 * The lesson from the `/api/progress` leg is folded into the loop above and worth stating once: a
 * MENTION is not a DOCUMENTATION. The leg used to be `text.includes('/api/progress')` and went red the
 * moment the spec recorded the removal in a comment. The property is about a PATH KEY a tool would read —
 * and a spec forbidden to name a retired route cannot record that it was ever there, which is why
 * `S-recorded` exists beside `S-absent`.
 */

const failed = results.filter((r) => r === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
finish(failed ? 1 : 0);
