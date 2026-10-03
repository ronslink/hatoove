/**
 * EXAM-S1 — preparation queries over the learner connection.
 *
 * Every function here takes a client that is ALREADY inside an owner-bound transaction (`settle` in
 * `adapter.mjs`), so the FORCE RLS policies of migration 0023 filter every row as well as the explicit
 * `owner_id` predicates. Another owner's preparation is indistinguishable from an absent one: 404.
 *
 * Credits are keyed (owner, exam). Nothing in this file writes `entitlements`: creating, archiving or
 * resuming a preparation never grants or refills a balance.
 */

import { randomUUID } from 'node:crypto';
import { Fault } from '../owned-api.mjs';
import { entitlementExpired } from './entitlement.mjs';
import { createExamCatalogue, preparationDto } from '../preparation-contract.mjs';
import { readCurrentReleaseEligibility } from './release-eligibility.mjs';

const fail = (status, code) => { throw new Fault(status, code); };
const first = (result) => result.rows[0];

const SELECT_PREPARATION = `SELECT p.id, p.exam_id, x.exam, x.exam_language, p.exam_date, p.state, p.revision,
                                  p.created_at, p.updated_at
                             FROM learner_preparation p JOIN exam_package x ON x.exam_id = p.exam_id`;

/** The owned preparation row, or 404. `lock` takes the row lock the editing paths need. */
export async function resolvePreparation(client, owner, id, { lock = false } = {}) {
  const row = first(await client.query(
    `${SELECT_PREPARATION} WHERE p.id = $1 AND p.owner_id = $2${lock ? ' FOR UPDATE OF p' : ''}`, [id, owner]));
  if (!row) fail(404, 'not_found');
  return row;
}

/** A preparation new practice may be recorded in: owned (404) and active (409 `preparation_archived`). */
export async function requireActivePreparation(client, owner, id) {
  // FOR SHARE: an archive that races this write waits for it, rather than archiving around it.
  const row = first(await client.query(
    `${SELECT_PREPARATION} WHERE p.id = $1 AND p.owner_id = $2 FOR SHARE OF p`, [id, owner]));
  if (!row) fail(404, 'not_found');
  if (row.state !== 'active') fail(409, 'preparation_archived');
  return row;
}

/**
 * The preparation methods of the datastore port. `settle(owner, work, snapshot)` is the adapter's
 * owner-bound transaction; `catalogue` is the server-side package allowlist.
 */
