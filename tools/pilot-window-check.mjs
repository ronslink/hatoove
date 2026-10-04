#!/usr/bin/env node
/**
 * The pilot free window is a configured date, not prose (PILOT-WINDOW-01).
 *
 * `tools/seo-check.mjs` leg S10 holds the PAGE to the configuration: the configured `PILOT_FREE_UNTIL`
 * must be the date the visible FAQ and the JSON-LD answer state. That leg would stay green on a
 * runtime accessor that reads nothing, so this check covers the other half — the accessor itself.
 *
 * THREE PROPERTIES, each of which was a decision rather than an accident:
 *
 *   1. A MISSING OR MALFORMED VALUE NEVER THROWS. The date is configuration; a typo in an operator's
 *      environment must not be able to stop the server booting. This is the documented fallback:
 *      `{ freeUntil: null, valid: false, reason }`.
 *   2. THE FALLBACK IS NOT A HARD-CODED DATE. A silent default would let a typo quietly restore or
 *      shift a commercial promise. `freeUntil` is null when the value is not a real calendar day, and
 *      the reason names why, so a consumer decides explicitly and cannot inherit a guess.
 *   3. IMPOSSIBLE DAYS ARE REFUSED, NOT NORMALISED. `2027-02-30` and `2027-13-01` are well-shaped and
 *      false; JavaScript's `Date` rolls both over silently, which is exactly how a "January 2027"
 *      window becomes a March one.
 *
 * The accessor is imported from `server.js` itself. Importing that module does NOT start a server —
 * `node server.js` does, and only when the module is the entry point — so this runs offline with no
 * port, no database, no provider and no `.env` of its own beyond the module's existing read.
 *
 * Usage: node tools/pilot-window-check.mjs
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPilotFreeUntil } from '../server.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const results = [];
const record = (id, ok, detail) => {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${id} ${detail}`);
};

/* P1 — the configured production value parses, and it is the value the page is held to. */
{
  const compose = fs.readFileSync(path.join(ROOT, 'compose.production.yaml'), 'utf8');
  const declared = (compose.match(/^\s*PILOT_FREE_UNTIL:\s*"?([^"#\r\n]*)"?\s*$/m) || [])[1]?.trim();
  const read = readPilotFreeUntil({ PILOT_FREE_UNTIL: declared });
  if (declared === undefined) record('P1', false, 'compose.production.yaml declares no PILOT_FREE_UNTIL');
  else if (!read.valid || read.freeUntil !== declared) record('P1', false, `readPilotFreeUntil(${JSON.stringify(declared)}) returned ${JSON.stringify(read)}`);
  else record('P1', true, `compose.production.yaml PILOT_FREE_UNTIL ${declared} parses via server.js#readPilotFreeUntil()`);
}

/* P2 — every malformed shape falls back without throwing, and the reason names the shape. */
{
  const cases = [
    [undefined, 'not_configured'],
    ['', 'not_configured'],
    ['   ', 'not_configured'],
    [null, 'not_configured'],
    ['14.01.2027', 'malformed'],
    ['2027-1-14', 'malformed'],
    ['2027/01/14', 'malformed'],
    ['2027-01-14T00:00:00Z', 'malformed'],
    ['2027-01-14; rm -rf /', 'malformed'],
    ['2027-02-30', 'impossible_date'],
    ['2027-13-01', 'impossible_date'],
    ['2027-00-10', 'impossible_date'],
    ['2027-04-31', 'impossible_date'],
    ['0000-01-01', 'impossible_date'],
  ];
  const problems = [];
  for (const [value, reason] of cases) {
    let read;
    try {
      read = readPilotFreeUntil({ PILOT_FREE_UNTIL: value });
    } catch (error) {
      problems.push(`${JSON.stringify(value)} threw ${error.message}`);
      continue;
    }
    if (read.freeUntil !== null || read.valid !== false || read.reason !== reason) {
      problems.push(`${JSON.stringify(value)} -> ${JSON.stringify(read)}, expected {freeUntil:null,valid:false,reason:"${reason}"}`);
    }
  }
  // The default argument reads the real environment and must survive an empty one too.
  try {
    readPilotFreeUntil({});
  } catch (error) {
    problems.push(`an empty environment threw ${error.message}`);
  }
  if (problems.length) record('P2', false, problems.join(' | '));
  else record('P2', true, `${cases.length} malformed/absent shape(s) fall back to null without throwing`);
}

/* P3 — a real calendar day parses, including a leap day, and the refusal boundary is exact:
 * 2028-02-29 is a day; 2027-02-29 (not a leap year) is not. */
{
  const good = ['2027-01-14', '2027-12-31', '2028-02-29', '2026-10-04'];
  const bad = ['2027-02-29', '2027-04-31', '2027-06-31', '2027-11-31'];
  const problems = [];
  for (const value of good) {
    const read = readPilotFreeUntil({ PILOT_FREE_UNTIL: value });
    if (!read.valid || read.freeUntil !== value || read.reason !== null) problems.push(`${value} -> ${JSON.stringify(read)}, expected valid`);
  }
  for (const value of bad) {
    const read = readPilotFreeUntil({ PILOT_FREE_UNTIL: value });
    if (read.valid || read.reason !== 'impossible_date') problems.push(`${value} -> ${JSON.stringify(read)}, expected impossible_date`);
  }
  if (problems.length) record('P3', false, problems.join(' | '));
  else record('P3', true, `${good.length} real day(s) accepted, ${bad.length} impossible day(s) refused (leap-year boundary exact)`);
}

const failed = results.filter((row) => !row.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? ` — FAILED: ${failed.map((row) => row.id).join(', ')}` : ''}\n`);
process.exitCode = failed.length ? 1 : 0;
