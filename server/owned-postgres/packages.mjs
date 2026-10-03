/** Exact package publication reads. Caller owns transaction and session context. */
import { contentPolicy, contentIsServable } from '../content-policy.mjs';
import { objectiveItems } from '../package-contract.mjs';

function permittedStates() { return contentPolicy().mode==='internal-preview' ? ['internal','available'] : contentPolicy().mode==='public' ? ['available'] : []; }

/** Exact current membership; neither another exam nor another set version can supply metadata. */
function currentMembership(alias) {
  const states=permittedStates().map(s=>`'${s}'`).join(',') || "'__none__'";
  return `FROM exam_release_head ph JOIN exam_release pr ON pr.exam_id=ph.exam_id AND pr.version=ph.release_version
    JOIN exam_release_form pf ON pf.exam_id=pr.exam_id AND pf.release_version=pr.version
    JOIN exam_form_member pm ON pm.exam_id=pf.exam_id AND pm.form_id=pf.form_id AND pm.form_version=pf.form_version
    WHERE ph.exam_id=${alias}.exam_id AND pm.set_id=${alias}.set_id AND pm.set_version=${alias}.version
      AND pr.state IN (${states}) AND NOT (COALESCE(pr.manifest->'release'->'resumeBlockedReleases','[]'::jsonb) ? pr.version)`;
}
function aliases(...values) {
  if (!values.every(x=>/^[a-z][a-z0-9_]*$/i.test(x))) throw new TypeError('invalid SQL alias');
}
/** Actual historical seed practice keeps its fallback; imported rows always require one interaction. */
export function importedSetGate(alias='s',contentAlias='c') {
  aliases(alias,contentAlias);
  return `(SELECT CASE WHEN count(DISTINCT pm.interaction)=1 THEN true
    WHEN count(*)=0 THEN ${contentAlias}.source_path NOT LIKE 'content/exams/%' ELSE false END
    ${currentMembership(alias)})`;
}
export function objectiveInteractionSql(alias='s',contentAlias='c') {
  aliases(alias,contentAlias);
  return `(SELECT CASE WHEN count(DISTINCT pm.interaction)=1 THEN min(pm.interaction)
    WHEN count(*)=0 AND ${contentAlias}.source_path NOT LIKE 'content/exams/%' THEN
      CASE ${alias}.family WHEN 'LV1' THEN 'matching_headlines' WHEN 'LV2' THEN 'single_choice'
        WHEN 'LV3' THEN 'matching_ads' WHEN 'SB1' THEN 'gap_choice' WHEN 'SB2' THEN 'gap_bank' ELSE NULL END
    END ${currentMembership(alias)})`;
}
/** Only the current permitted blueprint can extend historical objective part syntax. */
export async function releasedObjectiveFamily(client,examId,family) {
  const row=(await client.query(`SELECT EXISTS (
    SELECT 1 FROM exam_release_head h JOIN exam_release r ON r.exam_id=h.exam_id AND r.version=h.release_version
      JOIN exam_blueprint b ON b.exam_id=r.exam_id AND b.version=r.blueprint_version
      CROSS JOIN LATERAL jsonb_array_elements(b.payload->'sections') section
      CROSS JOIN LATERAL jsonb_array_elements(section->'parts') part
    WHERE h.exam_id=$1 AND r.state=ANY($3::text[]) AND part->>'family'=$2
      AND NOT (COALESCE(r.manifest->'release'->'resumeBlockedReleases','[]'::jsonb) ? r.version)
  ) AS allowed`,[examId,family,permittedStates()])).rows[0];
  return row.allowed;
}

export async function readReleasedForm(client,{examId,formId,formVersion,releaseVersion,newStart=false}) {
  const release=(await client.query(`SELECT r.* FROM exam_release r JOIN exam_release_form rf
    ON rf.exam_id=r.exam_id AND rf.release_version=r.version
    WHERE r.exam_id=$1 AND r.version=$2 AND rf.form_id=$3 AND rf.form_version=$4`,[examId,releaseVersion,formId,formVersion])).rows[0];
  if (!release) return null;
  const head=(await client.query(`SELECT r.* FROM exam_release_head h JOIN exam_release r ON r.exam_id=h.exam_id AND r.version=h.release_version WHERE h.exam_id=$1`,[examId])).rows[0];
  const blockedReason=head?.manifest?.release?.resumeBlockedReleases?.includes(releaseVersion)?'rights_blocked':
    (['internal','hidden'].includes(release.state) && contentPolicy().mode!=='internal-preview'?'content_policy_blocked':null);
  if (newStart && (!head || head.version!==releaseVersion || !permittedStates().includes(release.state) || blockedReason)) return null;
  const form=(await client.query('SELECT * FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3',[examId,formId,formVersion])).rows[0];
  if (!form || form.blueprint_version!==release.blueprint_version) return null;
  const rows=(await client.query(`SELECT s.set_id,s.version,s.exam_id,s.family,s.section,s.part,s.title,s.payload,s.item_count,s.media_required,
    m.position,m.interaction,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status
    FROM exam_form_member m JOIN objective_set s ON s.set_id=m.set_id AND s.version=m.set_version AND s.exam_id=m.exam_id
    JOIN content_version c ON c.content_version_id=s.content_version_id LEFT JOIN content_rights cr ON cr.content_version_id=c.content_version_id
    WHERE m.exam_id=$1 AND m.form_id=$2 AND m.form_version=$3 ORDER BY m.position`,[examId,formId,formVersion])).rows;
  if (rows.length!==form.payload.members.length || rows.some(r=>r.media_required)) return null;
  for (const row of rows) {
    try { if(objectiveItems(row.payload,row.interaction).length!==row.item_count) return null; } catch { return null; }
  }
  if (newStart && rows.some(r=>!contentIsServable(r))) return null;
  return {release,form,members:blockedReason?[]:rows,blockedReason,
    reviewStatus:rows.length && rows.every(r=>r.review_status==='approved')?'approved':'unreviewed'};
}

export async function listReleasedForms(client,examId) {
  const rows=(await client.query(`SELECT rf.form_id,rf.form_version,rf.release_version FROM exam_release_head h
    JOIN exam_release_form rf ON rf.exam_id=h.exam_id AND rf.release_version=h.release_version
    WHERE h.exam_id=$1 ORDER BY rf.form_id,rf.form_version`,[examId])).rows;
  const forms=[];
  for (const row of rows) {
    const item=await readReleasedForm(client,{examId,formId:row.form_id,formVersion:row.form_version,releaseVersion:row.release_version,newStart:true});
    if (!item) continue;
    const {form,release,members}=item;
    forms.push({exam_id:examId,release_version:release.version,blueprint_version:release.blueprint_version,
      release_state:release.state,form_id:form.form_id,version:form.version,title:form.payload.title,scope:form.payload.scope,sections:form.payload.sections,
      mode:form.payload.mode,time_limit_seconds:form.payload.timeLimitSeconds,item_count:members.reduce((n,m)=>n+m.item_count,0),
      review_status:members.every(m=>m.review_status==='approved')?'approved':'unreviewed'});
  }
  return forms;
}
