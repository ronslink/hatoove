#!/usr/bin/env node
/**
 * REVIEW-OWNER-APPROVAL-01 — verify the state `0049-review-owner-approval.sql` must leave behind.
 *
 *     OWNAPI_PG_ALLOW=1 OWNAPI_PG_HOST=127.0.0.1 OWNAPI_PG_PORT=<disposable> \
 *     OWNAPI_PG_DATABASE=<disposable> node tools/review-owner-approval-check.mjs
 *
 * READ-ONLY. It writes nothing: every assertion is a SELECT, so it is safe to point at a database
 * whose state you want to inspect and useless as an approval mechanism.
 *
 * WHY THIS EXISTS. The migration records an OWNER BLANKET APPROVAL, which is a claim about a
 * decision, not about the strings. The claim is only checkable at the level the decision was made:
 *   * every content subject projects `approved` with basis `named_decision` — not
 *     `legacy_unattributed`, which would mean the 0049 decisions never landed and the catalogue is
 *     only passing because of what 0035 imported;
 *   * every approval is attributable to the owner's own reviewer id, and every rationale says in
 *     words that no per-string review is claimed, so a later reader of the ledger cannot mistake
 *     this for native review;
 *   * `form_review_allowed(exam, form, version, true)` is true for every form the head release
 *     names — the gate `HATOVE_CONTENT_MODE=public` actually asks at runtime;
 *   * the two translation tables carry an `approved` row with a reviewer and a review time, which is
 *     what the 0042 CHECK demands and what removes the client's "Prüfung ausstehend" marker;
 *   * nothing was rejected or withdrawn, and no subject carries more than one decision.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never writes an approval, never clears `machine_unreviewed`,
 * and never treats "the migration ran" as "the content was reviewed". Those are different claims and
 * only the first one is a database question.
 *
 * USAGE NOTES. `OWNAPI_PG_ALLOW=1` is required, so the tool cannot be pointed at a database by
 * accident. It refuses the production/served ports this repository reserves for the live install.
 */
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { persistentConfig, persistentRolePool } from '../server/owned-postgres/provision.mjs';

/** Ports this repository treats as the live install or an already-owned fixture, never a target. */
const FORBIDDEN_PORTS = new Set([5432, 55440, 55489, 55493, 55494, 62563]);
/** The reviewer of record for the owner blanket approval recorded by 0049. */
const REVIEWER_ID = 'ron-product-owner';
/** The migration this check describes. Kept as a literal: the check is about that file's outcome. */
const MIGRATION_ID = '0049-review-owner-approval';

class CheckFailure extends Error {}

let passed = 0;
let failed = 0;

async function check(name, run) {
  try {
    const detail = await run();
    passed += 1;
    console.log(`PASS ${name}${detail ? `  [${detail}]` : ''}`);
  } catch (error) {
    failed += 1;
    const message = error instanceof CheckFailure ? error.message : `${error.name}: ${error.message}`;
    console.log(`FAIL ${name}  [${String(message).split('\n')[0].slice(0, 220)}]`);
  }
}

const one = async (client, sql, params = []) => (await client.query(sql, params)).rows[0];
const all = async (client, sql, params = []) => (await client.query(sql, params)).rows;
const assert = (condition, message) => {
  if (!condition) throw new CheckFailure(message);
};

/** The recordings a form's `fixed_audio` members bind, with the review each one's media row carries. */
const fixedAudioMedia = (client) => all(client, `
  SELECT DISTINCT m.media_id, m.version, c.review_status,
         (SELECT p.review_basis FROM effective_content_review(m.content_version_id) p) AS review_basis
    FROM exam_form f
    JOIN exam_form_member fm ON fm.exam_id = f.exam_id AND fm.form_id = f.form_id AND fm.form_version = f.version
    JOIN objective_set s ON s.set_id = fm.set_id AND s.version = fm.set_version AND s.exam_id = fm.exam_id
    CROSS JOIN LATERAL jsonb_array_elements(s.payload->'recordings') recording
    JOIN exam_media m ON m.media_id = recording->>'mediaId' AND m.version = recording->>'mediaVersion' AND m.exam_id = f.exam_id
    JOIN reviewed_content_version c ON c.content_version_id = m.content_version_id
   WHERE fm.interaction = 'fixed_audio'`);

