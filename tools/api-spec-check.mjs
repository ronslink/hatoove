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
 *   node tools/api-spec-check.mjs [--base=http://localhost:4300]
 *   docker compose up -d --build && node tools/api-spec-check.mjs
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = path.join(ROOT, 'docs', 'openapi.yaml');
const baseArg = process.argv.find((a) => a.startsWith('--base='));
const BASE = (baseArg ? baseArg.slice('--base='.length) : 'http://localhost:4300').replace(/\/$/, '');

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
  for (const methodMatch of block.matchAll(/^ {4}(get|post|put|delete|patch):/gm)) {
    operations.push({ pathname, method: methodMatch[1].toUpperCase(), publicByDesign });
  }
}

if (!operations.length) {
  fail('S0-spec-parseable', `no operations found in ${path.relative(ROOT, SPEC)} — the scanner found nothing, so it cannot verify anything`);
  console.log('\n0 passed, 1 failed\n');
  process.exit(1);
}
pass('S0-spec-parseable', `${operations.length} operation(s) declared across ${pathBlocks.length} path(s)`);

/** An anonymous request in the exact shape a route requires, so the auth answer is the only variable. */
async function probe({ pathname, method }) {
  const headers = {};
  if (method !== 'GET') { headers.origin = BASE; headers['content-type'] = 'application/json'; }
  try {
    const res = await fetch(`${BASE}${pathname}`, {
      method,
      headers,
      body: method === 'GET' ? undefined : '{}',
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

// The retired surface must be DOCUMENTED, not merely absent: an undocumented retired route is how a
// route quietly comes back. This asserts those conventions are visible in the document.
//
// `/api/progress` LEFT THIS LIST ON 2 OCTOBER 2026 because it stopped being a retired-but-present route
// and became an ABSENT one: its handlers, its account header, its revision marker and its file writes
// are deleted from server.js, and `tools/retired-surface-check.mjs` is the negative check that keeps
// them gone. Documenting a route that no longer exists is the opposite mistake — a spec that names a
// route an operator could still call.
for (const required of ['/api/config', '/api/ai', 'deprecated: true']) {
  if (text.includes(required)) pass(`S-documented ${required}`, 'present in the spec');
  else fail(`S-documented ${required}`, 'missing from the spec: a retired route that is not documented is how it comes back');
}
/*
 * A MENTION IS NOT A DOCUMENTATION — tightened 2 October 2026.
 *
 * This leg used to be `text.includes('/api/progress')`, and it went red the moment the spec recorded the
 * removal in a comment: `# /api/progress REMOVED 2 October 2026 ...`. The property is "the spec must not
 * DOCUMENT a route that does not exist", which means a PATH KEY a tool would read, not any occurrence of
 * the string — a spec that is forbidden to name a retired route cannot record that it was ever there,
 * and losing that record is its own defect. The negative check for un-documenting it is
 * `tools/retired-surface-check.mjs`, which is unchanged.
 */
const progressPathKey = /^ {2}\/api\/progress:/m;
if (progressPathKey.test(text)) {
  fail('S-absent /api/progress', 'the spec still declares a path for a route that is deleted: remove it, and let retired-surface-check guard its absence');
} else {
  pass('S-absent /api/progress', 'no path key declared, because the route no longer exists');
}
if (/^[ \t]*#.*\/api\/progress.*REMOVED/m.test(text)) {
  pass('S-recorded /api/progress removal', 'the spec records WHY the route is absent, which a bare deletion would lose');
} else {
  fail('S-recorded /api/progress removal', 'the spec no longer records that this route was removed and when; that record is how the next reader avoids re-adding it');
}

const failed = results.filter((r) => r === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed\n`);
process.exit(failed ? 1 : 0);
