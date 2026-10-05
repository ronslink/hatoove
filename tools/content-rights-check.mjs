/*
 * CONTENT RIGHTS — D1, implemented: an append-only decision record, and a gate that consults it.
 *
 * Ron, 2 October 2026: the content is AI-generated. `work/implementation/CONTENT-RIGHTS-D1.md` records what the
 * tree can establish about each of the four sources, and the rule it follows is the repository's own
 * (`docs/content/DISCOVERY.md:121`): a declared `source` string is a self-description by the corpus, not proof
 * of provenance. So the basis recorded for these rows is `generated`.
 *
 * WHY A SEPARATE TABLE RATHER THAN A FLIPPED COLUMN. `content_version` is immutable — a BEFORE UPDATE OR
 * DELETE trigger refuses every change — and that immutability is not an obstacle to work around, it is the
 * property that makes an attempt's recorded content meaningful. The seed-time value (`unknown`) was TRUE when
 * those rows were written: nobody had asked. The decision came later. Recording it as a separate, append-only
 * row keeps both facts, says WHO decided and WHEN, and leaves the original row intact — which is exactly what
 * an audit trail is for, and what a silent UPDATE would have destroyed.
 *
 * AND THE GATE IS THE POINT. `rights_status` used to be carried but not filtered on, because D1 was open and
 * filtering would have served nothing while looking like a broken route. Now it filters: a rights basis the
 * deployment allows is served, anything else fails closed.
 *
 * Usage:
 *   node tools/content-rights-check.mjs          (needs a disposable DB; OWNAPI_PG_*)
 *   node tools/content-rights-check.mjs --list
 */

import assert from 'node:assert/strict';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';