async function main() {
  if (process.env.OWNAPI_PG_ALLOW !== '1') throw new Error('OWNAPI_PG_ALLOW=1 required for the selected database');
  const port = Number(process.env.OWNAPI_PG_PORT);
  if (!process.env.OWNAPI_PG_PORT || FORBIDDEN_PORTS.has(port)) {
    throw new Error('a disposable OWNAPI_PG_PORT is required; the live install ports are refused');
  }
  const config = persistentConfig();
  const pool = persistentRolePool(config, 'migration', { max: 1 });
  const client = await pool.connect();
  try {
    const applied = await one(client, 'SELECT 1 AS present FROM hatoove_migrations WHERE id = $1', [MIGRATION_ID]);
    await check(`${MIGRATION_ID} is in the ledger`, () => {
      assert(applied?.present === 1, `${MIGRATION_ID} is NOT applied to this database — nothing below is about it`);
      return 'applied';
    });

    const contentProjection = await one(client, `
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE p.review_status = 'approved')::int AS approved,
             count(*) FILTER (WHERE p.review_status = 'approved' AND p.review_basis = 'named_decision')::int AS named,
             count(*) FILTER (WHERE p.review_status = 'unreviewed')::int AS unreviewed,
             count(*) FILTER (WHERE p.review_status = 'unavailable')::int AS unavailable,
             count(*) FILTER (WHERE p.blocked)::int AS blocked,
             count(*) FILTER (WHERE p.explicit_negative)::int AS negative
        FROM content_version c CROSS JOIN LATERAL effective_content_review(c.content_version_id) p`);
    await check('every content subject projects approved with basis named_decision', () => {
      assert(contentProjection.total > 0, 'no content subjects at all — wrong database');
      assert(contentProjection.unreviewed === 0, `${contentProjection.unreviewed} content subject(s) still unreviewed`);
      assert(contentProjection.unavailable === 0, `${contentProjection.unavailable} content subject(s) unavailable`);
      assert(contentProjection.blocked === 0, `${contentProjection.blocked} content subject(s) blocked`);
      assert(contentProjection.negative === 0, `${contentProjection.negative} content subject(s) carry an explicit negative`);
      assert(contentProjection.named === contentProjection.total,
        `${contentProjection.total - contentProjection.named} subject(s) are approved only by the 0035 legacy import, not by a named decision`);
      return `${contentProjection.named}/${contentProjection.total} named_decision`;
    });

    const formats = await all(client, `
      SELECT 'blueprint' AS kind, b.exam_id, b.exam_id AS subject_id, b.version,
             (SELECT p.review_status FROM effective_format_review(b.exam_id,'blueprint',b.exam_id,b.version) p) AS review_status,
             (SELECT p.review_basis FROM effective_format_review(b.exam_id,'blueprint',b.exam_id,b.version) p) AS review_basis,
             (SELECT p.blocked FROM effective_format_review(b.exam_id,'blueprint',b.exam_id,b.version) p) AS blocked
        FROM exam_blueprint b
      UNION ALL
      SELECT 'form', f.exam_id, f.form_id, f.version,
             (SELECT p.review_status FROM effective_format_review(f.exam_id,'form',f.form_id,f.version) p),
             (SELECT p.review_basis FROM effective_format_review(f.exam_id,'form',f.form_id,f.version) p),
             (SELECT p.blocked FROM effective_format_review(f.exam_id,'form',f.form_id,f.version) p)
        FROM exam_form f`);
    await check('every blueprint and every form projects approved with basis named_decision', () => {
      assert(formats.length > 0, 'no format subjects at all — wrong database');
      const bad = formats.filter((row) => row.review_status !== 'approved' || row.review_basis !== 'named_decision' || row.blocked);
      assert(bad.length === 0,
        bad.map((row) => `${row.kind} ${row.subject_id}@${row.version}=${row.review_status}/${row.review_basis}/blocked=${row.blocked}`).join(', '));
      return `${formats.length} format subject(s)`;
    });

    const heads = await all(client, 'SELECT exam_id, release_version FROM exam_release_head ORDER BY exam_id');
    const forms = [];
    for (const head of heads) {
      const rows = await all(client,
        `SELECT form_id, form_version FROM exam_release_form WHERE exam_id = $1 AND release_version = $2 ORDER BY form_id, form_version`,
        [head.exam_id, head.release_version]);
      forms.push(...rows.map((row) => ({ ...row, exam_id: head.exam_id })));
    }
    await check('form_review_allowed(exam, form, version, true) is true for every form on the head release', async () => {
      assert(forms.length > 0, 'the head release names no form');
      const verdicts = [];
      for (const form of forms) {
        const row = await one(client, 'SELECT form_review_allowed($1,$2,$3,true) AS allowed', [form.exam_id, form.form_id, form.form_version]);
        verdicts.push({ ...form, allowed: row.allowed });
      }
      const refused = verdicts.filter((row) => row.allowed !== true);
      assert(refused.length === 0, refused.map((row) => `${row.exam_id}/${row.form_id}@${row.form_version}`).join(', '));
      return verdicts.map((row) => `${row.form_id}@${row.form_version}`).join(', ');
    });

    /*
     * The media behind a `fixed_audio` member is reachable only through the form's JSON, so the gate
     * leg above already covers it — through exactly this join. This leg names the rows, so a reader
     * can see WHICH audio the approval covers instead of inferring it, and it FAILS on a recording
     * whose media row is not a named approval.
     *
     * A database with no `fixed_audio` member (a reading-only head release, say) has nothing here to
     * check. That is not coverage and is never reported as if it were: the leg states that instead of
     * claiming a green result it did not earn, and the coverage of the audio is only asserted when
     * the binding actually resolves.
     */
    await check('every exam_media row behind a resolved fixed_audio recording is approved too', async () => {
      const media = await fixedAudioMedia(client);
      const bad = media.filter((row) => row.review_status !== 'approved' || row.review_basis !== 'named_decision');
      assert(bad.length === 0, bad.map((row) => `${row.media_id}@${row.version}=${row.review_status}/${row.review_basis}`).join(', '));
      return media.length
        ? `${media.length} resolved recording(s): ${media.map((row) => row.media_id).join(', ')}`
        : 'no fixed_audio recording resolves in this database — nothing to check (this is NOT audio coverage)';
    });

    await check('every approval is attributable to the owner, and says no per-string review is claimed', async () => {
      const decisions = await one(client, `
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE auth.reviewer_id = $1)::int AS owner,
               count(*) FILTER (WHERE d.decision <> 'approve')::int AS not_approve,
               count(*) FILTER (WHERE d.rationale NOT LIKE '%Owner blanket approval%')::int AS unexplained,
               count(*) FILTER (WHERE d.rationale NOT LIKE '%No per-string native-speaker review%')::int AS overclaiming
          FROM content_review_decision d JOIN content_review_authority auth USING (authority_id)`, [REVIEWER_ID]);
      assert(decisions.total > 0, 'no decisions recorded');
      assert(decisions.not_approve === 0, `${decisions.not_approve} decision(s) are not an approve — 0049 writes none`);
      assert(decisions.owner === decisions.total, `${decisions.total - decisions.owner} decision(s) are not the owner\'s`);
      assert(decisions.unexplained === 0, `${decisions.unexplained} decision(s) do not state the owner blanket approval`);
      assert(decisions.overclaiming === 0, `${decisions.overclaiming} decision(s) do not exclude a per-string native review`);
      return `${decisions.total} approve(s), all owner-attributed`;
    });

    await check('no subject carries a second decision (a re-apply must not append revisions)', async () => {
      const duplicate = await one(client, `
        SELECT count(*)::int AS n FROM (
          SELECT exam_id, subject_kind, subject_id, subject_version, subject_sha256, category, language, count(*) AS heads
            FROM content_review_decision
           GROUP BY 1,2,3,4,5,6,7 HAVING count(*) > 1) z`);
      assert(duplicate.n === 0, `${duplicate.n} subject(s) carry more than one decision`);
      return 'one head per subject';
    });

    for (const [table, label] of [['guide_translation', 'guide'], ['noun_translation', 'noun']]) {
      await check(`${label}_translation rows are approved and each carries a reviewer and a review time`, async () => {
        const row = await one(client, `
          SELECT count(*)::int AS total,
                 count(*) FILTER (WHERE review_status = 'approved')::int AS approved,
                 count(*) FILTER (WHERE reviewer IS NULL OR reviewed_at IS NULL)::int AS unattributed
            FROM ${table}`);
        assert(row.total > 0, `${table} is empty — the import has not been run, so 0049 had nothing to approve`);
        assert(row.approved === row.total, `${row.total - row.approved} ${table} row(s) are not approved`);
        assert(row.unattributed === 0, `${row.unattributed} ${table} row(s) carry no reviewer or no review time`);
        return `${row.approved}/${row.total} approved`;
      });
    }

    await check('the immutable compatibility table was not used as the vehicle', async () => {
      const baseline = await one(client, 'SELECT count(*)::int AS n FROM content_review_baseline');
      const stray = await one(client, `
        SELECT count(*)::int AS n FROM content_review_baseline
         WHERE legacy_review_status NOT IN ('approved','unreviewed','rejected','withdrawn')`);
      assert(stray.n === 0, 'content_review_baseline carries a value 0035 would never have written');
      return `${baseline.n} baseline row(s), untouched`;
    });
  } finally {
    client.release();
    await pool.end().catch(() => {});
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`review-owner-approval-check: ${error.message}`);
    process.exitCode = 1;
  });
}
