/** One attachment, existing writing storage, and the caller's owner/run transaction. */
import { randomUUID } from 'node:crypto';
import { Fault } from '../owned-api.mjs';
import { entitlementExpired } from './entitlement.mjs';

export async function writingAttachment(client,owner,runId) {
  const w=(await client.query(`SELECT w.*,d.revision AS draft_revision,j.status,j.failure_code AS job_failure,
    f.submission_id AS assessed FROM mock_writing w JOIN drafts d ON d.attempt_id=w.attempt_id
    LEFT JOIN jobs j ON j.submission_id=w.submission_id LEFT JOIN assessments f ON f.submission_id=w.submission_id
    WHERE w.run_id=$1 AND w.owner_id=$2`,[runId,owner])).rows[0];
  if(!w) return null;
  return {binding_kind:w.binding_kind??'choice',choice_group_id:w.choice_group_id,selected_option_id:w.selected_option_id,attempt_id:w.attempt_id,
    draft_revision:Number(w.draft_revision),submission_id:w.submission_id,
    assessment_state:w.assessed?'assessed':w.failure_code?'unassessed':w.status==='failed'?'failed':w.submission_id?'pending':'not_started',
    failure_code:w.failure_code||w.job_failure||null};
}
export async function attachWriting(client,owner,row,choice,option) {
  const id=randomUUID(),t=option.task;
  await client.query(`INSERT INTO attempts(id,owner_id,task_id,task_version,rubric_id,rubric_version,preparation_id,exam_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,owner,t.task_id,t.version,t.rubric_id,t.rubric_version,row.preparation_id,row.exam_id]);
  await client.query('INSERT INTO drafts(attempt_id,revision,text) VALUES($1,1,$2)',[id,'']);
  await client.query(`INSERT INTO mock_writing(run_id,owner_id,attempt_id,choice_group_id,selected_option_id,binding_kind)
    VALUES($1,$2,$3,$4,$5,$6)`,[row.id,owner,id,choice?.id??null,choice?option.id:null,choice?'choice':'assigned']);
}
/** Call after freezing the objective run in the SAME transaction; any conflict rolls it all back. */
export async function finaliseWriting(client,owner,row,body) {
  const w=(await client.query('SELECT * FROM mock_writing WHERE run_id=$1 AND owner_id=$2',[row.id,owner])).rows[0];
  if(!w) return;
  const balance=(await client.query('SELECT * FROM entitlements WHERE owner_id=$1 AND exam_id=$2 FOR UPDATE',[owner,row.exam_id])).rows[0];
  const a=(await client.query('SELECT * FROM attempts WHERE id=$1 AND owner_id=$2 FOR UPDATE',[w.attempt_id,owner])).rows[0];
  const d=(await client.query('SELECT * FROM drafts WHERE attempt_id=$1',[a.id])).rows[0];
  if(d.revision!==body.expectedWritingRevision) throw new Fault(409,'draft_conflict');
  if(!['de','en','uk','ar','tr'].includes(body.explanationLanguage)) throw new Fault(422,'invalid_explanation_language');
  const failure=!d.text.trim()?'empty_submission':!balance||entitlementExpired(balance)||balance.used+balance.reserved>=balance.allowance?'allowance_exhausted':null;
  const id=randomUUID();
  await client.query(`INSERT INTO submissions(id,attempt_id,owner_id,event_id,draft_revision,text,task_version,rubric_version,explanation_language)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[id,a.id,owner,body.eventId,d.revision,d.text,a.task_version,a.rubric_version,body.explanationLanguage]);
  await client.query('UPDATE mock_writing SET submission_id=$3,failure_code=$4 WHERE run_id=$1 AND owner_id=$2',[row.id,owner,id,failure]);
  if(!failure) {
    await client.query(`INSERT INTO jobs(id,submission_id,owner_id,status,exam_id) VALUES($1,$2,$3,'queued',$4)`,[randomUUID(),id,owner,row.exam_id]);
    await client.query('UPDATE entitlements SET reserved=reserved+1 WHERE owner_id=$1 AND exam_id=$2',[owner,row.exam_id]);
  }
}
