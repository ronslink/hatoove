/** Saved section practice. All callers run within the adapter's session-owner transaction. */
import { createHash, randomUUID } from 'node:crypto';
import { Fault } from '../owned-api.mjs';
import { requirePreparationId } from '../preparation-contract.mjs';
import { validateWritingChoice, validateStartMockRun, validateSaveMockRun, validateFinaliseMockRun, validatePinnedSnapshot } from '../mock-contract.mjs';
import { resolvePreparation, requireActivePreparation } from './preparations.mjs';
import { writingAttachment, attachWriting, finaliseWriting } from './mock-writing.mjs';
import { listReleasedForms, readReleasedForm } from './packages.mjs';

const fail = (status, code) => { throw new Fault(status, code); };
const first = (r) => r.rows[0];
const iso = (value) => value instanceof Date ? value.toISOString() : value ?? null;
const digest = (kind, id, body) => createHash('sha256').update(JSON.stringify({ kind, id, body })).digest('hex');
// A completed run cannot become "expired" merely because its later reader's clock passed the deadline.
const expired = (row) => Boolean(row.deadline_at && new Date(row.finalised_at ?? row.server_now) >= new Date(row.deadline_at));

/** Also acquired FIRST by account deletion. It prevents a late mock write racing deleted account rows. */
export async function lockMockOwner(client, owner) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7352))', [owner]);
}

async function readRow(client, owner, id, lock = false) {
  const row = first(await client.query(
    `SELECT r.*, clock_timestamp() AS server_now FROM mock_run r WHERE r.id = $1 AND r.owner_id = $2${lock ? ' FOR UPDATE OF r' : ''}`,
    [id, owner]));
  if (!row) fail(404, 'not_found');
  row.writing=await writingAttachment(client,owner,id);
  return row;
}

function runDto(row, bundle, summary = false) {
  const blocked = bundle?.blockedReason ?? (!bundle ? 'content_unavailable' : null);
  const dto = {
    id: row.id, preparation_id: row.preparation_id, exam_id: row.exam_id, release_version: row.release_version,
    release_state: bundle?.release.state ?? null, review_status: bundle?.reviewStatus ?? null,
    blueprint_version: row.blueprint_version, form_id: row.form_id, form_version: row.form_version,
    title: row.title, scope: row.scope, mode: row.mode, state: row.state, revision: Number(row.revision),
    writing:row.writing??null,
    created_at: iso(row.created_at), updated_at: iso(row.updated_at), deadline_at: iso(row.deadline_at),
    finalised_at: iso(row.finalised_at), expired: expired(row), blocked_reason: blocked, server_now: iso(row.server_now),
  };
  if (!summary) Object.assign(dto, {
    writing_choices:blocked?[]:bundle.writingChoices||[],
    responses: row.responses, position: row.position,
    members: blocked ? [] : bundle.members.map((member) => ({
      set_id: member.set_id, version: member.version, interaction: member.interaction, item_count: Number(member.item_count),
      release_state: bundle.release.state, review_status: member.review_status,
      title: member.title, family: member.family, section: member.section, part: member.part, payload: member.payload,
    })),
    result: blocked || row.state !== 'finalised' ? null : row.result,
  });
  return dto;
}

async function receipt(client, owner, eventId, kind, id, sha) {
  const row = first(await client.query('SELECT * FROM mock_run_event WHERE owner_id = $1 AND event_id = $2', [owner, eventId]));
  if (row && (row.kind !== kind || (id && row.run_id !== id) || row.request_sha256 !== sha)) fail(409, 'mock_event_conflict');
  return row;
}
async function recordReceipt(client, owner, eventId, kind, row, sha) {
  await client.query(`INSERT INTO mock_run_event(owner_id,event_id,run_id,kind,request_sha256,revision)
    VALUES($1,$2,$3,$4,$5,$6)`, [owner, eventId, row.id, kind, sha, row.revision]);
}
function enabled(catalogue, examId) {
  if (!catalogue.isEnabled(examId)) fail(422, 'exam_unavailable');
}
function writableBundle(bundle) {
  if (!bundle) fail(409, 'mock_content_unavailable');
  if (bundle.blockedReason) fail(409, bundle.blockedReason === 'rights_blocked' ? 'mock_rights_blocked' : 'mock_content_unavailable');
}

