/**
 * Tests for tools/keymask-check.mjs (SEC-04 fix for finding F-7).
 *
 * Two things are proven here:
 *   1. the probe passes on this tree, check by check, with the key live; and
 *   2. the probe is not vacuous - the SAME probe run against the pre-fix `server.js`
 *      (`git show 8a71f718ee534851a98d19eece07dab933b56479:server.js`) must fail every leak
 *      check while reporting `configured: true`. A probe that passes on both trees would
 *      prove nothing.
 *
 * If the pre-fix blob is not in this checkout (e.g. a shallow import), the discrimination
 * test falls back to a synthetic legacy stand-in that reproduces only the old response
 * shape, and this file reports which source it used. The authoritative evidence is a
 * `--prefix-commit` run on a checkout that has the commit.
 *
 * Run: node --test tools/keymask-check.test.mjs
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  DEFAULT_ROOT,
  LEAK_CHECKS,
  PREFIX_COMMIT,
  REQUIRED_CHECKS,
  judgeDiscrimination,
  materializePreFixServer,
  runKeyMaskChecks,
  writeLegacyStandIn,
} from './keymask-check.mjs';

/* ------------------------------------------------------- this tree, check by check */

const report = await runKeyMaskChecks();
const byName = new Map(report.results.map((r) => [r.name, r]));

for (const name of REQUIRED_CHECKS) {
  test(`key-mask: ${name}`, () => {
    const result = byName.get(name);
    assert.ok(result, `check "${name}" did not run`);
    assert.ok(result.ok, `${name}: ${result.detail}`);
  });
}

test('every key-mask check passed on this tree', () => {
  const failed = report.results.filter((r) => !r.ok);
  assert.deepEqual(failed.map((f) => `${f.name}: ${f.detail}`), [], 'the probe must pass end to end');
  assert.ok(report.ok);
  assert.equal(report.results.length, REQUIRED_CHECKS.length);
});

test('the suite never uses the repository .env', () => {
  const tmpRoot = path.resolve(os.tmpdir());
  assert.ok(
    path.resolve(report.envPath).startsWith(tmpRoot + path.sep),
    `suite env file must live under the temp directory, got ${report.envPath}`
  );
  assert.notEqual(path.resolve(report.envPath), path.join(DEFAULT_ROOT, '.env'));
  assert.notEqual(path.resolve(report.progressPath), path.join(DEFAULT_ROOT, 'progress.json'));
});

/* --------------------------------------------------------- the probe discriminates */

const prefixDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b1prep-keymask-test-'));
after(() => fs.rmSync(prefixDir, { recursive: true, force: true }));

let prefixSource;
let prefixLoadError = null;
try {
  prefixSource = materializePreFixServer(prefixDir, { commit: PREFIX_COMMIT });
} catch (err) {
  prefixLoadError = err;
  prefixSource = writeLegacyStandIn(prefixDir);
}

const prefixReport = await runKeyMaskChecks({ serverPath: prefixSource.file, label: 'pre-fix' });

test('the pre-fix server.js is caught by every leak check', () => {
  const verdict = judgeDiscrimination(prefixReport);
  assert.ok(verdict.ok, verdict.message);
  assert.deepEqual(
    [...verdict.failedLeakChecks].sort(),
    [...LEAK_CHECKS].sort(),
    'every leak check must fail on a source that still discloses key characters'
  );
});

test('the pre-fix failures name the disclosed characters, not a broken run', () => {
  const leakFailures = prefixReport.results.filter((r) => LEAK_CHECKS.includes(r.name));
  assert.equal(leakFailures.length, LEAK_CHECKS.length, 'every leak check must have run');
  for (const failure of leakFailures) {
    assert.equal(failure.ok, false, `${failure.name} must fail on the pre-fix source`);
    assert.match(failure.detail, /disclosed|key characters/, `${failure.name}: ${failure.detail}`);
  }
  // The same source must still report a live key, or the failures would be meaningless.
  const live = prefixReport.results.find((r) => r.name === 'configured-true-with-key');
  assert.ok(live?.ok, `configured-true-with-key must pass on the pre-fix source: ${live?.detail}`);
});

test('the discrimination source is stated, not assumed', (t) => {
  t.diagnostic(
    prefixLoadError
      ? `pre-fix blob unavailable (${prefixLoadError.message.split('\n')[0]}); used ${prefixSource.source}`
      : `pre-fix source: ${prefixSource.source}`
  );
  if (prefixLoadError) assert.match(prefixSource.source, /stand-in/);
  else {
    assert.equal(prefixSource.preFix, true);
    assert.ok(!fs.existsSync(path.join(DEFAULT_ROOT, 'server.js.tmp')), 'no leftover temp server in the checkout');
  }
});

/* ------------------------------------------------------- the change, at source level */

test('server.js exposes no key-derived field', () => {
  const source = fs.readFileSync(path.join(DEFAULT_ROOT, 'server.js'), 'utf8');
  assert.ok(!/function maskKey/.test(source), 'maskKey must be gone, not merely unused');
  const codeLines = source
    .split('\n')
    .filter((line) => /keyMasked/.test(line))
    .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line));
  assert.deepEqual(codeLines, [], 'keyMasked may only survive in the explanatory comment');
});

test('the Settings pill still shows the status without key characters', () => {
  const ui = fs.readFileSync(path.join(DEFAULT_ROOT, 'public/js/ui.js'), 'utf8');
  const lines = ui.split('\n');
  const pillIndex = lines.findIndex((line) => line.includes('class="pill') && line.includes('cfg.configured'));
  assert.ok(pillIndex !== -1, 'the Settings status pill must still exist');
  const pill = lines[pillIndex];
  const row = lines.slice(pillIndex, pillIndex + 3).join('\n');
  assert.ok(!/keyMasked/.test(row), `the pill row must not render keyMasked: ${pill.trim()}`);
  assert.match(pill, /Schlüssel gespeichert/, 'the pill must still say whether a key is configured');
  assert.match(row, /Modell:/, 'the model stays visible in the same row');
  assert.ok(!/Verbunden · \$\{/.test(pill), 'the pill must not interpolate a key-derived value');
});
