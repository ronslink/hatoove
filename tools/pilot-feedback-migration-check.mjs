/*
 * PILOT-FEEDBACK-01 (slice FB-A) — the negative and isolation legs for migration `0049`.
 *
 * WHY THIS EXISTS. `table-class-check` proves the new tables are CLASSIFIED and that the answer-key rule holds;
 * `deletion-check` proves the erasure steps run in order. Neither of them proves the properties this feature is
 * actually made of: that one learner cannot see another's report, that a learner cannot update or delete one,
 * that a client cannot file a report that already claims to be handled, that a round takes one answer per
 * learner, or that the survey answers are checked against THEIR round's question set. Every one of those is a
 * NEGATIVE leg — it passes only by observing a refusal — and each is written so that removing the guard makes
 * it fail. A guard nobody attacked is not evidence; this program has shipped six of those already.
 *
 * IT ALSO PINS TWO CONTRACT AMENDMENTS as executable facts:
 *   A5  the column is `survey_answers`; a column named `answers` would make the table key-bearing.
 *   A7  `route` accepts the CLIENT'S real view ids and rejects the drafted vocabulary, so a report cannot be
 *       filed with a route no screen produces.
 *
 * SAFETY: synthetic rows only, in a disposable installation. The rows a learner files are COMMITTED — they have
 * to be, or the isolation leg cannot observe them — so a run leaves behind two synthetic accounts, their
 * synthetic report/survey/screenshot rows, and one round. Every id is unique per run (`Date.now()` suffix), so
 * the check is re-runnable and never collides with its own previous output, and the round is left behind because
 * migration `0049` makes a round undeletable — which leg 18 proves. The alternative, rolling back, is what made
 * the first version of this file report three failures that were not schema defects.
 * It never touches a database it was not pointed at, and `persistentConfig()` refuses to run without
 * `OWNAPI_PG_ALLOW=1`.
 *
 * FOUR LEGS WERE VACUOUS UNTIL AN INDEPENDENT REVIEW MUTATED THEM. Each passed with its guard removed,
 * because something else refused the row first — the unique index, the digest check, a foreign key, or the
 * cascade. They now name the mechanism they are testing (leg 14 asserts 23514 AND stores a valid control; leg 17
 * asserts the CONSTRAINT NAME; leg 18 deletes a round nothing references; leg 19 asserts the policy EXISTS).
 * Re-running the reviewer's four mutations against the fixed legs:
 *
 *   M-a DROP TRIGGER pilot_feedback_guard            -> leg 14
 *   M-b DROP CONSTRAINT ..._screenshot_bytes_check   -> leg 17
 *   M-c DROP TRIGGER survey_round_immutable          -> leg 18
 *   M-d DROP POLICY deletion_pilot_feedback_screenshot -> leg 19
 *
 * THREE WAYS THE MUTATION HARNESS ITSELF LIED, all hit while doing the above, all worth knowing before trusting
 * any mutation table in this repository:
 *   1. The MUTATION's exit code was never checked, only the restore's — so a drop that silently matched a
 *      different object looked like a leg that would not bite.
 *   2. A restore that INVENTED a trigger name (`guard_pilot_feedback`, named after its function) created a PHANTOM
 *      TRIGGER, and the phantom then masked the next mutation. Verify the object you are restoring exists under
 *      the name you think it does.
 *   3. Restoring a dropped CHECK can FAIL (exit 3) because the mutation let rows in that the constraint now
 *      rejects; those stray rows then break unrelated legs. Clean the mutation's own leavings up before restoring.
 *
 * Usage: node tools/pilot-feedback-migration-check.mjs
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FEEDBACK_ROUTES } from '../server/owned-postgres/feedback.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.join(HERE, '..', 'server', 'migrations', '0050-pilot-feedback.sql');
const MANIFEST = path.join(HERE, '..', 'server', 'migrations', 'MANIFEST.json');

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push([name, true, '']);
    console.log(`PASS  ${name}`);
  } catch (error) {
    results.push([name, false, error.message]);
    console.log(`FAIL  ${name}\n      ${error.message}`);
  }
}

/** A schema-qualified identifier. The schema comes from the validated config, never from a caller. */
const ident = (value) => `"${String(value).replaceAll('"', '""')}"`;