/** Convert only the intentional SQL contract exceptions; unexpected database failures stay redacted. */
function sqlFault(error) {
  if (error instanceof Fault) throw error;
  const known = ['mock_expired', 'mock_finalised', 'mock_conflict', 'mock_rights_blocked', 'mock_content_unavailable', 'preparation_archived'];
  if (known.includes(error?.message)) fail(409, error.message);
  if (error?.message === 'not_found') fail(404, 'not_found');
  throw error;
}

export function mockRunMethods({ settle, note = () => {}, catalogue }) {
  const transaction = (owner, work, snapshot = false) => settle(owner, work, snapshot).catch(sqlFault);
  async function bundleOf(client, row, newStart = false) {
    const bundle = await readReleasedForm(client, { examId: row.exam_id, formId: row.form_id, formVersion: row.form_version,
      releaseVersion: row.release_version, newStart });
    if (bundle && !bundle.blockedReason && ['internal','hidden'].includes(bundle.release.state) && !catalogue.isEnabled(row.exam_id))
      return { ...bundle, blockedReason: 'exam_unavailable', members: [] };
    return bundle;
  }
  async function writable(client, owner, id) {
    await lockMockOwner(client, owner);
    const identity = await readRow(client, owner, id);
    const prep = await requireActivePreparation(client, owner, identity.preparation_id);
    enabled(catalogue, prep.exam_id);
    const row = await readRow(client, owner, id, true);
    return row;
  }
  return {
    async listMockForms(owner, { preparationId } = {}) {
      note('listMockForms'); requirePreparationId(preparationId);
      return transaction(owner, async (client) => {
        const prep = await resolvePreparation(client, owner, preparationId);
        enabled(catalogue, prep.exam_id);
        if (prep.state !== 'active') return [];
        return listReleasedForms(client, prep.exam_id);
      }, true);
    },
    async listMockRuns(owner, { preparationId } = {}) {
      note('listMockRuns'); requirePreparationId(preparationId);
      return transaction(owner, async (client) => {
        await resolvePreparation(client, owner, preparationId);
        const rows = (await client.query(`SELECT r.*, clock_timestamp() AS server_now FROM mock_run r
          WHERE r.owner_id = $1 AND r.preparation_id = $2 ORDER BY r.created_at DESC,r.id DESC LIMIT 100`, [owner, preparationId])).rows;
        const result = [];
        for (const row of rows) { row.writing=await writingAttachment(client,owner,row.id); result.push(runDto(row, await bundleOf(client, row), true)); }
        return result;
      }, true);
    },
    async startMockRun(owner, input) {
      note('startMockRun'); const body = validateStartMockRun(input);
      const sha = digest('start', null, body);
      return transaction(owner, async (client) => {
        await lockMockOwner(client, owner);
        const prep = await requireActivePreparation(client, owner, body.preparationId);
        enabled(catalogue, prep.exam_id);
        const replay = await receipt(client, owner, body.eventId, 'start', null, sha);
        if (replay) {
          const row = await readRow(client, owner, replay.run_id);
          return { created: false, run: runDto(row, await bundleOf(client, row)) };
        }
        const identity = { exam_id: prep.exam_id, form_id: body.formId, form_version: body.formVersion, release_version: body.releaseVersion };
        const bundle = await bundleOf(client, identity, true);
        if (!bundle || bundle.blockedReason) fail(404, 'not_found');
        validatePinnedSnapshot(bundle.members, [], { member: 0, item: 0 });
        const row = first(await client.query(`INSERT INTO mock_run
          (id,owner_id,preparation_id,exam_id,release_version,blueprint_version,form_id,form_version,start_event_id,title,scope,mode)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *,clock_timestamp() AS server_now`,
        [randomUUID(), owner, prep.id, prep.exam_id, body.releaseVersion, bundle.release.blueprint_version, body.formId,
          body.formVersion, body.eventId, bundle.form.payload.title, bundle.form.payload.scope, bundle.form.payload.mode]));
        await recordReceipt(client, owner, body.eventId, 'start', row, sha);
        return { created: true, run: runDto(row, bundle) };
      });
    },
    async readMockRun(owner, id) {
      note('readMockRun');
      return transaction(owner, async (client) => {
        const row = await readRow(client, owner, id);
        return runDto(row, await bundleOf(client, row));
      }, true);
    },
    async saveMockRun(owner, id, input) {
      note('saveMockRun'); const body = validateSaveMockRun(input); const sha = digest('save', id, body);
      return transaction(owner, async (client) => {
        let row = await writable(client, owner, id);
        // A delayed save retry must never reopen or overwrite a finalised snapshot.
        if (row.state !== 'active') fail(409, 'mock_finalised');
        const bundle = await bundleOf(client, row); writableBundle(bundle);
        const replay = await receipt(client, owner, body.eventId, 'save', id, sha);
        if (replay) return runDto(row, bundle); // Current-safe acknowledgement; no stale response overwrites.
        if (expired(row)) fail(409, 'mock_expired');
        if (row.revision !== body.expectedRevision) fail(409, 'mock_conflict');
        validatePinnedSnapshot(bundle.members, body.responses, body.position);
        row = first(await client.query(`UPDATE mock_run SET responses = $3::jsonb,position = $4::jsonb,
          revision = revision + 1,updated_at = clock_timestamp() WHERE id = $1 AND owner_id = $2
          RETURNING *,clock_timestamp() AS server_now`, [id, owner, JSON.stringify(body.responses), JSON.stringify(body.position)]));
        row.writing=await writingAttachment(client,owner,id);
        await recordReceipt(client, owner, body.eventId, 'save', row, sha);
        return runDto(row, bundle);
      });
    },
    async selectMockWriting(owner,id,input) {
      note('selectMockWriting'); const body=validateWritingChoice(input),sha=digest('writing_choice',id,body);
      return transaction(owner,async client=>{
        let row=await writable(client,owner,id);
        const bundle=await bundleOf(client,row);writableBundle(bundle);
        if(await receipt(client,owner,body.eventId,'writing_choice',id,sha)) return runDto(row,bundle);
        if(row.state!=='active') fail(409,'mock_finalised');
        if(expired(row)) fail(409,'mock_expired');
        if(row.writing) fail(409,'writing_choice_immutable');
        if(row.revision!==body.expectedRevision) fail(409,'mock_conflict');
        const choice=bundle.writingChoices.find(c=>c.id===body.choiceGroupId),option=choice?.options.find(o=>o.id===body.optionId);
        if(!option) fail(422,'invalid_writing_choice');
        await attachWriting(client,owner,row,choice,option);
        await client.query('UPDATE mock_run SET revision=revision+1,updated_at=clock_timestamp() WHERE id=$1 AND owner_id=$2',[id,owner]);
        row=await readRow(client,owner,id);
        await recordReceipt(client,owner,body.eventId,'writing_choice',row,sha);
        return runDto(row,bundle);
      });
    },
    async finaliseMockRun(owner, id, input) {
      note('finaliseMockRun'); const body = validateFinaliseMockRun(input); const sha = digest('finalise', id, body);
      return transaction(owner, async (client) => {
        let row = await writable(client, owner, id);
        const bundle = await bundleOf(client, row); writableBundle(bundle);
        const replay = await receipt(client, owner, body.eventId, 'finalise', id, sha);
        if (replay) return runDto(row, bundle);
        if (row.state !== 'finalised') {
          if (row.revision !== body.expectedRevision) fail(409, 'mock_conflict');
          await client.query('SELECT finalise_mock_run($1,$2)', [id, body.expectedRevision]);
          if(bundle.writingChoices?.length) await finaliseWriting(client,owner,row,body);
          row = await readRow(client, owner, id);
        }
        // A second tab's finalise is an acknowledgement, never a second grading/evidence operation.
        await recordReceipt(client, owner, body.eventId, 'finalise', row, sha);
        return runDto(row, bundle);
      });
    },
  };
}