export function preparationMethods({ settle, note = () => {}, catalogue = createExamCatalogue() }) {
  return {
    /** The offered packages: enabled by server configuration AND present in the database. */
    async listExams(owner) {
      note('listExams');
      return settle(owner, async (client) => {
        const rows = (await client.query(
        `SELECT exam_id, exam, exam_language, level FROM exam_package
          WHERE exam_id = ANY($1::text[]) ORDER BY exam_id`, [catalogue.ids])).rows;
        const offered = [];
        for (const row of rows) if ((await readCurrentReleaseEligibility(client, row.exam_id, { catalogue })).eligible)
          offered.push({ exam_id: row.exam_id, exam: row.exam, exam_language: row.exam_language, level: row.level });
        return offered;
      }, true);
    },

    /** Every preparation of the owner, archived history included, oldest first. */
    async listPreparations(owner) {
      note('listPreparations');
      return settle(owner, async (client) => (await client.query(
        `${SELECT_PREPARATION} WHERE p.owner_id = $1 ORDER BY p.created_at, p.id`, [owner])).rows.map(preparationDto));
    },

    async readPreparation(owner, id) {
      note('readPreparation');
      return settle(owner, async (client) => preparationDto(await resolvePreparation(client, owner, id)));
    },

    /** Context for a catalogue or practice read: `{id, exam_id, state}` of an owned preparation, or 404. */
    async resolvePreparation(owner, id) {
      note('resolvePreparation');
      return settle(owner, async (client) => {
        const row = await resolvePreparation(client, owner, id);
        return { id: row.id, exam_id: row.exam_id, state: row.state };
      });
    },

    /**
     * Idempotent: the owner's ACTIVE preparation for the exam is returned unchanged (its date is never
     * overwritten); otherwise one is created. Concurrent duplicates converge on one row through the partial
     * unique index. No balance is touched.
     */
    async createPreparation(owner, examId) {
      note('createPreparation');
      return settle(owner, async (client) => {
        // Returning an existing preparation is resume, even when new admission has closed.
        const existing = first(await client.query(
          `${SELECT_PREPARATION} WHERE p.owner_id = $1 AND p.exam_id = $2 AND p.state = 'active'`, [owner, examId]));
        if (existing) return { created: false, preparation: preparationDto(existing) };
        if (!(await readCurrentReleaseEligibility(client, examId, { catalogue, lock: true })).eligible)
          fail(422, 'exam_unavailable');
        const known = first(await client.query('SELECT 1 FROM exam_package WHERE exam_id = $1', [examId]));
        if (!known) fail(422, 'exam_unavailable');
        const inserted = first(await client.query(
          `INSERT INTO learner_preparation (id, owner_id, exam_id, state, revision)
           VALUES ($1, $2, $3, 'active', 1)
           ON CONFLICT DO NOTHING RETURNING id`, [randomUUID(), owner, examId]));
        const row = first(await client.query(
          `${SELECT_PREPARATION} WHERE p.owner_id = $1 AND p.exam_id = $2 AND p.state = 'active'`, [owner, examId]));
        if (!row) fail(409, 'preparation_conflict');
        return { created: Boolean(inserted), preparation: preparationDto(row) };
      });
    },

    /**
     * Revision-guarded edit of date and/or state. A stale revision writes nothing and returns the current
     * DTO with 409. Resuming an archived preparation while another is active for the same exam is refused.
     * The legacy `learner_settings.exam_date` is never written.
     */
    async updatePreparation(owner, id, expectedRevision, patch) {
      note('updatePreparation');
      return settle(owner, async (client) => {
        const current = await resolvePreparation(client, owner, id, { lock: true });
        if (Number(current.revision) !== expectedRevision) {
          const error = new Fault(409, 'preparation_conflict');
          error.current = preparationDto(current);
          throw error;
        }
        if (patch.state === 'active' && current.state !== 'active') {
          const other = first(await client.query(
            `SELECT 1 FROM learner_preparation WHERE owner_id = $1 AND exam_id = $2 AND state = 'active' AND id <> $3`,
            [owner, current.exam_id, id]));
          if (other) fail(409, 'active_preparation_exists');
        }
        try {
          await client.query(
            `UPDATE learner_preparation
                SET exam_date = CASE WHEN $3::boolean THEN $4::date ELSE exam_date END,
                    state = COALESCE($5, state),
                    revision = revision + 1,
                    updated_at = now()
              WHERE id = $1 AND owner_id = $2`,
            [id, owner, patch.examDate !== undefined, patch.examDate ?? null, patch.state ?? null]);
        } catch (error) {
          if (error && error.code === '23505') fail(409, 'active_preparation_exists');
          throw error;
        }
        return preparationDto(await resolvePreparation(client, owner, id));
      });
    },

    /** The exam balance behind a preparation. Absent is zero, never a new grant. */
    async readCredits(owner, id) {
      note('readCredits');
      return settle(owner, async (client) => {
        const prep = await resolvePreparation(client, owner, id);
        const row = first(await client.query(
          'SELECT allowance, used, reserved, expires_at FROM entitlements WHERE owner_id = $1 AND exam_id = $2',
          [owner, prep.exam_id]));
        const allowance = row ? Number(row.allowance) : 0;
        const used = row ? Number(row.used) : 0;
        const reserved = row ? Number(row.reserved) : 0;
        return { examId: prep.exam_id, allowance, used, reserved,
          expiresAt: row?.expires_at == null ? null : new Date(row.expires_at).toISOString(),
          available: entitlementExpired(row) ? 0 : Math.max(0, allowance - used - reserved) };
      }, true);
    },
  };
}
