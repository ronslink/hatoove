/*
 * PILOT-FEEDBACK-01 (slice FB-B) — the four learner-facing routes, DRIVEN over the API against a real database.
 *
 * WHY THIS EXISTS SEPARATELY FROM `pilot-feedback-migration-check`. That check proves what the DATABASE enforces:
 * the owner fence, the refusals, the answer ranges, the one-row-per-round index. It never goes through a route.
 * Everything this slice actually added lives above the database — the closed request field set, the 422/409/429
 * mapping, the context-drop rule, the 204, and the survey gate — and none of it is observable from SQL. Without
 * this file the routes are written rather than demonstrated.
 *
 * THE THROTTLE LEG IS CHEAP ON PURPOSE. `persistentWorld({ limits })` injects a policy (fixture.mjs:44-45,71),
 * so the 429 is proved with a two-report budget instead of waiting out a day. That injection point is exactly
 * what amendment A9 got wrong when it demanded a change to `createOwnedApi`.
 *
 * Needs `server/owned-postgres` installed and a DISPOSABLE database with OWNAPI_PG_ALLOW=1. Synthetic accounts
 * only; no provider, no .env, never the learner's app.
 *
 * Usage: node tools/pilot-feedback-api-check.mjs   (exit 0 when every leg passes)
 */

import assert from 'node:assert/strict';

import { persistentWorld } from './owned-api-check.mjs';
import { THROTTLE_POLICY } from '../server/owned-postgres/throttle.mjs';

