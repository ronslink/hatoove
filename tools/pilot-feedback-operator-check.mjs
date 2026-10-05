/*
 * PILOT-FEEDBACK-01 (slice FB-D) — the operator surface, proved rather than asserted.
 *
 * WHY THIS IS NOT PART OF THE MIGRATION CHECK. That check proves what `0049` enforces for a LEARNER. This one is
 * about the role that reads across owners, and the properties that matter are of a different kind:
 *
 *   * the operator holds EXECUTE on five functions and NO table privilege — the contract's "must not reuse the
 *     migration role", which is a privilege fact and not a convention;
 *   * the update really is BOUNDED. A SECURITY DEFINER function owned by the migration role IS the table owner,
 *     so FORCE row-level security does not bound what it writes; the three columns in its UPDATE are the bound,
 *     and `0049`'s identity trigger is the second line of defence. Both are proved here by changing something
 *     else and observing the refusal;
 *   * the schema USAGE grant exists. Its absence is invisible to a reader — the function grants look complete —
 *     and it makes every call fail with `permission denied for schema`. The first version of `0050` had exactly
 *     that bug, so leg 10 is a regression guard for it.
 *
 * Needs a DISPOSABLE database with OWNAPI_PG_ALLOW=1. Synthetic rows only; the check cleans up after itself.
 *
 * MUTATION PROOFS — each applied to the INSTALLED schema, the check re-run, the mutation reverted and the
 * restore's exit code checked:
 *   M1 GRANT SELECT to the operator      -> legs 1, 3     (the "no table privilege" claim)
 *   M2 DROP the owner-read policy        -> legs 3, 4, 5  (FORCE RLS fences the definer function)
 *   M3 DROP the identity trigger         -> legs 6, 8     (the second line of defence, and the clock)
 *
 * Usage: node tools/pilot-feedback-operator-check.mjs   (exit 0 when every leg passes)
 */

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';

import { persistentConfig, persistentRolePool, provisionPersistent, closePersistent } from '../server/owned-postgres/provision.mjs';

