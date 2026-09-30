import { randomUUID } from 'node:crypto';
export class Fault extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new Fault(status, code); };
const row = result => result.rows[0];
export function store(pool) {
  async function tx(fn) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const value = await fn(c); await c.query('COMMIT'); return value; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  async function owned(c, owner, id) {
    const a = row(await c.query('SELECT * FROM attempts WHERE id=$1 AND owner_id=$2 FOR UPDATE', [id, owner]));
    if (!a || a.deleted_at) fail(404, 'not_found');
    return a;
  }
  async function draft(c, id) {
    return row(await c.query('SELECT revision,text FROM drafts WHERE attempt_id=$1', [id]));
  }
  async function reapExpired() {
    const expired = await pool.query(`SELECT id,owner_id FROM jobs WHERE status='running'
      AND tries>=3 AND lease_until<clock_timestamp()`);
    for (const job of expired.rows) await tx(async c => {
      await c.query('SELECT owner_id FROM entitlements WHERE owner_id=$1 FOR UPDATE', [job.owner_id]);
      const result = await c.query(`UPDATE jobs SET status='failed',failure_code='retry_exhausted',lease_token=NULL,lease_until=NULL
        WHERE id=$1 AND status='running' AND tries>=3 AND lease_until<clock_timestamp() RETURNING id`, [job.id]);
      if (result.rowCount) await c.query('UPDATE entitlements SET reserved=reserved-1 WHERE owner_id=$1', [job.owner_id]);
    });
  }
  return {
    async create(owner, parent = null) {
      return tx(async c => {
        if (parent) {
          const p = row(await c.query(`SELECT a.id FROM submissions s JOIN attempts a ON a.id=s.attempt_id
            WHERE s.id=$1 AND s.owner_id=$2 AND a.deleted_at IS NULL FOR UPDATE OF a`, [parent, owner]));
          if (!p) fail(404, 'not_found');
        }
        const id = randomUUID();
        await c.query(`INSERT INTO attempts(id,owner_id,task_version,rubric_version,parent_submission_id)
          VALUES($1,$2,'synthetic-writing-v1','formative-fixture-v1',$3)`, [id, owner, parent]);
        await c.query('INSERT INTO drafts VALUES($1,1,\'\')', [id]);
        return { id, revision: 1, text: '' };
      });
    },
    async read(owner, id) {
      return tx(async c => { const a = await owned(c, owner, id); return { ...a, ...await draft(c, id) }; });
    },
    async save(owner, id, expectedRevision, text) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof text !== 'string' || text.length > 12000)
        fail(422, 'invalid_draft');
      return tx(async c => {
        await owned(c, owner, id);
        const current = await draft(c, id);
        if (current.revision !== expectedRevision) fail(409, 'draft_conflict');
        const submitted = row(await c.query('SELECT id FROM submissions WHERE attempt_id=$1', [id]));
        if (submitted) fail(409, 'revision_required');
        return row(await c.query('UPDATE drafts SET revision=revision+1,text=$2 WHERE attempt_id=$1 RETURNING revision,text', [id, text]));
      });
    },
    async submit(owner, id, expectedRevision, eventId) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof eventId !== 'string' ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(eventId)) fail(422, 'invalid_submission');
      return tx(async c => {
        // Serialize account idempotency and allowance, always before attempt locking.
        const ent = row(await c.query('SELECT * FROM entitlements WHERE owner_id=$1 FOR UPDATE', [owner]));
        const a = await owned(c, owner, id);
        const prior = row(await c.query('SELECT * FROM submissions WHERE owner_id=$1 AND event_id=$2', [owner, eventId]));
        if (prior) {
          if (prior.attempt_id !== id || prior.draft_revision !== expectedRevision) fail(409, 'idempotency_conflict');
          return { submissionId: prior.id, replay: true };
        }
        const d = await draft(c, id);
        if (d.revision !== expectedRevision) fail(409, 'draft_conflict');
        if (!d.text.trim()) fail(422, 'empty_submission');
        if (row(await c.query('SELECT id FROM submissions WHERE attempt_id=$1', [id]))) fail(409, 'already_submitted');
        if (!ent || ent.used + ent.reserved >= ent.allowance) fail(409, 'allowance_exhausted');
        const submissionId = randomUUID();
        await c.query(`INSERT INTO submissions(id,attempt_id,owner_id,event_id,draft_revision,text,task_version,rubric_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [submissionId,id,owner,eventId,d.revision,d.text,a.task_version,a.rubric_version]);
        await c.query(`INSERT INTO jobs(id,submission_id,owner_id,status) VALUES($1,$2,$3,'queued')`, [randomUUID(),submissionId,owner]);
        await c.query('UPDATE entitlements SET reserved=reserved+1 WHERE owner_id=$1', [owner]);
        return { submissionId, replay: false };
      });
    },
    async claim() {
      await reapExpired();
      return tx(async c => {
        const j = row(await c.query(`SELECT * FROM jobs WHERE (status='queued' OR (status='running' AND lease_until<clock_timestamp()))
          AND tries<3 ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1`));
        if (!j) return null;
        return row(await c.query(`UPDATE jobs SET status='running',lease_token=$2,lease_until=clock_timestamp()+interval '30 seconds',tries=tries+1
          WHERE id=$1 RETURNING *`, [j.id,randomUUID()]));
      });
    },
    async complete(job, feedback) {
      // This slice accepts ONLY deterministic fixture feedback; no live AI adapter.
      if (!feedback || feedback.kind !== 'synthetic-formative' || typeof feedback.comment !== 'string' ||
          feedback.comment.length > 2000 || Object.keys(feedback).some(k => !['kind','comment'].includes(k))) fail(422, 'invalid_feedback');
      return tx(async c => {
        await c.query('SELECT owner_id FROM entitlements WHERE owner_id=$1 FOR UPDATE', [job.owner_id]);
        const s = row(await c.query('SELECT * FROM submissions WHERE id=$1 AND owner_id=$2', [job.submission_id,job.owner_id]));
        if (!s) return false;
        const a = row(await c.query('SELECT * FROM attempts WHERE id=$1 FOR UPDATE', [s.attempt_id]));
        const j = row(await c.query('SELECT *,lease_until>clock_timestamp() AS lease_valid FROM jobs WHERE id=$1 FOR UPDATE', [job.id]));
        if (a.deleted_at || !j || j.status !== 'running' || j.lease_token !== job.lease_token || !j.lease_valid) return false;
        await c.query(`INSERT INTO assessments VALUES($1,$2,$3,'fixture-v1','fixture-v1',$4)`, [s.id,s.owner_id,feedback,s.rubric_version]);
        await c.query('INSERT INTO usage_ledger VALUES($1,$2,1)', [s.id,s.owner_id]);
        await c.query('UPDATE entitlements SET reserved=reserved-1,used=used+1 WHERE owner_id=$1', [s.owner_id]);
        await c.query(`UPDATE jobs SET status='succeeded',lease_token=NULL,lease_until=NULL WHERE id=$1`, [j.id]);
        return true;
      });
    },
    async failJob(job, code) {
      if (!['provider_unavailable','malformed_feedback','retry_exhausted'].includes(code)) fail(422,'invalid_failure');
      return tx(async c => {
        await c.query('SELECT owner_id FROM entitlements WHERE owner_id=$1 FOR UPDATE', [job.owner_id]);
        const j = row(await c.query('SELECT *,lease_until>clock_timestamp() AS lease_valid FROM jobs WHERE id=$1 FOR UPDATE', [job.id]));
        if (!j || j.status !== 'running' || j.lease_token !== job.lease_token || !j.lease_valid) return false;
        await c.query(`UPDATE jobs SET status='failed',failure_code=$2,lease_token=NULL,lease_until=NULL WHERE id=$1`, [j.id,code]);
        await c.query('UPDATE entitlements SET reserved=reserved-1 WHERE owner_id=$1', [j.owner_id]);
        return true;
      });
    },
    async retry(owner, submissionId) {
      return tx(async c => {
        const ent = row(await c.query('SELECT * FROM entitlements WHERE owner_id=$1 FOR UPDATE', [owner]));
        const s = row(await c.query('SELECT * FROM submissions WHERE id=$1 AND owner_id=$2', [submissionId,owner]));
        if (!s) fail(404,'not_found');
        await owned(c,owner,s.attempt_id);
        const j = row(await c.query('SELECT * FROM jobs WHERE submission_id=$1 FOR UPDATE', [submissionId]));
        if (j.status !== 'failed' || j.tries>=3) fail(409,'retry_unavailable');
        if (!ent || ent.used+ent.reserved>=ent.allowance) fail(409,'allowance_exhausted');
        await c.query(`UPDATE jobs SET status='queued',failure_code=NULL WHERE id=$1`, [j.id]);
        await c.query('UPDATE entitlements SET reserved=reserved+1 WHERE owner_id=$1', [owner]);
      });
    },
    async result(owner, submissionId) {
      return tx(async c => {
        const s = row(await c.query('SELECT * FROM submissions WHERE id=$1 AND owner_id=$2', [submissionId,owner]));
        if (!s) fail(404,'not_found');
        await owned(c,owner,s.attempt_id);
        const job = row(await c.query('SELECT status,failure_code,tries FROM jobs WHERE submission_id=$1', [submissionId]));
        const assessment = row(await c.query('SELECT feedback,model_version,prompt_version,rubric_version FROM assessments WHERE submission_id=$1', [submissionId]));
        return {submission:s,job,assessment:assessment ?? null};
      });
    },
    async remove(owner, id) {
      return tx(async c => {
        await c.query('SELECT owner_id FROM entitlements WHERE owner_id=$1 FOR UPDATE', [owner]);
        await owned(c,owner,id);
        const cancelled = await c.query(`UPDATE jobs SET status='cancelled',lease_token=NULL,lease_until=NULL WHERE submission_id IN
          (SELECT id FROM submissions WHERE attempt_id=$1) AND status IN ('queued','running') RETURNING id`, [id]);
        await c.query('UPDATE entitlements SET reserved=reserved-$2 WHERE owner_id=$1', [owner,cancelled.rowCount]);
        await c.query('UPDATE attempts SET deleted_at=now() WHERE id=$1', [id]);
        await c.query('DELETE FROM drafts WHERE attempt_id=$1', [id]);
      });
    }
  };
}
