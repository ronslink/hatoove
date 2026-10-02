/**
 * Sign-up throttle: ENFORCED inside a persistent world, NOT ACCUMULATED across worlds.
 *
 * `owned-api-check --backend=postgres-persistent` builds one world per leg on a schema that is never dropped.
 * The product counts every registration in ONE global bucket (`signup:global`), so before the per-world reset
 * the later legs inherited the earlier legs' registrations and failed at synthetic sign-up with 429
 * (CI runs 36977973026 / 36977973108 at 2711900). The fix resets that one bucket when a persistent world is
 * built. A reset like that is only acceptable if it provably does not switch the protection off, so this
 * check proves three things on the SAME persistent schema, through the SAME `persistentWorld()` the suite uses:
 *
 *   1. ENFORCED: a world answers `429 too_many_requests` (with Retry-After) once its budget is spent;
 *   2. ISOLATED: the next world starts its own budget and can register;
 *   3. DISCRIMINATION: a world built WITHOUT the reset inherits the exhaustion and refuses — so (2) passing is
 *      the reset working, not a throttle that stopped counting.
 *
 * A small injected signup limit keeps the run fast; the shipped policy object is asserted unchanged. The
 * bucket is cleared on exit so later steps on the same database do not inherit this check's exhaustion.
 *
 * Needs `server/owned-postgres` installed and a DISPOSABLE database with OWNAPI_PG_ALLOW=1 (same env as
 * `postgres-provision-check`). Synthetic addresses only; no provider, no .env.
 *
 * Usage: node tools/owned-api-throttle-isolation-check.mjs   (exit 0 when every check passes)
 */

import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

import { persistentWorld, SIGNUP_THROTTLE_KEY } from './owned-api-check.mjs';
import { THROTTLE_POLICY } from '../server/owned-postgres/throttle.mjs';

const SMALL_LIMIT = 2;
const LIMITS = Object.freeze({ ...THROTTLE_POLICY, signup: Object.freeze({ limit: SMALL_LIMIT, windowSeconds: 3600 }) });
const RUN_ID = `${process.pid.toString(36)}${Date.now().toString(36)}`;
let counter = 0;

async function signUp(api) {
  const n = ++counter;
  const response = await api.handle({
    method: 'POST',
    path: '/api/auth/sign-up/email',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify({ name: `Throttle ${n}`, email: `throttle-${RUN_ID}-${n}@example.invalid`, password: `pw-throttle-${n}-synthetic` }),
    originChecked: true,
  });
  return { status: response.status, headers: response.headers, json: JSON.parse(response.body) };
}

async function withWorld(options, run) {
  const pg = await persistentWorld({ limits: LIMITS, ...options });
  try { return await run(pg); } finally { await pg.teardown(); }
}

async function spend(api, label) {
  for (let i = 1; i <= SMALL_LIMIT; i += 1) {
    const ok = await signUp(api);
    assert.equal(ok.status, 200, `${label}: registration ${i} of ${SMALL_LIMIT} is inside the budget (got ${ok.status} ${JSON.stringify(ok.json)})`);
  }
}

async function assertRefused(api, label) {
  const refused = await signUp(api);
  assert.equal(refused.status, 429, `${label}: expected 429, got ${refused.status} ${JSON.stringify(refused.json)}`);
  assert.deepEqual(refused.json, { error: 'too_many_requests' });
  const retryAfter = Number(refused.headers['retry-after']);
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `${label}: a refusal names a time (Retry-After=${refused.headers['retry-after']})`);
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

check('shipped-signup-policy-is-unchanged-and-wired', async () => {
  // The suite's ordinary persistent world runs the SHIPPED policy, not the small test one.
  const pg = await persistentWorld();
  try {
    assert.equal(pg.api.throttled, true, 'the throttle is wired');
    assert.equal(pg.throttle.policy, THROTTLE_POLICY, 'the ordinary persistent world uses the shipped policy object');
  } finally { await pg.teardown(); }
});

check('signup-throttle-still-refuses-inside-one-persistent-world', async () => {
  await withWorld({}, async (pg) => {
    await spend(pg.api, 'world A');
    await assertRefused(pg.api, 'world A past its budget');
  });
});

check('next-persistent-world-starts-its-own-signup-budget', async () => {
  // World A above left the global bucket exhausted on this persistent schema.
  await withWorld({}, async (pg) => {
    await spend(pg.api, 'world B (reset)');
    await assertRefused(pg.api, 'world B past its own budget');
  });
});

check('discrimination-without-the-reset-the-exhaustion-is-inherited', async () => {
  // World B left the bucket exhausted. Without the reset, the SAME construction refuses the first sign-up:
  // that is the CI failure, and the reason the previous leg passing means something.
  await withWorld({ isolateSignupBudget: false }, async (pg) => {
    await assertRefused(pg.api, 'world C (no reset) on an inherited budget');
  });
});

export const REQUIRED_CHECKS = checks.map((c) => c.name);

export async function runThrottleIsolationChecks() {
  const results = [];
  try {
    for (const { name, run } of checks) {
      try {
        await run();
        results.push({ name, ok: true, detail: 'ok' });
      } catch (error) {
        results.push({ name, ok: false, detail: error && error.message ? error.message.split('\n')[0] : String(error), error });
      }
    }
  } finally {
    // Leave no exhausted bucket behind for later steps on the same database.
    const pg = await persistentWorld({ isolateSignupBudget: false });
    try { await pg.throttle.clear('signup', SIGNUP_THROTTLE_KEY); } finally { await pg.teardown(); }
  }
  return { ok: results.every((r) => r.ok), results };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const report = await runThrottleIsolationChecks();
  for (const r of report.results) {
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${r.ok ? '' : `\n  ${r.detail}`}`);
    if (!r.ok && r.error && r.error.stack) console.log(r.error.stack.split('\n').slice(1, 5).join('\n'));
  }
  const failed = report.results.filter((r) => !r.ok).length;
  console.log(`\n${report.results.length - failed} passed, ${failed} failed`);
  console.log('NOTE fixture isolation of the global sign-up counter on a disposable persistent schema; not a human security review.');
  process.exitCode = failed ? 1 : 0;
}
