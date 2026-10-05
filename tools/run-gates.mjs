/*
 * RUN-GATES — run a named group of gates so that ONE failing gate cannot hide the rest.
 *
 * Why this exists: the slice scripts originally chained with `&&`, and the reviewer found the merged-tree
 * database group red on its FIRST gate while the other three passed individually — a red gate silently
 * suppressed three green ones, the same failure shape as a guard that stops running while the summary still
 * says "passed". `&&` also stops at the first failure; `;` would let a later gate's exit code mask an
 * earlier one. So every command runs, every result is printed, and the process exits non-zero if any failed.
 *
 * Usage: node tools/run-gates.mjs <group>   (groups: mirror, mirror-db, baseline)
 */
import { spawnSync } from 'node:child_process';

const NODE = process.execPath;
const gate = (script, ...args) => ({ script, args });

const GROUPS = {
  /* The offline MIRROR-B1PREP-01 gates: fast, no database, no Docker. */
  mirror: [
    gate('nav-ia-check'), gate('mock-intro-check'), gate('part-index-check'),
    gate('practice-runner-check'), gate('practice-selection-check'), gate('drill-check'),
    gate('pool-01-check'),
    gate('library-render-check'), gate('vocab-check'), gate('library-i18n-check'),
    gate('media-mount-check'),
    gate('review-pack-check'),
    gate('content-corrections-check'),
    /* Offline and platform-sensitive by nature: this is the gate that fails when a file a check hashes
       is not pinned to a checkout form that is the same on Windows and on the ubuntu runner. Two
       Windows-only failures reached CI before it existed, so it belongs in the group both OSes run. */
    gate('eol-hash-check'),
  ],
  /* The database gates. Each needs OWNAPI_PG_* pointed at a disposable database. */
  'mirror-db': [
    gate('library-i18n-check', '--postgres'), gate('part-index-check', '--postgres'),
    gate('practice-selection-check', '--postgres'), gate('practice-media-check'),
    gate('drill-check', '--postgres'), gate('content-rights-check', '--postgres'),
    gate('pool-01-check', '--postgres'),
    /* PILOT-FEEDBACK-01 (FB-A): the owner fence, the update/delete refusals, the one-survey-per-round index
       and the screenshot-owner trigger are all NEGATIVE properties. Nothing else in this group observes them,
       so without this gate the whole slice could ship with the policies inverted and still be green. */
    gate('pilot-feedback-migration-check'),
  ],
  /* The AGENTS.md offline baseline. */
  baseline: [
    gate('repository-check'), gate('design-check'), gate('retired-surface-check'), gate('seo-check'),
    gate('server-origin-check'), gate('keymask-check'), gate('owned-api-check'), gate('owned-client-check'),
    gate('i18n-register-check'),
  ],
};

const group = process.argv[2];
if (!group || !GROUPS[group]) {
  console.error(`usage: node tools/run-gates.mjs <${Object.keys(GROUPS).join('|')}>`);
  process.exit(2);
}

const results = [];
for (const { script, args } of GROUPS[group]) {
  const label = `${script}${args.length ? ' ' + args.join(' ') : ''}`;
  process.stdout.write(`\n=== ${label} ===\n`);
  const started = Date.now();
  const run = spawnSync(NODE, [`tools/${script}.mjs`, ...args], { stdio: 'inherit' });
  const code = run.status === null ? 1 : run.status;
  results.push({ label, code, ms: Date.now() - started });
}

const failed = results.filter((row) => row.code !== 0);
console.log(`\n---- ${group}: ${results.length - failed.length}/${results.length} passed ----`);
for (const row of results) console.log(`  ${row.code === 0 ? 'PASS' : 'FAIL'}  ${row.label}  (${(row.ms / 1000).toFixed(1)}s)`);
if (failed.length) {
  console.log(`\n${failed.length} gate(s) failed: ${failed.map((row) => row.label).join(', ')}`);
  process.exit(1);
}
console.log('all gates passed');