const RUN = `${process.pid.toString(36)}${Date.now().toString(36)}`;
const COOKIE = 'hatoove_owned_session';
const QUESTIONS = [
  { id: 'ease', type: 'scale', min: 1, max: 5 },
  { id: 'useful', type: 'scale', min: 1, max: 5 },
  { id: 'explanations', type: 'scale', min: 1, max: 5 },
  { id: 'recommend', type: 'scale', min: 0, max: 10 },
  { id: 'next', type: 'text', max_length: 1000 },
];
const results = [];
async function check(name, run) {
  try {
    await run();
    results.push([name, true, '']);
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push([name, false, error.message]);
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

async function main() {
  /*
   * THE SHIPPED POLICY, NOT AN INJECTED ONE. An injected small limit is the usual trick, but here it would make
   * the throttle leg prove a number nobody ships — and it is what made the first run of this file report four
   * false 429s, because the functional legs spent the small budget. The real limit is 20 per account per day, so
   * leg 19 spends twenty calls and proves the twenty-first is refused. (`persistentWorld({ limits })` remains the
   * injection point that amendment A9 wrongly claimed did not exist.)
   */
  const pg = await persistentWorld();
  const admin = pg.fixture.admin;
  const schema = pg.fixture.schema;
  let counter = 0;

  /*
   * DETERMINISTIC PRECONDITION. `survey_round` rows are undeletable by design (leg 18 of the migration check
   * proves it), and other checks leave their rounds behind on a shared disposable database — so a round left OPEN
   * by an earlier run made "204 when no round is open" impossible to assert. A round's DATES are correctable by
   * design, so close every open one first and let this check own its own preconditions.
   */
  await admin.query(`UPDATE "${schema}".survey_round SET closes_at = now() - interval '1 hour'
                      WHERE closes_at > now()`);

  const call = (method, path, { cookie = null, body } = {}) => pg.api.handle({
    method,
    path,
    headers: { accept: 'application/json', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    originChecked: true,
  });
  const json = (response) => (response.body ? JSON.parse(response.body) : null);
  async function signUp(label) {
    const n = ++counter;
    const response = await call('POST', '/api/auth/sign-up/email', {
      body: { name: `Feedback ${label}`, email: `fb-${RUN}-${n}@example.invalid`, password: `pw-fb-${n}-synthetic` },
    });
    assert.equal(response.status, 200, `sign-up for ${label} must succeed (got ${response.status} ${response.body})`);
    return String(response.headers['set-cookie']).split(';')[0];
  }
  const file = (cookie, body) => call('POST', '/api/v1/feedback', { cookie, body });
  const list = (cookie) => call('GET', '/api/v1/feedback', { cookie });
  /**
   * Which round the API is offering this learner, or null for 204.
   *
   * A shared disposable database may hold OTHER open rounds left by another check, so "the round is not offered
   * again" must be asserted about THIS round rather than by expecting a 204 — the first version of this file
   * asserted the 204, and a leftover round made a correct behaviour look broken.
   */
  const servedRound = async (cookie) => {
    const response = await call('GET', '/api/v1/survey/current', { cookie });
    return response.status === 200 ? json(response).round_id : null;
  };
  const countReports = async (owner) => Number((await admin.query(
    `SELECT count(*)::int AS n FROM "${schema}".pilot_feedback WHERE owner_id = $1`, [owner])).rows[0].n);

  try {
    /* ---------------------------------------------------------------- the shipped policy, offline */
    await check('1. the shipped policy carries both feedback kinds with the contract\'s limits', async () => {
      assert.deepEqual(THROTTLE_POLICY.feedback, { limit: 20, windowSeconds: 86400 },
        'feedback must be 20 per account per 24 h');
      assert.deepEqual(THROTTLE_POLICY.feedbackGlobal, { limit: 200, windowSeconds: 3600 },
        'feedbackGlobal must be 200 per hour');
    });

    const a = await signUp('A');
    const ownerA = (await admin.query(
      `SELECT id FROM "${schema}"."user" WHERE email = $1`, [`fb-${RUN}-1@example.invalid`])).rows[0].id;

    /* ---------------------------------------------------------------- the happy path */
    let firstId = null;
    await check('2. a report is filed and answered 201 with a feedback_id', async () => {
      const response = await file(a, { category: 'bug', body: '  Die Aufnahme bricht ab.  ', route: 'hoeren' });
      assert.equal(response.status, 201, `expected 201, got ${response.status} ${response.body}`);
      firstId = json(response).feedback_id;
      assert.match(String(firstId), /^[0-9a-f-]{36}$/, 'the answer must carry a uuid');
      const row = (await admin.query(
        `SELECT owner_id, kind, category, body, route, status, app_version, interface_language
           FROM "${schema}".pilot_feedback WHERE feedback_id = $1`, [firstId])).rows[0];
      // The OWNER is recorded from the session, not from the request, and the body is stored TRIMMED.
      assert.equal(row.owner_id, ownerA, 'the reporter must be the session owner');
      assert.equal(row.body, 'Die Aufnahme bricht ab.', 'the stored body must be trimmed');
      assert.equal(row.kind, 'report');
      assert.equal(row.status, 'new');
      assert.equal(row.interface_language, 'de', 'an absent interface_language defaults to de (A8)');
      assert.equal(row.app_version, 'unknown', 'app_version is the literal unknown in Stage 1 (A6)');
    });

    /* ---------------------------------------------------------------- the closed field set */
    await check('3. an unknown field is refused with 422 and files nothing', async () => {
      const before = await countReports(ownerA);
      const response = await file(a, { category: 'bug', body: 'Text', route: 'hoeren', categoy: 'bug' });
      assert.equal(response.status, 422, `expected 422 for an unknown field, got ${response.status} ${response.body}`);
      assert.deepEqual(json(response), { error: 'unknown_field' });
      assert.equal(await countReports(ownerA), before, 'a refused request must file nothing');
    });

    await check('4. a missing or over-long body, an unknown category and an unknown route are each 422', async () => {
      const cases = [
        ['no body at all', { category: 'bug', route: 'hoeren' }],
        ['a blank body', { category: 'bug', body: '   ', route: 'hoeren' }],
        ['a 2001-character body', { category: 'bug', body: 'x'.repeat(2001), route: 'hoeren' }],
        ['an unknown category', { category: 'nonsense', body: 'Text', route: 'hoeren' }],
        ['a drafted route', { category: 'bug', body: 'Text', route: 'today' }],
        ['an unknown route', { category: 'bug', body: 'Text', route: 'nonsense' }],
      ];
      for (const [label, body] of cases) {
        const response = await file(a, body);
        assert.equal(response.status, 422, `${label} must be 422, got ${response.status} ${response.body}`);
      }
      // A 2000-character body is INSIDE the bound and must be accepted.
      const atLimit = await file(a, { category: 'idea', body: 'y'.repeat(2000), route: 'heute' });
      assert.equal(atLimit.status, 201, `a 2000-character body is within the bound (got ${atLimit.status})`);
    });

    await check('5. an unknown interface_language is 422 and a known one is stored', async () => {
      const bad = await file(a, { category: 'idea', body: 'Text', route: 'heute', interfaceLanguage: 'xx' });
      assert.equal(bad.status, 422, `expected 422 for an unknown interface language, got ${bad.status}`);
      const good = await file(a, { category: 'idea', body: 'Text', route: 'heute', interfaceLanguage: 'uk' });
      assert.equal(good.status, 201);
      const row = (await admin.query(
        `SELECT interface_language FROM "${schema}".pilot_feedback WHERE feedback_id = $1`,
        [json(good).feedback_id])).rows[0];
      assert.equal(row.interface_language, 'uk');
    });

    /* ---------------------------------------------------------------- what the learner reads back */
    await check('6. GET returns the learner\'s own reports, newest first, and never operator_note', async () => {
      // The operator's note is internal triage data and must not reach the learner, on any row.
      await admin.query(`UPDATE "${schema}".pilot_feedback SET operator_note = 'triaged by the operator'
                          WHERE owner_id = $1`, [ownerA]);
      const response = await list(a);
      assert.equal(response.status, 200, `expected 200, got ${response.status}`);
      const rows = json(response).feedback;
      const stored = await countReports(ownerA);
      assert.equal(rows.length, stored, `the list must hold exactly the learner's own reports (${rows.length} vs ${stored})`);
      assert.ok(stored >= 3, `expected at least three reports by now, got ${stored}`);
      assert.ok(rows.every((row) => !('operator_note' in row)), 'operator_note must never be returned');
      assert.ok(rows.every((row) => typeof row.status === 'string'), 'status must be returned');
      const times = rows.map((row) => String(row.created_at));
      assert.deepEqual([...times].sort().reverse(), times, 'reports must be newest first');
      assert.ok(rows.some((row) => row.feedback_id === firstId), 'the first report must be in the list');
    });

    await check('7. another learner sees none of them', async () => {
      const b = await signUp('B');
      const response = await list(b);
      assert.equal(response.status, 200);
      assert.deepEqual(json(response).feedback, [], 'a different learner must see an empty list');
      const byId = await call('GET', '/api/v1/feedback', { cookie: b });
      assert.equal(json(byId).feedback.length, 0);
    });

    /* ---------------------------------------------------------------- the context rule */
    await check('8. an invalid context is DROPPED and the report is still saved', async () => {
      const response = await file(a, {
        category: 'bug', body: 'Mit Kontext', route: 'probepruefung',
        context: { runId: '00000000-0000-4000-8000-000000000000' },
      });
      assert.equal(response.status, 201, 'a stale page must never lose the report');
      assert.equal(json(response).context, 'dropped', 'the answer must say the context was dropped');
      const row = (await admin.query(
        `SELECT run_id FROM "${schema}".pilot_feedback WHERE feedback_id = $1`, [json(response).feedback_id])).rows[0];
      assert.equal(row.run_id, null, 'a dropped context must be stored as NULL, not as a guess');
    });

    await check('9. a valid context is kept', async () => {
      const section = (await admin.query(
        `SELECT guide_id, section_id FROM "${schema}".guide_section LIMIT 1`)).rows[0];
      assert.ok(section, 'the seeded corpus must contain a guide section to point at');
      const response = await file(a, {
        category: 'translation', body: 'Diese Übersetzung stimmt nicht.', route: 'nachschlagen',
        context: { guideId: section.guide_id, sectionId: section.section_id },
      });
      assert.equal(response.status, 201, `expected 201, got ${response.status} ${response.body}`);
      assert.equal(json(response).context, undefined, 'a kept context is not announced as dropped');
      const row = (await admin.query(
        `SELECT guide_id, section_id FROM "${schema}".pilot_feedback WHERE feedback_id = $1`,
        [json(response).feedback_id])).rows[0];
      assert.equal(row.guide_id, section.guide_id);
      assert.equal(row.section_id, section.section_id);
    });

    await check('10. a context field outside the closed set is 422', async () => {
      const response = await file(a, {
        category: 'bug', body: 'Text', route: 'heute', context: { ownerId: 'somebody-else' },
      });
      assert.equal(response.status, 422, `expected 422, got ${response.status} ${response.body}`);
    });

    /* ---------------------------------------------------------------- the survey gate */
    await check('11. survey/current is 204 when no round is open', async () => {
      const response = await call('GET', '/api/v1/survey/current', { cookie: a });
      assert.equal(response.status, 204, `expected 204, got ${response.status} ${response.body}`);
      assert.equal(response.body, '', 'a 204 must carry no body');
    });

    const seedRound = (id, minAgeDays) => admin.query(
      `INSERT INTO "${schema}".survey_round(round_id, opens_at, closes_at, questions, min_account_age_days)
       VALUES ($1, now() - interval '1 hour', now() + interval '13 days', $2::jsonb, $3)`,
      [id, JSON.stringify(QUESTIONS), minAgeDays]);

    await check('12. a round the account is too new for is still 204', async () => {
      // The age gate reads the account's age through the SECURITY DEFINER reader (A13): the learner role has no
      // grant on "user" at all, so there is no other way to answer this. 365 is the column's own CHECK ceiling.
      await seedRound(`fb-${RUN}-old`, 365);
      const response = await call('GET', '/api/v1/survey/current', { cookie: a });
      assert.equal(response.status, 204, `a too-new account must not be asked (got ${response.status} ${response.body})`);
    });

    await check('13. an open round the learner is old enough for is served with its questions', async () => {
      await seedRound(`fb-${RUN}-open`, 0);
      const response = await call('GET', '/api/v1/survey/current', { cookie: a });
      assert.equal(response.status, 200, `expected 200, got ${response.status} ${response.body}`);
      const round = json(response);
      assert.equal(round.round_id, `fb-${RUN}-open`);
      assert.deepEqual(round.questions, QUESTIONS, 'the round must carry its question set');
    });

    await check('14. answering is 200, a second submission is 409, and the round stops being served', async () => {
      const answers = { ease: 4, useful: 5, explanations: 4, recommend: 9, next: 'Mehr Hörbeispiele.' };
      const first = await call('POST', `/api/v1/survey/fb-${RUN}-open`, { cookie: a, body: { answers } });
      assert.equal(first.status, 200, `expected 200, got ${first.status} ${first.body}`);
      const second = await call('POST', `/api/v1/survey/fb-${RUN}-open`, { cookie: a, body: { answers } });
      assert.equal(second.status, 409, `a second submission must be 409, got ${second.status} ${second.body}`);
      assert.deepEqual(json(second), { error: 'survey_already_answered' });
      const after = await servedRound(a);
      assert.notEqual(after, `fb-${RUN}-open`, 'an answered round must not be offered again');
    });

    await check('15. a skip is recorded as a row with NULL answers, and is not asked again', async () => {
      const b = await signUp('C');
      const before = await call('GET', '/api/v1/survey/current', { cookie: b });
      assert.equal(before.status, 200, 'the second learner must be offered the round');
      const skip = await call('POST', `/api/v1/survey/fb-${RUN}-open`, { cookie: b, body: { skip: true } });
      assert.equal(skip.status, 200, `a skip must be accepted (got ${skip.status} ${skip.body})`);
      const row = (await admin.query(
        `SELECT survey_answers FROM "${schema}".pilot_feedback
          WHERE kind = 'survey' AND survey_round = $1
            AND owner_id = (SELECT id FROM "${schema}"."user" WHERE email = $2)`,
        [`fb-${RUN}-open`, `fb-${RUN}-3@example.invalid`])).rows[0];
      assert.ok(row, 'a skip must leave a row: that is what "not asked again" is made of');
      assert.equal(row.survey_answers, null, 'a skip stores NULL answers');
      const after = await servedRound(b);
      assert.notEqual(after, `fb-${RUN}-open`, 'a skipped round must not be offered again');
    });

    await check('16. neither answers nor a skip, and both at once, are 422', async () => {
      const d = await signUp('D');
      const neither = await call('POST', `/api/v1/survey/fb-${RUN}-open`, { cookie: d, body: {} });
      assert.equal(neither.status, 422, `expected 422, got ${neither.status} ${neither.body}`);
      const both = await call('POST', `/api/v1/survey/fb-${RUN}-open`, {
        cookie: d, body: { skip: true, answers: { ease: 4 } },
      });
      assert.equal(both.status, 422, `expected 422, got ${both.status} ${both.body}`);
    });

    await check('17. an out-of-range answer is refused as 422, not surfaced as a server error', async () => {
      const e = await signUp('E');
      const response = await call('POST', `/api/v1/survey/fb-${RUN}-open`, {
        cookie: e, body: { answers: { ease: 9, useful: 5, explanations: 4, recommend: 9 } },
      });
      assert.equal(response.status, 422, `an out-of-range rating must be 422, got ${response.status} ${response.body}`);
      assert.deepEqual(json(response), { error: 'invalid_answers' });
    });

    await check('18. a closed round is 409 and an unknown round is 422', async () => {
      const f = await signUp('F');
      await admin.query(
        `INSERT INTO "${schema}".survey_round(round_id, opens_at, closes_at, questions, min_account_age_days)
         VALUES ($1, now() - interval '2 days', now() - interval '1 day', $2::jsonb, 0)`,
        [`fb-${RUN}-closed`, JSON.stringify(QUESTIONS)]);
      const closed = await call('POST', `/api/v1/survey/fb-${RUN}-closed`, { cookie: f, body: { skip: true } });
      assert.equal(closed.status, 409, `a closed round must be 409, got ${closed.status} ${closed.body}`);
      const unknown = await call('POST', '/api/v1/survey/fb-does-not-exist', { cookie: f, body: { skip: true } });
      assert.equal(unknown.status, 422, `an unknown round must be 422, got ${unknown.status} ${unknown.body}`);
    });

    /* ---------------------------------------------------------------- the throttle */
    await check('19. the account is refused with 429 once the SHIPPED daily allowance is spent', async () => {
      const g = await signUp('G');
      // Spend the real limit (20 per account per 24 h) rather than an injected one, so the leg proves the number
      // that ships. The global hourly ceiling is 200; the whole run stays well inside it.
      const limit = THROTTLE_POLICY.feedback.limit;
      for (let i = 1; i <= limit; i += 1) {
        const ok = await file(g, { category: 'bug', body: `Report ${i}`, route: 'heute' });
        assert.equal(ok.status, 201, `report ${i} of ${limit} is inside the budget (got ${ok.status} ${ok.body})`);
      }
      const refused = await file(g, { category: 'bug', body: 'One too many', route: 'heute' });
      assert.equal(refused.status, 429, `expected 429, got ${refused.status} ${refused.body}`);
      assert.deepEqual(json(refused), { error: 'too_many_requests' });
      const retryAfter = Number(refused.headers['retry-after']);
      assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, `a refusal must name a time (Retry-After=${refused.headers['retry-after']})`);
      // A refusal must not have filed anything: the limit is checked BEFORE the insert.
      const stored = await countReports((await admin.query(
        `SELECT id FROM "${schema}"."user" WHERE email = $1`, [`fb-${RUN}-7@example.invalid`])).rows[0].id);
      assert.equal(stored, limit, `the refused report must not be stored (${stored} rows)`);
    });
  } finally {
    await pg.teardown();
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n---- pilot-feedback-api-check: ${results.length - failed.length}/${results.length} passed ----`);
  for (const [name, ok, detail] of results) if (!ok) console.log(`  FAIL  ${name}: ${detail}`);
  if (failed.length) process.exit(1);
  console.log('all legs passed');
}

await main();
