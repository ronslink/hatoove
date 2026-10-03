/** One current admission decision. The caller owns transaction, session and owner lock order. */
import {contentPolicy} from '../content-policy.mjs';
import {createExamCatalogue,EXAM_ID_RE} from '../preparation-contract.mjs';

export async function readCurrentReleaseEligibility(client,examId,{catalogue=createExamCatalogue(),lock=false}={}) {
  const closed=reason=>({eligible:false,examId,releaseVersion:null,state:null,reason,completeForm:null});
  const policy=contentPolicy();
  if(typeof examId!=='string'||!EXAM_ID_RE.test(examId)||!catalogue?.isEnabled(examId))return closed('exam_unavailable');
  if(!['public','internal-preview'].includes(policy.mode)||!policy.rights.length)return closed('invalid_policy');
  if(lock)await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,7351))',[examId]);
  const row=(await client.query('SELECT * FROM current_release_eligibility($1,$2::text[])',[examId,policy.rights])).rows[0];
  if(!row||typeof row.eligible!=='boolean'||row.exam_id!==examId)return closed('invalid_eligibility');
  if(examId==='dtz-a2-b1'&&row.eligible&&row.state==='available'&&
    (!row.release_version||!row.complete_form_id||!row.complete_form_version))return closed('invalid_eligibility');
  const publicInternal=examId==='dtz-a2-b1'&&policy.mode==='public'&&row.state!=='available';
  return {eligible:row.eligible&&!publicInternal,examId,releaseVersion:row.release_version??null,state:row.state??null,
    reason:publicInternal?'release_unavailable':row.reason,
    completeForm:row.complete_form_id&&row.complete_form_version?{formId:row.complete_form_id,formVersion:row.complete_form_version}:null};
}