const FUNCTION_SIGNATURES = [
  'operator_feedback_list(uuid,text,text,timestamptz)',
  'operator_set_feedback_status(uuid,text,text)',
  'operator_purge_feedback(integer)',
  'operator_seed_survey_round(text,timestamptz,timestamptz,jsonb,integer)',
  'operator_feedback_screenshot(uuid)',
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

const refusal = async (client, sql, params = []) => {
  try { await client.query(sql, params); return null; } catch (error) { return error.code ?? error.message; }
};

async function main() {
  const config = persistentConfig();
  const schema = config.schema;
  const ident = (value) => `"${String(value).replaceAll('"', '""')}"`;
  const T = (table) => `${ident(schema)}.${ident(table)}`;
  const operatorRole = config.roles.operator;

  // The operator pool exactly as the CLI builds it: one connection, that role, nothing wider.
  const operator = persistentRolePool(config, 'operator', { max: 1 });
  // The bootstrap superuser, used ONLY to seed synthetic rows and to inspect — never as the subject of a leg.
  // It comes from `provisionPersistent` because `persistentRolePool` accepts only the ROLE set, and `admin` is
  // the bootstrap credential rather than a schema role.
  const pools = await provisionPersistent({ config });
  const admin = pools.admin;
  const q = async (sql, params = []) => (await admin.query(sql, params)).rows;

  const stamp = Date.now().toString(36);
  const A = `user-op-a-${stamp}`;
  const B = `user-op-b-${stamp}`;
  const seeded = [];

  try {
    /* ---------------------------------------------------------------- privilege facts */
    await check('1. the operator has EXECUTE on the five functions and NO table privilege', async () => {
      for (const signature of FUNCTION_SIGNATURES) {
        const held = (await q(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS held`,
          [operatorRole, `${schema}.${signature}`]))[0].held;
        assert.equal(held, true, `the operator cannot execute ${signature}`);
      }
      for (const table of ['pilot_feedback', 'pilot_feedback_screenshot', 'survey_round']) {
        for (const privilege of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
          const held = (await q('SELECT has_table_privilege($1, $2, $3) AS held',
            [operatorRole, `${schema}.${table}`, privilege]))[0].held;
          assert.equal(held, false, `the operator holds ${privilege} on ${table}: it must reach rows only through the functions`);
        }
      }
    });

    await check('10. the operator has USAGE on the schema (the bug the first 0050 shipped)', async () => {
      // Without this every function call answers `permission denied for schema`, and the grant list still LOOKS
      // complete — which is why it is a leg rather than a code review note.
      const held = (await q('SELECT has_schema_privilege($1, $2, $3) AS held',
        [operatorRole, schema, 'USAGE']))[0].held;
      assert.equal(held, true, 'the operator cannot use the schema, so no operator function is callable');
    });

    await check('2. PUBLIC cannot execute any operator function', async () => {
      for (const signature of FUNCTION_SIGNATURES) {
        const acl = (await q(`SELECT p.proacl::text AS acl FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                               WHERE n.nspname = $1 AND p.proname = $2`, [schema, signature.split('(')[0]]))[0].acl ?? '';
        assert.ok(!acl.split(',').some((entry) => entry.startsWith('=')), `${signature} is executable by PUBLIC: ${acl}`);
      }
    });

    /* ---------------------------------------------------------------- seed synthetic rows as the owner */
    for (const [id, email] of [[A, `${A}@example.invalid`], [B, `${B}@example.invalid`]]) {
      await q(`INSERT INTO ${T('user')}(id, name, email, "emailVerified", "createdAt", "updatedAt")
               VALUES ($1, $2, $3, true, now(), now())`, [id, `Synthetic ${id.slice(-4)}`, email]);
    }
    const roundId = `op-check-${stamp}`;
    await q(`INSERT INTO ${T('survey_round')}(round_id, opens_at, closes_at, questions, min_account_age_days)
             VALUES ($1, now() - interval '1 day', now() + interval '13 days', $2::jsonb, 0)`,
      [roundId, JSON.stringify([{ id: 'ease', type: 'scale', min: 1, max: 5 }])]);

    const insertReport = async (owner, body, ageDays = 0) => {
      const id = randomUUID();
      await q(`INSERT INTO ${T('pilot_feedback')}
                 (feedback_id, owner_id, kind, category, body, route, interface_language, app_version, created_at)
               VALUES ($1,$2,'report','bug',$3,'heute','de','unknown', now() - make_interval(days => $4))`,
        [id, owner, body, ageDays]);
      seeded.push(id);
      return id;
    };
    const aReport = await insertReport(A, 'Die Aufnahme bricht ab.');
    const bReport = await insertReport(B, 'Ein anderer Fehler.');
    await q(`INSERT INTO ${T('pilot_feedback')}
               (feedback_id, owner_id, kind, route, interface_language, app_version, survey_round, survey_answers)
             VALUES ($1,$2,'survey','heute','de','unknown',$3,$4::jsonb)`,
      [randomUUID(), A, roundId, JSON.stringify({ ease: 4 })]);

    /* ---------------------------------------------------------------- the read path */
    await check('3. the operator cannot read the table directly, and the function works', async () => {
      const direct = await refusal(operator, `SELECT count(*) FROM ${T('pilot_feedback')}`);
      assert.ok(direct, 'the operator read pilot_feedback directly');
      assert.match(String(direct), /42501|permission denied/i, `expected a privilege refusal, got ${direct}`);
      const rows = (await operator.query('SELECT count(*)::int AS n FROM operator_feedback_list()')).rows;
      assert.ok(rows[0].n >= 3, `the operator function returned ${rows[0].n} rows, expected the seeded reports`);
    });

    await check('4. the reader crosses owners and RESOLVES the reporter', async () => {
      const rows = (await operator.query('SELECT * FROM operator_feedback_list($1,$2,$3,$4)', [null, null, null, null])).rows;
      const mine = rows.filter((row) => seeded.includes(row.feedback_id));
      assert.equal(mine.length, 2, `expected two seeded reports, saw ${mine.length}`);
      const reporterA = mine.find((row) => row.feedback_id === aReport);
      assert.ok(reporterA.reporter_name && reporterA.reporter_email, "A's report has no reporter resolved");
      assert.equal(reporterA.reporter_email, `${A}@example.invalid`);
      const reporterB = mine.find((row) => row.feedback_id === bReport);
      assert.equal(reporterB.reporter_email, `${B}@example.invalid`,
        "one call must resolve BOTH owners, or the reader is not reading across owners");
    });

    await check('4b. a report cannot outlive its account, so the reader\'s LEFT JOIN is defensive', async () => {
      /*
       * THE ORPHAN BRANCH IS NOT TESTABLE, AND SAYING SO IS THE POINT. The first version of this check tried to
       * build an orphaned report — delete the account, keep the row — and could not: the foreign key refuses.
       * So `operator_feedback_list`'s LEFT JOIN and the CLI's "account removed" branch are DEFENSIVE, and a leg
       * that claimed to exercise them would be claiming something false. What is provable is the reason: the
       * account cannot be removed while a report points at it.
       */
      const code = await refusal(admin, `DELETE FROM ${T('user')} WHERE id = $1`, [A]);
      assert.ok(code, 'a user with a report was deleted, so the orphan state IS reachable and the LEFT JOIN must be exercised');
      assert.match(String(code), /23503|foreign key|violates/i, `expected a foreign-key refusal, got ${code}`);
    });

    /* ---------------------------------------------------------------- the write path, bounded */
    await check('5. the update moves exactly three columns and nothing else', async () => {
      const before = (await q(`SELECT * FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [aReport]))[0];
      const [result] = (await operator.query('SELECT operator_set_feedback_status($1,$2,$3) AS ok',
        [aReport, 'triaged', 'Reproduced on HV2.'])).rows;
      assert.equal(result.ok, true, 'the bounded update reported no row');
      const after = (await q(`SELECT * FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [aReport]))[0];
      assert.equal(after.status, 'triaged');
      assert.equal(after.operator_note, 'Reproduced on HV2.');
      assert.ok(after.handled_at, 'handled_at must be set when a status is applied');
      const moved = Object.keys(after).filter((key) => String(after[key]) !== String(before[key])).sort();
      assert.deepEqual(moved, ['handled_at', 'operator_note', 'status'],
        `the update moved ${moved.join(', ')}: it is not bounded to the three triage columns`);
    });

    await check('20. a status change with no note PRESERVES the note already there', async () => {
      /*
       * `operator_note = p_note` ERASED the note. An independent reviewer ran `set-status <id> triaged` with no
       * `--note` and the note written on the earlier triage was silently gone — a status change and a note change
       * are different intents, and the caller who wants only the first should not have to re-send the second.
       * Leg 5 above writes a note, so this leg inherits one to preserve.
       */
      const before = (await q(`SELECT operator_note FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [aReport]))[0];
      assert.equal(before.operator_note, 'Reproduced on HV2.', 'leg 5 must leave a note for this leg to preserve');
      await operator.query('SELECT operator_set_feedback_status($1,$2,$3)', [aReport, 'fixed', null]);
      const kept = (await q(`SELECT status, operator_note FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [aReport]))[0];
      assert.equal(kept.status, 'fixed', 'the status must still change');
      assert.equal(kept.operator_note, 'Reproduced on HV2.',
        'a status-only update erased the note: `p_note` must not overwrite it with NULL');
      // An EMPTY STRING is not NULL, so clearing a note stays possible on purpose rather than by accident.
      await operator.query('SELECT operator_set_feedback_status($1,$2,$3)', [aReport, 'triaged', '']);
      const cleared = (await q(`SELECT operator_note FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [aReport]))[0];
      assert.equal(cleared.operator_note, '', 'an explicit empty note must still clear it');
    });

    await check('6. the identity trigger refuses a rewrite of the report text, EVEN by the owner', async () => {
      // The second line of defence: the function cannot reach `body`, and neither can a direct owner UPDATE.
      const code = await refusal(admin, `UPDATE ${T('pilot_feedback')} SET body = 'tampered' WHERE feedback_id = $1`, [aReport]);
      assert.ok(code, 'the report text was rewritten: the identity trigger did not fire');
      assert.match(String(code), /23514|identity_immutable/i, `expected the identity refusal, got ${code}`);
      const row = (await q(`SELECT body FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [aReport]))[0];
      assert.equal(row.body, 'Die Aufnahme bricht ab.', 'the body changed despite the refusal');
    });

    await check('7. the update function validates its own inputs', async () => {
      for (const [label, params] of [
        ['an unknown status', [aReport, 'approved', null]],
        ['a null status', [aReport, null, null]],
        ['a note over 1000 characters', [aReport, 'triaged', 'x'.repeat(1001)]],
      ]) {
        const code = await refusal(admin, 'SELECT operator_set_feedback_status($1,$2,$3)', params);
        assert.ok(code, `${label} was accepted by the bounded update`);
      }
    });

    /* ---------------------------------------------------------------- retention and the seed */
    await check('8. purge is bounded, and the retention clock cannot be backdated', async () => {
      /*
       * A ROW OLD ENOUGH TO PURGE CANNOT BE CONSTRUCTED, only waited for: `0049`'s trigger overwrites
       * `created_at` with `now()` on INSERT and the identity guard refuses to change it afterwards, so the
       * server owns the clock and a caller cannot age a report into someone else's retention window. The first
       * version of this leg inserted a 40-day-old row and asserted purge removed it — it removed nothing,
       * because the row was not old at all, and the leg was measuring the trigger rather than the purge.
       *
       * What IS provable now: the clock is server-owned, a live row survives a purge, and the window is
       * validated. That purge eventually deletes is a consequence of the same statement, not a separate claim.
       */
      const id = await insertReport(B, 'Nicht alt genug.', 40);
      const stored = (await q(`SELECT EXTRACT(EPOCH FROM (now() - created_at))::int AS age_seconds
                                 FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [id]))[0];
      assert.ok(stored.age_seconds < 5,
        `created_at was backdated by the caller (age ${stored.age_seconds}s): the server must own the clock`);

      const [result] = (await operator.query('SELECT operator_purge_feedback($1) AS removed', [30])).rows;
      assert.equal(result.removed, 0, 'purge removed a report inside the retention window');
      const kept = (await q(`SELECT count(*)::int AS n FROM ${T('pilot_feedback')} WHERE feedback_id = $1`, [id]))[0].n;
      assert.equal(kept, 1, 'purge removed a row it should have kept');
      for (const days of [0, -1, null]) {
        const code = await refusal(admin, 'SELECT operator_purge_feedback($1)', [days]);
        assert.ok(code, `purge accepted the retention window ${days}`);
      }
    });

    await check('9. the seed writes once and leaves the question set frozen', async () => {
      const second = (await operator.query(
        'SELECT operator_seed_survey_round($1,$2,$3,$4::jsonb,$5) AS seeded',
        [roundId, new Date(), new Date(Date.now() + 86400000), JSON.stringify([{ id: 'other', type: 'scale', min: 1, max: 5 }]), 7])).rows[0];
      assert.equal(second.seeded, false, 'a second seed for the same round reported success');
      const questions = (await q(`SELECT questions FROM ${T('survey_round')} WHERE round_id = $1`, [roundId]))[0].questions;
      assert.deepEqual(questions, [{ id: 'ease', type: 'scale', min: 1, max: 5 }],
        'the second seed changed the frozen question set, which would silently re-mean stored answers');
    });

    await check('11. the screenshot reader returns the bytes for one report only', async () => {
      const bytes = Buffer.from('RIFF0000WEBPVP8 ', 'binary');
      const digest = createHash('sha256').update(bytes).digest('hex');
      await q(`INSERT INTO ${T('pilot_feedback_screenshot')}(feedback_id, owner_id, mime_type, bytes, width, height, sha256)
               VALUES ($1,$2,'image/webp',$3,1200,800,$4)`, [aReport, A, bytes, digest]);
      const rows = (await operator.query('SELECT * FROM operator_feedback_screenshot($1)', [aReport])).rows;
      assert.equal(rows.length, 1, 'the screenshot reader did not return exactly one image');
      assert.equal(rows[0].bytes.length, bytes.length);
      const none = (await operator.query('SELECT * FROM operator_feedback_screenshot($1)', [bReport])).rows;
      assert.equal(none.length, 0, "the screenshot reader returned another report's image");
    });

    await check('21. the owner policies grant SELECT and the bounded UPDATE — and NOT insert or delete', async () => {
      /*
       * A POLICY WITH NO `FOR` IS `FOR ALL`, and `ALL` includes INSERT and DELETE: the first version of `0051`
       * let the schema owner insert a report attributed to ANY learner and delete any report, neither of which
       * this feature does. An independent reviewer listed it as a should-fix. The UPDATE policy is REQUIRED —
       * the bounded update is SECURITY DEFINER owned by this role and `0049` FORCEs RLS, so the fence applies to
       * the owner too — while INSERT and DELETE are simply not needed. This leg is what keeps that distinction
       * from being lost to a later `FOR ALL` convenience edit.
       *
       * IT MUST RUN INSIDE THE TRY. A first attempt placed it after the `finally` that closes the pools and it
       * failed with "Cannot use a pool after calling end on the pool" — a leg that cannot query proves nothing,
       * and this is the second time in this slice a leg has been put where it cannot observe what it claims to.
       */
      const rows = await q(`SELECT policyname, cmd FROM pg_policies
                             WHERE schemaname = $1 AND policyname LIKE 'operator%' ORDER BY policyname`, [schema]);
      const commands = rows.map((row) => row.cmd).sort();
      assert.deepEqual(commands, ['SELECT', 'SELECT', 'UPDATE'],
        `the owner policies grant ${commands.join('/')} — expected two SELECTs (report, screenshot) and one UPDATE (the bounded triage)`);
      assert.ok(!commands.includes('ALL'), 'a FOR ALL policy silently grants INSERT and DELETE');
      assert.ok(!commands.includes('INSERT'), 'the operator must never create a report attributed to a learner');
      assert.ok(!commands.includes('DELETE'), 'the operator must never delete a learner\'s report');
    });
  } finally {
    // Clean up the synthetic rows. The round is left: `0049` makes a round undeletable by design, and that is
    // itself one of the migration check's legs.
    await q(`DELETE FROM ${T('pilot_feedback')} WHERE owner_id = ANY($1::text[])`, [[A, B]]).catch(() => {});
    await q(`DELETE FROM ${T('user')} WHERE id = ANY($1::text[])`, [[A, B]]).catch(() => {});
    await operator.end().catch(() => {});
    await closePersistent(pools);
  }

  const failed = results.filter(([, ok]) => !ok);
  console.log(`\n---- pilot-feedback-operator-check: ${results.length - failed.length}/${results.length} passed ----`);
  for (const [name, , detail] of failed) console.log(`  FAIL  ${name}: ${detail}`);
  if (failed.length) process.exit(1);
  console.log('all legs passed');
}

await main();