// EXAM-S0: the seeded rows are `unreviewed` and the RIGHTS gate is what is under test here, so this standalone
// check opts into the `internal-preview` review policy explicitly. The `public` default is covered by
// tools/exam-s0-server-check.mjs and tools/exam-s0-server-pg-check.mjs.
process.env.B1PREP_CONTENT_MODE = 'internal-preview';
const db = await createFixture();
const world = await createPostgresWorld({ fixture: db });
const call = async (method, path, { cookie = null, body = undefined } = {}) => {
  const headers = { accept: 'application/json' };
  if (cookie) headers.cookie = cookie;
  if (method !== 'GET') headers['content-type'] = 'application/json';
  const response = await world.api.handle({
    method, path, headers, originChecked: true,
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  let json = null;
  try { json = JSON.parse(response.body); } catch { /* not JSON */ }
  return { status: response.status, json, text: response.body };
};
const one = async (sql, params) => (await db.admin.query(sql, params)).rows[0];
const all = async (sql, params) => (await db.admin.query(sql, params)).rows;

const legs = [];
const check = (name, fn) => legs.push({ name, fn });
const failures = [];
let passed = 0;
/** Legs whose behaviour does not exist yet: reported, named, and NOT counted as passes. */
let pending = 0;

/** One signed-in learner, for the catalogue reads. */
async function learner() {
  await db.admin.query('DELETE FROM auth_throttle WHERE bucket = $1', ['signup:global']);
  const email = `rights-${Date.now()}-${Math.random().toString(16).slice(2, 8)}@example.invalid`;
  const created = await call('POST', '/api/auth/sign-up/email', { body: { name: 'Rights', email, password: 'pw-rights-synthetic' } });
  assert.equal(created.status, 200, `sign-up: ${created.text.slice(0, 120)}`);
  const raw = created.text;
  const cookie = (await world.api.handle({ method: 'POST', path: '/api/auth/sign-in/email', headers: { 'content-type': 'application/json' }, originChecked: true, body: JSON.stringify({ email, password: 'pw-rights-synthetic' }) })).headers['set-cookie'];
  const sessionCookie = String(cookie).split(';')[0];
  const preparations = await call('GET', '/api/v1/preparations', { cookie: sessionCookie });
  assert.equal(preparations.status, 200);
  const preparation = preparations.json.preparations.find(row => row.exam_id === 'telc-deutsch-b1');
  assert.ok(preparation, 'synthetic learner has a telc preparation');
  return { email, cookie: sessionCookie, raw, preparationId: preparation.id };
}

/*
 * 1. NO CONTENT WITHOUT A RECORDED BASIS.
 *
 * The invariant that keeps the gate honest: every content row the catalogue can serve has a decision attached.
 * A row without one would fall through to its seed-time value, which is `unknown` — i.e. the gate would refuse
 * it — and a learner would see a missing set with nothing anywhere saying why.
 */
check('1. every content row carries a recorded rights basis', async () => {
  const unrecorded = await all(
    `SELECT c.content_version_id FROM content_version c
      LEFT JOIN content_rights r ON r.content_version_id = c.content_version_id
      WHERE r.content_version_id IS NULL`);
  const total = Number((await one('SELECT count(*)::int AS n FROM content_version')).n);
  assert.deepEqual(unrecorded.map((row) => row.content_version_id), [],
    'these content rows have no rights decision recorded');
  assert.ok(total > 0, 'the catalogue must actually hold content for this to mean anything');
  return `${total} content row(s), every one with a recorded basis`;
});

/*
 * 2. THE RECORD IS AUDITABLE: who decided, when, and on what basis.
 */
check('2. the decision records who decided, when, and why', async () => {
  const row = await one('SELECT basis, decided_by, decided_at, note FROM content_rights ORDER BY content_version_id LIMIT 1');
  assert.ok(row, 'at least one decision exists');
  assert.equal(row.basis, 'generated', `the basis Ron gave: ${row.basis}`);
  assert.ok(row.decided_by && row.decided_by.length > 2, `decided_by must name who: ${row.decided_by}`);
  assert.ok(row.decided_at instanceof Date, 'decided_at must be a timestamp');
  assert.ok(row.note && row.note.length > 20, `the note must say enough to audit: ${row.note}`);
  const bases = await all('SELECT DISTINCT basis FROM content_rights');
  return `${bases.map((b) => b.basis).join('/')} by ${row.decided_by} on ${row.decided_at.toISOString().slice(0, 10)}`;
});

/*
 * 3. THE LEARNER SEES THE BASIS, not the seed-time placeholder.
 */
check('3. the served catalogue reports the recorded basis, not "unknown"', async () => {
  const who = await learner();
  /*
   * THE CATALOGUE ROUTES RETURN BARE ARRAYS, which the first version of this leg got wrong: it read
   * `json.sets` / `json.tasks` and therefore found NOTHING on either route, and reported "the catalogue served
   * something" as if the product had emptied itself. A probe of the real shapes (15 sets, 6 tasks, 50 vocab)
   * showed the read path was working and the CHECK was wrong — the same lesson as the dark-mode sweep, and the
   * reason to probe rather than act on a red leg.
   */
  const shapes = [];
  for (const path of ['/api/v1/objective-sets', '/api/v1/tasks', '/api/v1/vocab']) {
    const res = await call('GET', path + '?preparationId=' + who.preparationId, { cookie: who.cookie });
    assert.equal(res.status, 200, `${path}: ${res.text.slice(0, 120)}`);
    assert.ok(Array.isArray(res.json), `${path} is expected to answer a bare array; got ${typeof res.json}`);
    const wrong = res.json.filter((row) => row.rights_status !== 'generated');
    assert.deepEqual(wrong.map((row) => row.set_id || row.task_id || row.entry_id || row.rights_status), [],
      `${path}: every served row must report the recorded basis`);
    shapes.push(`${path.split('/').pop()}[${res.json.length}]`);
  }
  return `${shapes.join(' ')} — all reporting rights_status=generated`;
});

/*
 * 4. THE DECISION CANNOT BE REWRITTEN — the same rule the content rows live under.
 */
check('4. a decision record cannot be updated or deleted', async () => {
  const before = await one('SELECT content_version_id, basis FROM content_rights ORDER BY content_version_id LIMIT 1');
  let refused = 0;
  for (const sql of ['UPDATE content_rights SET basis = \'licensed\' WHERE content_version_id = $1',
    'DELETE FROM content_rights WHERE content_version_id = $1']) {
    try {
      await db.admin.query(sql, [before.content_version_id]);
    } catch (error) {
      refused += 1;
      assert.match(String(error.message), /immutable/, `the refusal must say why: ${error.message.slice(0, 80)}`);
    }
  }
  assert.equal(refused, 2, 'both an UPDATE and a DELETE must be refused');
  const after = await one('SELECT basis FROM content_rights WHERE content_version_id = $1', [before.content_version_id]);
  assert.equal(after.basis, 'generated', 'and the row is unchanged');
  return 'UPDATE and DELETE both refused with the immutability message; the row is intact';
});

/*
 * 5. FAIL CLOSED — the leg that makes the gate worth having.
 *
 * A content row whose basis the deployment has not accepted must NOT be served, while an otherwise identical
 * one whose basis is `generated` must be. Four rows are inserted, identical except for the rights decision:
 * generated, licensed, unknown, and one with NO decision at all. This is the difference between carrying a
 * field and enforcing it.
 *
 * WHY THE ROWS ARE SHAPED THE WAY THEY ARE — the first version of this leg was VACUOUS, and this is the
 * measurement that showed it rather than a reading of the leg's name:
 *
 *   It inserted `kind='objective'` and `content_sha256='probe'`. `resolve_review_subject`
 *   (server/migrations/0035-content-review.sql:67) resolves a content subject only for the kinds it knows —
 *   task, rubric, guide, lexicon, media; there is no `objective` branch, so `ok` stays false — and :84
 *   RETURNS unless `content_sha256 ~ '^[0-9a-f]{64}$'`. Every synthetic row therefore projected
 *   `review_status='unavailable', blocked=true`: the row was refused by the REVIEW projection before the
 *   rights filter was ever consulted. The control assert failed, and the three negative asserts
 *   ("Probe unknown/licensed/missing" are absent) passed for the wrong reason — nothing synthetic was served
 *   at all. A rights regression would have been invisible: had `rights_blocked` stopped being returned for
 *   `unknown`, or had the query stopped filtering on rights, this leg would still have printed PASS.
 *
 *   Two small shapes make the fixture real, and the anti-vacuity guard below asserts both the projection and
 *   the decision for every probe row. That guard is the point: if a row stops being review-servable, the leg
 *   fails BY NAME instead of the negatives quietly passing by accident again.
 *
 * NO RELEASE/FORM FIXTURE IS NEEDED, which the same measurement corrected. `listObjectiveSets`
 * (server/owned-postgres/adapter.mjs:431) reads `objective_set` directly, and `importedSetGate`
 * (packages.mjs:20) admits a set with no `exam_form_member` row when its `source_path` is not under
 * `content/exams/`. Requiring a form membership is true of a different route (`readReleasedForm`, the
 * pinned-service path), not of this catalogue.
 *
 * The CONTROL is both a real seeded set that serves today and the synthetic `generated` row, so the leg
 * proves the catalogue works rather than only that it refuses.
 */
check('5. content with no rights basis is refused while generated content is served', async () => {
  const suffix = `rights-probe-${Date.now()}`;
  /*
   * A REAL 64-hex digest, because 0035:84 refuses anything else. This is not decoration: with 'probe' here
   * the row never reaches the rights filter and the leg becomes vacuous.
   */
  const digest = 'c'.repeat(64);
  const probeNote = 'synthetic probe row for the fail-closed leg';

  /** The sets that already serve, captured BEFORE the probe rows exist — the real control. */
  const seeded = await all(
    `SELECT s.set_id, s.version FROM objective_set s
      JOIN content_version c USING(content_version_id)
      WHERE s.exam_id = 'telc-deutsch-b1' AND s.family = 'LV1' AND s.media_required = false`);
  assert.ok(seeded.length >= 2, `the seeded LV1 catalogue must serve something for this leg to have a control; got ${seeded.length}`);

  const makeRow = async (basis) => {
    const id = `${suffix}-${basis}`;
    /*
     * `kind='task'` is the branch that accepts a content row backed by an objective_set (0035:76-77). With
     * `kind='objective'` there is no branch at all, so the subject does not resolve.
     */
    await db.admin.query(
      `INSERT INTO content_version(content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
       VALUES($1, 'task', 'lv', 'probe', 'approved', 'unknown', $2, 'telc-deutsch-b1')`, [id, digest]);
    if (basis !== 'missing') await db.admin.query(
      `INSERT INTO content_rights(content_version_id, basis, decided_by, note) VALUES($1, $2, 'check', $3)`, [id, basis, probeNote]);
    /*
     * A VALID family and part, so the rows can be filtered for: an earlier version stored family `LV9`, which
     * the route's own `parseFamily` correctly refuses as a spelling that does not exist — and the leg then read
     * its own 422 as a product failure. LV1 with part 1 is a real, servable shape.
     */
    await db.admin.query(
      `INSERT INTO objective_set(set_id, version, exam_id, family, section, part, title, payload, item_count, media_required, content_version_id)
       VALUES($1, 'v1', 'telc-deutsch-b1', 'LV1', 'LV', 1, $2, '[]'::jsonb, 0, false, $3)`,
      [`${suffix}.${basis}`, `Probe ${basis}`, id]);
    return id;
  };
  /** The basis the route must report for each probe row: `missing` falls back to the seed-time column. */
  const expectedBasis = { generated: 'generated', licensed: 'licensed', unknown: 'unknown', missing: 'unknown' };
  const ids = {};
  const setIdFor = (basis) => `${suffix}.${basis}`;
  for (const basis of Object.keys(expectedBasis)) ids[basis] = await makeRow(basis);

  /*
   * THE ANTI-VACUITY GUARD. Every probe row must be review-servable and must carry the basis under test.
   * Without this, a row that never reaches the rights filter makes the three negative asserts below pass for
   * the wrong reason — which is exactly the defect this leg is being repaired for.
   */
  for (const [basis, id] of Object.entries(ids)) {
    const shape = await one(
      `SELECT c.content_version_id, e.review_status, e.blocked, COALESCE(cr.basis, c.rights_status) AS served_rights
         FROM content_version c
         CROSS JOIN LATERAL effective_content_review(c.content_version_id) e
         LEFT JOIN content_rights cr USING(content_version_id)
        WHERE c.content_version_id = $1`, [id]);
    assert.ok(shape, `the ${basis} probe row must resolve a review subject at all (a non-hex digest or an unknown kind returns nothing here)`);
    assert.equal(shape.blocked, false, `the ${basis} probe row must be review-servable, or the rights assertions below would be vacuous`);
    assert.ok(['approved', 'unreviewed'].includes(shape.review_status),
      `the ${basis} probe row must carry a review status this deployment serves; got ${shape.review_status}`);
    assert.equal(shape.served_rights, expectedBasis[basis], `the ${basis} probe row must carry the basis under test`);
  }

  const who = await learner();
  const listed = await call('GET', '/api/v1/objective-sets?family=LV1&preparationId=' + who.preparationId, { cookie: who.cookie });
  assert.equal(listed.status, 200, listed.text.slice(0, 120));
  const served = listed.json || [];
  const titles = served.map((set) => set.title);
  const servedIds = new Set(served.map((set) => `${set.set_id}@${set.version}`));

  // The control, twice over: the catalogue still serves what it served, and the accepted probe row is served.
  for (const row of seeded) {
    assert.ok(servedIds.has(`${row.set_id}@${row.version}`),
      `the seeded control set ${row.set_id} must still be served; got ${JSON.stringify([...servedIds])}`);
  }
  assert.ok(titles.includes('Probe generated'), `accepted content must be served; got ${JSON.stringify(titles)}`);
  assert.equal(servedIds.has(`${setIdFor('generated')}@v1`), true, 'the accepted probe row must be in the served catalogue');

  // And the negatives, now that the rows are demonstrably reachable by the rights filter.
  assert.ok(!titles.includes('Probe unknown'), 'unaccepted content must be excluded from the catalogue');
  assert.ok(!titles.includes('Probe missing'), 'a missing rights decision must fail closed');
  assert.ok(!titles.includes('Probe licensed'), 'an unconfigured basis must fail closed');
  const leaked = served.filter((row) => row.rights_status !== 'generated');
  assert.deepEqual(leaked.map((row) => [row.set_id, row.rights_status]), [],
    'no served row may report a basis the deployment has not accepted');

  const refused = await call('GET', `/api/v1/objective-sets/${setIdFor('unknown')}?version=v1&preparationId=${who.preparationId}`, { cookie: who.cookie });
  assert.equal(refused.status, 404, 'a direct content URL must not bypass the rights gate');
  const accepted = await call('GET', `/api/v1/objective-sets/${setIdFor('generated')}?version=v1&preparationId=${who.preparationId}`, { cookie: who.cookie });
  assert.equal(accepted.status, 200, 'the generated control must remain readable');
  const marking = await call('POST', `/api/v1/objective-sets/${setIdFor('unknown')}/answers`, {
    cookie: who.cookie, body: { preparationId: who.preparationId, version: 'v1', itemId: '1', answer: 'a' },
  });
  assert.equal(marking.status, 404, 'marking must reject a withheld set before looking up its key');

  const previous = process.env.B1PREP_SERVE_RIGHTS;
  try {
    process.env.B1PREP_SERVE_RIGHTS = 'generated,licensed,unknown';
    const widened = await call('GET', '/api/v1/objective-sets?family=LV1&preparationId=' + who.preparationId, { cookie: who.cookie });
    assert.equal(widened.status, 200);
    const allowed = widened.json.map((row) => row.title);
    assert.ok(allowed.includes('Probe generated') && allowed.includes('Probe licensed'),
      'an operator may widen to another KNOWN basis');
    assert.ok(!allowed.includes('Probe unknown') && !allowed.includes('Probe missing'),
      'deployment configuration cannot turn unknown or absent provenance into accepted content');
  } finally {
    if (previous === undefined) delete process.env.B1PREP_SERVE_RIGHTS;
    else process.env.B1PREP_SERVE_RIGHTS = previous;
  }
  return `${served.length} served (${seeded.length} seeded + 1 probe); "Probe unknown"/"missing"/"licensed" absent while all four probe rows review as servable`;
});

/*
 * 6. AND THE SEED-TIME FACT IS PRESERVED, which is why the table exists rather than a column flip.
 */
check('6. the content rows still carry what was true when they were written', async () => {
  /*
   * Scoped to the SEEDED rows: leg 5's probe rows are `kind='task'` too and sort before these, and this leg's
   * claim is about the seed-time fact of real content, not about a synthetic fixture.
   */
  const row = await one(`SELECT c.rights_status, r.basis FROM content_version c
    JOIN content_rights r ON r.content_version_id = c.content_version_id
    WHERE c.kind = 'task' AND c.content_version_id NOT LIKE 'rights-probe-%'
    ORDER BY c.content_version_id LIMIT 1`);
  assert.equal(row.rights_status, 'unknown', 'the row itself must NOT have been rewritten — immutability held');
  assert.equal(row.basis, 'generated', 'while the decision records what is now known');
  return `row says "${row.rights_status}" (true at seed time), decision says "${row.basis}"`;
});

async function run() {
  if (process.argv.includes('--list')) {
    for (const leg of legs) console.log(leg.name);
    return 0;
  }
  const only = process.argv.find((a) => a.startsWith('--only='));
  for (const leg of legs) {
    if (only && !leg.name.toLowerCase().includes(only.split('=')[1].toLowerCase())) continue;
    try {
      /*
       * COUNTED AFTER THE LEG RUNS. The first version incremented before `leg.fn()`, so the summary read
       * "6 passed, 6 failed" while every leg had failed — a lying summary in the very check that exists to keep
       * claims honest. `passed` now moves only on success.
       */
      const detail = await leg.fn();
      if (detail && detail.pending) {
        // PENDING legs name the slice that will make them real and do NOT count as passes.
        pending += 1;
        console.log(`PENDING ${detail.pending}  ${leg.name} — ${detail.why}`);
        continue;
      }
      passed += 1;
      console.log(`PASS ${leg.name}${detail ? `  [${detail}]` : ''}`);
    } catch (error) {
      failures.push(leg.name);
      console.log(`FAIL ${leg.name}`);
      console.log(`     ${String(error.message).split('\n')[0]}`);
    }
  }
  console.log(`\n${passed} passed, ${pending} pending, ${failures.length} failed`);
  return failures.length ? 1 : 0;
}

let code = 1;
try {
  code = await run();
} finally {
  await db.cleanup().catch(() => {});
}
process.exitCode = code;