/**
 * Run `fn` as the `learner` role with the owner GUC set transaction-locally, then COMMIT.
 *
 * IT MUST COMMIT, and the first version of this file is why: with a rollback, the row A filed ceased to exist
 * before A could read it, and the "second survey row" had no first row to collide with — so three legs failed
 * for a reason that had nothing to do with the schema, and one of them (the isolation leg) would have passed
 * VACUOUSLY once "fixed" the wrong way. A statement the leg expects to be REFUSED aborts the transaction; the
 * COMMIT then rolls it back harmlessly, because PostgreSQL ends an aborted transaction on COMMIT.
 */
async function asLearner(pool, owner, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** The PostgreSQL error code of a refused statement, or null when it was allowed. */
async function refusal(client, sql, params = []) {
  try {
    await client.query(sql, params);
    return null;
  } catch (error) {
    return error.code ?? error.message;
  }
}

/**
 * The whole error, not just its code. A leg that only asks "was it refused?" cannot tell WHICH rule refused — and
 * several legs here were passing on the wrong rule entirely (the unique index instead of the answer check, the
 * digest instead of the size, a foreign key instead of the trigger). Asserting `error.constraint` is how a leg
 * proves its own property rather than the existence of some property.
 */
async function refusalDetail(client, sql, params = []) {
  try {
    await client.query(sql, params);
    return null;
  } catch (error) {
    return { code: error.code, constraint: error.constraint, message: error.message, routine: error.routine };
  }
}

const ROUND_SUFFIX = Date.now().toString(36);
const ROUND = `check-${ROUND_SUFFIX}`;
const QUESTIONS = [
  { id: 'ease', type: 'scale', min: 1, max: 5 },
  { id: 'useful', type: 'scale', min: 1, max: 5 },
  { id: 'explanations', type: 'scale', min: 1, max: 5 },
  { id: 'recommend', type: 'scale', min: 0, max: 10 },
  { id: 'next', type: 'text', max_length: 1000 },
];

async function main() {
  const { persistentConfig, provisionPersistent, closePersistent } = await import('../server/owned-postgres/provision.mjs');
  const config = persistentConfig();
  const schema = config.schema;
  let pools;
  try {
    pools = await provisionPersistent({ config });
  } catch (error) {
    /*
     * THE DIGEST GATE RUNS BEFORE ANY LEG, so a frozen migration whose bytes differ from the ledger is refused
     * here — which is correct, and which the first attempt to mutation-prove leg 1b discovered by dying: the
     * run printed a stack trace and no verdict at all. A check whose failure mode is "no output" cannot be read.
     * Report it as a failure that names the gate, then stop.
     */
    console.log(`FAIL  provisioning: ${error.message}`);
    console.log('\n---- pilot-feedback-migration-check: the schema could not be provisioned, so no leg ran ----');
    process.exit(1);
  }
  const admin = pools.admin;
  const q = (sql, params) => admin.query(sql, params);
  const T = (table) => `${ident(schema)}.${ident(table)}`;

  const suffix = Date.now().toString(36);
  const A = `user-fba-a-${suffix}`;
  const B = `user-fba-b-${suffix}`;
  /*
   * A THIRD LEARNER EXISTS SO LEG 14 TESTS WHAT IT CLAIMS. It used to insert as A, who already held a survey row
   * for the round from leg 12 — so every insert in leg 14 was refused by the UNIQUE index and the leg passed even
   * with the answer validation switched off entirely. An independent review reproduced exactly that. C has no
   * row, so the only thing that can refuse these inserts is the answer rule itself.
   */
  const C = `user-fba-c-${suffix}`;

  try {
    /* ---------------------------------------------------------------- offline: the digest is pinned */
    await check('1. the migration is pinned in MANIFEST and the bytes match the pin', async () => {
      const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
      const recorded = manifest.migrations['0050-pilot-feedback'];
      assert.ok(recorded, 'MANIFEST records no digest for 0050-pilot-feedback');
      const actual = createHash('sha256').update(readFileSync(MIGRATION)).digest('hex');
      assert.equal(recorded, actual, `MANIFEST has ${recorded}, the file is ${actual}`);
    });

    /* ---------------------------------------------------------------- A7: the list is the shell's list */
    await check('1b. the route closed list equals the shell\'s view ids, plus `other` (A7)', async () => {
      /*
       * SAMPLING WOULD NOT BE ENOUGH. Leg 11 asserts that a few real ids are accepted and a few drafted ones
       * refused, but the property A7 actually needs is that the two lists stay EQUAL: the day someone adds a
       * view to the shell without touching this CHECK, every report filed from it is refused and LOST — and a
       * sampled leg would still pass. So compare the sets.
       */
      const clause = readFileSync(MIGRATION, 'utf8').match(/route\s+text CHECK \(route IN \(([\s\S]*?)\)\)/);
      assert.ok(clause, 'the migration carries no route CHECK to compare');
      const inSql = new Set([...clause[1].matchAll(/'([a-z-]+)'/g)].map((match) => match[1]));

      const shell = readFileSync(path.join(HERE, '..', 'public', 'app', 'app.js'), 'utf8');
      const block = shell.match(/const VIEW_TITLES = \{([\s\S]*?)\n\};/);
      assert.ok(block, 'public/app/app.js has no VIEW_TITLES block to compare against');
      const inShell = new Set([...block[1].matchAll(/(\w+):\s*'[A-Za-z][A-Za-z0-9]*'/g)].map((match) => match[1]));
      // The contract's escape hatch: a view the shell does not name is filed as `other` rather than refused.
      inShell.add('other');

      const onlySql = [...inSql].filter((view) => !inShell.has(view)).sort();
      const onlyShell = [...inShell].filter((view) => !inSql.has(view)).sort();
      assert.deepEqual(onlySql, [], `the CHECK accepts route(s) no screen produces: ${onlySql.join(', ')}`);
      assert.deepEqual(onlyShell, [],
        `the shell has view id(s) the CHECK rejects, so a report filed from them is LOST: ${onlyShell.join(', ')}`);

      /*
       * THE THIRD COPY. FB-B validates `route` in the API as well, so the list now exists in three places and any
       * one of them drifting loses reports: the migration's CHECK refuses the row (23514), or the API refuses the
       * request (422), or the shell offers a view the other two reject. FEEDBACK_ROUTES is the only JavaScript
       * copy, and it is compared here against the migration file AND against the shell.
       */
      const inApi = new Set(FEEDBACK_ROUTES);
      const onlyApi = [...inApi].filter((view) => !inSql.has(view)).sort();
      const missingFromApi = [...inSql].filter((view) => !inApi.has(view)).sort();
      assert.deepEqual(onlyApi, [],
        `FEEDBACK_ROUTES accepts route(s) the CHECK rejects, so the API would accept a report the database then refuses: ${onlyApi.join(', ')}`);
      assert.deepEqual(missingFromApi, [],
        `the CHECK accepts route(s) FEEDBACK_ROUTES would refuse with a 422: ${missingFromApi.join(', ')}`);
    });

    /* ---------------------------------------------------------------- A10: the content table has NO rls */
    await check('2. survey_round is content-class: RLS disabled and NOT forced (A10)', async () => {
      const row = (await q(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
                              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                             WHERE n.nspname = $1 AND c.relname = 'survey_round'`, [schema])).rows[0];
      assert.ok(row, 'survey_round does not exist');
      assert.equal(row.rls, false, 'survey_round must NOT have row-level security: a learner could never read a round');
      assert.equal(row.force_rls, false, 'survey_round must not FORCE RLS either');
    });

    await check('3. the owned tables ENABLE and FORCE RLS', async () => {
      for (const table of ['pilot_feedback', 'pilot_feedback_screenshot']) {
        const row = (await q(`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
                                FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                               WHERE n.nspname = $1 AND c.relname = $2`, [schema, table])).rows[0];
        assert.ok(row?.rls && row?.force_rls, `${table} must ENABLE and FORCE row-level security`);
      }
    });

    /* ---------------------------------------------------------------- grants: SELECT+INSERT, never more */
    await check('4. the learner holds SELECT and INSERT and neither UPDATE nor DELETE', async () => {
      for (const table of ['pilot_feedback', 'pilot_feedback_screenshot']) {
        for (const [privilege, expected] of [['SELECT', true], ['INSERT', true], ['UPDATE', false], ['DELETE', false]]) {
          const held = (await q('SELECT has_table_privilege($1, $2, $3) AS held',
            [config.roles.learner, `${schema}.${table}`, privilege])).rows[0].held;
          assert.equal(held, expected, `${table}: learner ${privilege} must be ${expected}`);
        }
      }
    });

    /* ---------------------------------------------------------------- seed two synthetic accounts + a round */
    for (const [id, email] of [[A, `${A}@example.invalid`], [B, `${B}@example.invalid`], [C, `${C}@example.invalid`]]) {
      await q(`INSERT INTO ${T('user')}(id, name, email, "emailVerified", "createdAt", "updatedAt")
               VALUES ($1, 'Synthetic', $2, true, now(), now())`, [id, email]);
    }
    await q(`INSERT INTO ${T('survey_round')}(round_id, opens_at, closes_at, questions, min_account_age_days)
             VALUES ($1, now() - interval '1 day', now() + interval '13 days', $2::jsonb, 0)`,
      [ROUND, JSON.stringify(QUESTIONS)]);

    const reportRow = (owner, extra = {}) => {
      const values = {
        id: randomUUID(), owner, kind: 'report', category: 'bug', body: 'Die Aufnahme bricht ab.',
        route: 'hoeren', language: 'de', ...extra,
      };
      return values;
    };

    async function insertReport(client, row) {
      return client.query(
        `INSERT INTO ${T('pilot_feedback')}
           (feedback_id, owner_id, kind, category, body, route, interface_language, app_version, status, operator_note, handled_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [row.id, row.owner, row.kind, row.category, row.body, row.route, row.language, 'unknown',
          row.status ?? 'new', row.operator_note ?? null, row.handled_at ?? null]);
    }

    /* ---------------------------------------------------------------- the isolation leg */
    let aReportId = null;
    await check('5. a report filed by A is invisible to B and visible to A', async () => {
      const row = reportRow(A);
      aReportId = row.id;
      await asLearner(pools.learner, A, (client) => insertReport(client, row));
      // `asLearner` resolves to what `fn` returned, which is the pg Result — `.rows` is the assertion's data.
      const visibleToB = (await asLearner(pools.learner, B, (client) =>
        client.query(`SELECT count(*)::int AS n FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [row.id]))).rows[0].n;
      const allForB = (await asLearner(pools.learner, B, (client) =>
        client.query(`SELECT count(*)::int AS n FROM ${T('pilot_feedback')}`))).rows[0].n;
      const allForA = (await asLearner(pools.learner, A, (client) =>
        client.query(`SELECT count(*)::int AS n FROM ${T('pilot_feedback')}`))).rows[0].n;
      assert.equal(visibleToB, 0, "B sees A's report by id: the SELECT policy is not fencing the owner");
      assert.equal(allForB, 0, "B sees at least one of A's reports in a full scan");
      assert.ok(allForA >= 1, 'A cannot see their own report: the policy fences too hard');
    });

    /* ---------------------------------------------------------------- the reporter cannot be forged */
    await check('5b. a learner cannot FILE a report attributed to another owner', async () => {
      const row = reportRow(A);
      const code = await asLearner(pools.learner, B, (client) => refusal(client,
        `INSERT INTO ${T('pilot_feedback')} (feedback_id, owner_id, kind, category, body, route, interface_language, app_version)
         VALUES ($1,$2,'report','bug','Filed as somebody else','hoeren','de','unknown')`, [row.id, A]));
      assert.ok(code, 'B filed a report attributed to A: the reporter recorded against the row can be forged');
      assert.match(String(code), /42501|row-level security|check/i, `expected a policy refusal, got ${code}`);
    });

    /* ---------------------------------------------------------------- no update, no delete */
    await check('6. a learner cannot UPDATE their own report (no privilege at all)', async () => {
      const code = await asLearner(pools.learner, A, (client) =>
        refusal(client, `UPDATE ${T('pilot_feedback')} SET status = 'fixed' WHERE feedback_id = $1`, [aReportId]));
      assert.ok(code, 'the UPDATE was allowed: a learner could mark their own report fixed');
      assert.match(String(code), /42501|permission denied/i, `expected a privilege refusal, got ${code}`);
    });

    await check('7. a learner cannot DELETE their own report', async () => {
      const code = await asLearner(pools.learner, A, (client) =>
        refusal(client, `DELETE FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [aReportId]));
      assert.ok(code, 'the DELETE was allowed');
      assert.match(String(code), /42501|permission denied/i, `expected a privilege refusal, got ${code}`);
    });

    /* ---------------------------------------------------------------- the INSERT policy WITH CHECK */
    await check('8. a report filed with a status other than new is refused', async () => {
      const row = reportRow(A, { status: 'fixed' });
      const code = await asLearner(pools.learner, A, (client) => refusal(client,
        `INSERT INTO ${T('pilot_feedback')} (feedback_id, owner_id, kind, category, body, route, interface_language, app_version, status)
         VALUES ($1,$2,'report','bug','Text','hoeren','de','unknown','fixed')`, [row.id, A]));
      assert.ok(code, 'a learner filed a report that claims to be already fixed');
      assert.match(String(code), /42501|23514|row-level security|check/i, `expected a policy refusal, got ${code}`);
    });

    await check('9. a report filed with operator_note or handled_at already set is refused', async () => {
      for (const [column, value] of [['operator_note', "'triaged by nobody'"], ['handled_at', 'now()']]) {
        const id = crypto.randomUUID();
        const code = await asLearner(pools.learner, A, (client) => refusal(client,
          `INSERT INTO ${T('pilot_feedback')} (feedback_id, owner_id, kind, category, body, route, interface_language, app_version, ${column})
           VALUES ($1,$2,'report','bug','Text','hoeren','de','unknown',${value})`, [id, A]));
        assert.ok(code, `a learner set ${column} on their own report`);
      }
    });

    await check('10. a report with no body is refused, and body is bounded at 2000', async () => {
      const missing = await asLearner(pools.learner, A, (client) => refusal(client,
        `INSERT INTO ${T('pilot_feedback')} (feedback_id, owner_id, kind, category, route, interface_language, app_version)
         VALUES ($1,$2,'report','bug','hoeren','de','unknown')`, [crypto.randomUUID(), A]));
      assert.ok(missing, 'a report with no body was accepted');
      const tooLong = await asLearner(pools.learner, A, (client) => refusal(client,
        `INSERT INTO ${T('pilot_feedback')} (feedback_id, owner_id, kind, category, body, route, interface_language, app_version)
         VALUES ($1,$2,'report','bug',repeat('x', 2001),'hoeren','de','unknown')`, [crypto.randomUUID(), A]));
      assert.ok(tooLong, 'a 2001-character body was accepted');
    });

    /* ---------------------------------------------------------------- A7: the real route vocabulary */
    await check('11. route accepts a real client view id (A7) and rejects the drafted vocabulary', async () => {
      const good = reportRow(A, { route: 'probepruefung' });
      await asLearner(pools.learner, A, (client) => insertReport(client, good));
      for (const drafted of ['today', 'mock-run', 'mistakes', 'settings']) {
        const row = reportRow(A, { route: drafted });
        const code = await asLearner(pools.learner, A, (client) => refusal(client,
          `INSERT INTO ${T('pilot_feedback')} (feedback_id, owner_id, kind, category, body, route, interface_language, app_version)
           VALUES ($1,$2,'report','bug','Text',$3,'de','unknown')`, [row.id, A, drafted]));
        assert.ok(code, `route "${drafted}" was accepted: it is not a shipped view id`);
      }
    });

    /* ---------------------------------------------------------------- survey: one row per round */
    async function insertSurvey(client, owner, answers) {
      return client.query(
        `INSERT INTO ${T('pilot_feedback')} (feedback_id, owner_id, kind, route, interface_language, app_version, survey_round, survey_answers)
         VALUES ($1,$2,'survey','heute','de','unknown',$3,$4::jsonb)`,
        [crypto.randomUUID(), owner, ROUND, answers === null ? null : JSON.stringify(answers)]);
    }

    await check('12. a learner may answer a round once; a second row for the same round is refused', async () => {
      const answers = { ease: 4, useful: 5, explanations: 4, recommend: 9, next: 'Mehr Hörbeispiele.' };
      await asLearner(pools.learner, A, (client) => insertSurvey(client, A, answers));
      const second = await asLearner(pools.learner, A, (client) => refusal(client,
        `INSERT INTO ${T('pilot_feedback')} (feedback_id, owner_id, kind, route, interface_language, app_version, survey_round, survey_answers)
         VALUES ($1,$2,'survey','heute','de','unknown',$3,$4::jsonb)`,
        [crypto.randomUUID(), A, ROUND, JSON.stringify(answers)]));
      assert.ok(second, 'a second survey row for the same (owner, round) was accepted');
      assert.match(String(second), /23505|unique/i, `expected a unique violation, got ${second}`);
    });

    await check('13. a skip is recorded as a survey row with NULL answers', async () => {
      await asLearner(pools.learner, B, (client) => insertSurvey(client, B, null));
      const row = (await q(`SELECT survey_answers FROM ${T('pilot_feedback')}
                             WHERE owner_id = $1 AND survey_round = $2`, [B, ROUND])).rows[0];
      assert.ok(row, 'the skip wrote no row');
      assert.equal(row.survey_answers, null, 'a skip must store NULL answers');
    });

    await check('14. survey answers outside the round range are refused', async () => {
      /*
       * AS LEARNER C, WHO HAS NO ROW FOR THIS ROUND — and every refusal must be the ANSWER rule (23514), not just
       * "something refused". Inserting as A made this leg vacuous: A already held a row from leg 12, so the UNIQUE
       * index refused all five cases and the leg passed with the answer validation removed.
       */
      const cases = [
        ['ease above its maximum', { ease: 9, useful: 5, explanations: 4, recommend: 9 }],
        ['recommend below its minimum', { ease: 4, useful: 5, explanations: 4, recommend: -1 }],
        ['an unknown question id', { ease: 4, useful: 5, explanations: 4, recommend: 9, nonsense: 1 }],
        ['a missing rating', { ease: 4, useful: 5 }],
        ['a rating that is not a number', { ease: '4', useful: 5, explanations: 4, recommend: 9 }],
      ];
      for (const [label, answers] of cases) {
        const code = await asLearner(pools.learner, C, (client) => refusal(client,
          `INSERT INTO ${T('pilot_feedback')} (feedback_id, owner_id, kind, route, interface_language, app_version, survey_round, survey_answers)
           VALUES ($1,$2,'survey','heute','de','unknown',$3,$4::jsonb)`,
          [crypto.randomUUID(), C, ROUND, JSON.stringify(answers)]));
        assert.ok(code, `${label} was accepted`);
        assert.match(String(code), /23514/,
          `${label} was refused by ${code}, not by the answer rule — the leg would pass for the wrong reason`);
      }
      /*
       * THE POSITIVE CONTROL. Without it, "every case was refused" is also satisfied by a table that refuses
       * everything — which is what the unique index was doing. C accepts a VALID set, so the refusals above can
       * only have come from the answers.
       */
      await asLearner(pools.learner, C, (client) => insertSurvey(client, C, { ease: 4, useful: 5, explanations: 4, recommend: 9 }));
      const stored = (await q(`SELECT count(*)::int AS n FROM ${T('pilot_feedback')}
                                 WHERE owner_id = $1 AND survey_round = $2`, [C, ROUND])).rows[0].n;
      assert.equal(stored, 1, 'a valid answer set was NOT accepted, so the refusals above prove nothing');
    });

    /* ---------------------------------------------------------------- the screenshot guard */
    await check('15. a screenshot hung off another owner\'s report is refused', async () => {
      const bytes = Buffer.from('RIFF0000WEBP', 'binary');
      const digest = createHash('sha256').update(bytes).digest('hex');
      const code = await asLearner(pools.learner, B, (client) => refusal(client,
        `INSERT INTO ${T('pilot_feedback_screenshot')} (feedback_id, owner_id, mime_type, bytes, width, height, sha256)
         VALUES ($1,$2,'image/webp',$3,1200,800,$4)`, [aReportId, B, bytes, digest]));
      assert.ok(code, "B hung an image off A's report: the owner trigger did not fire");
      assert.match(String(code), /23514|screenshot_owner_mismatch/i, `got ${code}`);
    });

    await check('16. a screenshot whose recorded sha256 is not its own bytes is refused', async () => {
      const bytes = Buffer.from('RIFF0000WEBP', 'binary');
      const lie = 'a'.repeat(64);
      const code = await asLearner(pools.learner, A, (client) => refusal(client,
        `INSERT INTO ${T('pilot_feedback_screenshot')} (feedback_id, owner_id, mime_type, bytes, width, height, sha256)
         VALUES ($1,$2,'image/webp',$3,1200,800,$4)`, [aReportId, A, bytes, lie]));
      assert.ok(code, 'a hash that does not match the stored bytes was accepted');
    });

    await check('17. an oversized screenshot is refused (1.5 MB, and width > 1600 px)', async () => {
      const bytes = Buffer.from('RIFF0000WEBP', 'binary');
      const digest = createHash('sha256').update(bytes).digest('hex');
      /*
       * THE OVERSIZED PAYLOAD NEEDS ITS OWN DIGEST, and the refusal must name the SIZE constraint. The first
       * version reused the small payload's digest, so the row ALSO violated the sha256 check and the size rule was
       * never what refused it — an independent review showed the leg passed with the size check removed entirely.
       * `constraint` is asserted so the leg cannot pass on the wrong rule again.
       */
      const oversized = Buffer.concat([bytes, Buffer.alloc(1572864)]);
      const tooBig = await asLearner(pools.learner, A, (client) => refusalDetail(client,
        `INSERT INTO ${T('pilot_feedback_screenshot')} (feedback_id, owner_id, mime_type, bytes, width, height, sha256)
         VALUES ($1,$2,'image/webp',$3,1200,800,$4)`,
        [aReportId, A, oversized, createHash('sha256').update(oversized).digest('hex')]));
      assert.ok(tooBig, 'a screenshot over 1.5 MB was accepted');
      assert.equal(tooBig.constraint, 'pilot_feedback_screenshot_bytes_check',
        `the oversized row was refused by ${tooBig.constraint ?? tooBig.code}, not by the size rule`);

      const tooWide = await asLearner(pools.learner, A, (client) => refusalDetail(client,
        `INSERT INTO ${T('pilot_feedback_screenshot')} (feedback_id, owner_id, mime_type, bytes, width, height, sha256)
         VALUES ($1,$2,'image/webp',$3,1601,800,$4)`, [aReportId, A, bytes, digest]));
      assert.ok(tooWide, 'a screenshot 1601 px wide was accepted');
      assert.equal(tooWide.constraint, 'pilot_feedback_screenshot_width_check',
        `the wide row was refused by ${tooWide.constraint ?? tooWide.code}, not by the width rule`);
    });

    /* ---------------------------------------------------------------- the round is frozen */
    await check('18. a round\'s question set cannot be changed once written, and a round cannot be deleted', async () => {
      const changed = (await q(`UPDATE ${T('survey_round')} SET questions = $2::jsonb WHERE round_id = $1`,
        [ROUND, JSON.stringify([{ id: 'ease', type: 'scale', min: 1, max: 5 }])]).then(() => null, (e) => e));
      assert.ok(changed, 'the question set was rewritten: every stored answer would silently change meaning');
      assert.match(String(changed.code), /23514/, `the rewrite was refused by ${changed.code}, not by the immutability rule`);
      /*
       * THE DELETION IS TESTED ON A ROUND WITH NO ANSWERS, because `pilot_feedback.survey_round` has a FOREIGN KEY
       * to this table. Deleting the used round is refused by that key (23503) BEFORE the trigger is ever reached,
       * so the leg passed with the DELETE trigger dropped — an independent review reproduced exactly that. An
       * unused round can only be refused by the trigger, which is the rule this leg is named for.
       */
      const spare = `${ROUND}-spare`;
      await q(`INSERT INTO ${T('survey_round')}(round_id, opens_at, closes_at, questions, min_account_age_days)
               VALUES ($1, now() - interval '1 day', now() + interval '13 days', $2::jsonb, 0)`,
        [spare, JSON.stringify([{ id: 'ease', type: 'scale', min: 1, max: 5 }])]);
      const removed = await q(`DELETE FROM ${T('survey_round')} WHERE round_id = $1`, [spare]).then(() => null, (e) => e);
      assert.ok(removed, 'an unused round was deleted: the immutability trigger is not doing its job');
      assert.match(String(removed.code), /23514/,
        `the deletion was refused by ${removed.code} — a foreign key, not the trigger this leg is about`);
      // The used round is STILL refused, by the foreign key, and that is worth pinning as its own fact.
      const used = await q(`DELETE FROM ${T('survey_round')} WHERE round_id = $1`, [ROUND]).then(() => null, (e) => e);
      assert.ok(used, 'a round with stored answers was deleted');
    });

    /* ---------------------------------------------------------------- erasure must actually delete these rows */
    await check('19. erasing the account removes its report AND its screenshot', async () => {
      /*
       * WHY THIS LEG IS NOT REDUNDANT WITH `deletion-check`. That check passes 20/20 and asserts the ordered
       * steps, but when it runs its synthetic accounts hold NO feedback rows, so both new steps in
       * ACCOUNT_DELETION_STEPS delete zero rows and would keep passing if they named the wrong table or the
       * wrong column. A step that removes nothing proves nothing.
       *
       * It also needs a VALID screenshot to exist: legs 15-17 only ever observed REFUSALS, so without this
       * insert the screenshot half would erase nothing and the leg would pass for the wrong reason -- which is
       * the exact failure shape this file exists to avoid.
       *
       * AND THE SCREENSHOT HALF CANNOT BE SATISFIED BY THE CASCADE ALONE. `pilot_feedback_screenshot` has
       * `ON DELETE CASCADE` from its report, so the row disappears whether or not the erasure POLICY is doing
       * anything — an independent review dropped the policy and this leg still passed. The cascade is a real
       * safety net and the outcome is what the learner cares about, but a policy that is never load-bearing must
       * be checked directly, so the leg below asserts the DELETE policy EXISTS rather than inferring it.
       */
      const erasurePolicies = (await q(
        `SELECT policyname, cmd, roles::text AS roles FROM pg_policies
          WHERE schemaname = $1 AND tablename = 'pilot_feedback_screenshot'`, [schema])).rows;
      const policy = erasurePolicies.find((row) => row.cmd === 'DELETE' && row.roles.includes(config.roles.deletion));
      assert.ok(policy, `no DELETE policy for the deletion role on pilot_feedback_screenshot: ${JSON.stringify(erasurePolicies)}`);

      const bytes = Buffer.from('RIFF0000WEBPVP8 ', 'binary');
      const digest = createHash('sha256').update(bytes).digest('hex');
      await asLearner(pools.learner, A, (client) => client.query(
        `INSERT INTO ${T('pilot_feedback_screenshot')} (feedback_id, owner_id, mime_type, bytes, width, height, sha256)
         VALUES ($1,$2,'image/webp',$3,1200,800,$4)`, [aReportId, A, bytes, digest]));

      const counts = async (owner) => (await q(
        `SELECT (SELECT count(*)::int FROM ${T('pilot_feedback')} WHERE owner_id = $1) AS reports,
                (SELECT count(*)::int FROM ${T('pilot_feedback_screenshot')} WHERE owner_id = $1) AS shots`, [owner])).rows[0];
      const before = await counts(A);
      assert.ok(before.reports >= 1, `the fixture has no report to erase (${before.reports})`);
      assert.equal(before.shots, 1, `the fixture has no screenshot to erase (${before.shots})`);

      const { createPostgresAccountDeletion } = await import('../server/owned-postgres/adapter.mjs');
      const erased = await createPostgresAccountDeletion({ pool: pools.deletion }).deleteAccount(A);

      assert.equal(erased.existed, true, 'the synthetic account did not exist, so nothing was erased');
      const after = await counts(A);
      assert.equal(after.reports, 0, `the report survived account erasure (${after.reports} left)`);
      assert.equal(after.shots, 0, `the screenshot survived account erasure (${after.shots} left)`);
    });

    /* ---------------------------------------------------------------- the survey age gate (A13) */
    await check('20. the account-age reader answers for the caller ONLY and takes no argument (A13)', async () => {
      /*
       * WHY THIS FUNCTION EXISTS AT ALL: `"user"` is granted to __AUTH__ and not to __LEARNER__, and
       * table-class-check enforces that, so the learner-pool datastore has NO readable path to
       * `"user"."createdAt"` — which the survey's `min_account_age_days` gate needs. The definer reader is the
       * answer, and the property that makes it safe is that it takes NO ARGUMENT: an owner parameter would have
       * let any learner ask when another account registered, and no ordinary review would have noticed.
       */
      const fn = (await q(`SELECT p.pronargs, p.prosecdef, p.proacl
                             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                            WHERE n.nspname = $1 AND p.proname = 'feedback_account_age_days'`,
        [schema])).rows[0];
      assert.ok(fn, 'feedback_account_age_days does not exist, so the survey gate cannot read the account age');
      assert.equal(Number(fn.pronargs), 0, 'the reader must take NO argument, or it can be asked about another owner');
      assert.equal(fn.prosecdef, true, 'the reader must be SECURITY DEFINER: the learner cannot read "user" itself');
      const acl = String(fn.proacl ?? '');
      assert.ok(!acl.split(',').some((entry) => entry.startsWith('=')), `PUBLIC may execute the reader: ${acl}`);

      const asB = (await asLearner(pools.learner, B, (client) =>
        client.query(`SELECT ${T('feedback_account_age_days')}() AS age`))).rows[0].age;
      assert.ok(Number.isInteger(asB) && asB >= 0, `the reader returned ${asB} for a learner with a real account`);

      // With no owner in the session it must answer nothing rather than pick a row.
      const anonymous = (await pools.learner.query(`SELECT ${T('feedback_account_age_days')}() AS age`)).rows[0].age;
      assert.equal(anonymous, null, 'with no owner set the reader must return NULL, not somebody else\'s age');
    });
  } finally {
    await closePersistent(pools);
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n---- pilot-feedback-migration-check: ${results.length - failed.length}/${results.length} passed ----`);
  for (const [name, ok, detail] of results) if (!ok) console.log(`  FAIL  ${name}: ${detail}`);
  if (failed.length) process.exit(1);
  console.log('all legs passed');
}

await main();
