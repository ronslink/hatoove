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
    /* PILOT-FEEDBACK-01 (FB-B): the four routes driven through the API. */
    gate('pilot-feedback-api-check'),
    /* PILOT-FEEDBACK-01 (FB-D): the operator surface. It proves privilege FACTS a reader cannot see — that the
       operator holds no table privilege, that its update is bounded to three columns, and that the identity
       trigger still refuses a text rewrite even by the owner. It also guards the schema-USAGE grant whose
       absence is invisible in a grant list and makes every operator call fail. */
    gate('pilot-feedback-operator-check'),
  ],
  /* The AGENTS.md offline baseline. */
  baseline: [
    gate('repository-check'), gate('design-check'), gate('retired-surface-check'), gate('seo-check'),
    gate('server-origin-check'), gate('keymask-check'), gate('owned-api-check'), gate('owned-client-check'),
    gate('i18n-register-check'),
    /* PILOT-FEEDBACK-01 (FB-E): every vendored browser asset is pinned to its digest and ships its licence. The
       app makes no third-party request at runtime, and that promise holds only while the vendored files are the
       ones that were reviewed — a change in `public/assets/vendor/` is served to every learner and nothing else
       in this repository would notice it. */
    gate('vendor-integrity-check'),
    /* PILOT-FEEDBACK-01 (FB-D): the operator CSV carries learner text into a spreadsheet. A cell beginning `=` is
       a FORMULA to Excel/Sheets, so a report could execute in the operator's spreadsheet — a privilege boundary
       crossed by data. Offline and pure, so it costs nothing to run on every change. */
    gate('pilot-feedback-csv-check'),
    /* PILOT-FEEDBACK-01 (FB-C): offline and structural. It proves the entry point cannot appear before sign-in,
       that the sheet has no way to navigate or reach the listening controller, that the learner's own text is
       escaped, and that the stylesheet stays RTL-safe. It deliberately does NOT claim the rendered behaviour -
       focus, Escape and audio-while-open need a browser, and that residual is recorded rather than implied. */
    gate('pilot-feedback-client-check'),
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
