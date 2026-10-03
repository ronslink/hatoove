/** Exact package publication reads. Caller owns transaction and session context. */
import { contentPolicy, contentIsServable } from '../content-policy.mjs';
import { objectiveItems, validatePlayback, validateCompleteForm, validateCompleteMembers } from '../package-contract.mjs';

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
  let blockedReason=head?.manifest?.release?.resumeBlockedReleases?.includes(releaseVersion)?'rights_blocked':
    (['internal','hidden'].includes(release.state) && contentPolicy().mode!=='internal-preview'?'content_policy_blocked':null);
  if (newStart && (!head || head.version!==releaseVersion || !permittedStates().includes(release.state) || blockedReason)) return null;
  const form=(await client.query('SELECT * FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3',[examId,formId,formVersion])).rows[0];
  if (!form || form.blueprint_version!==release.blueprint_version) return null;
  const rows=(await client.query(`SELECT s.set_id,s.version,s.exam_id,s.family,s.section,s.part,s.title,s.payload,s.item_count,s.media_required,
    m.position,m.interaction,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status
    FROM exam_form_member m JOIN objective_set s ON s.set_id=m.set_id AND s.version=m.set_version AND s.exam_id=m.exam_id
    JOIN content_version c ON c.content_version_id=s.content_version_id LEFT JOIN content_rights cr ON cr.content_version_id=c.content_version_id
    WHERE m.exam_id=$1 AND m.form_id=$2 AND m.form_version=$3 ORDER BY m.position`,[examId,formId,formVersion])).rows;
  if (rows.length!==form.payload.members.length) return null;
  for (const row of rows) {
    try { if(objectiveItems(row.payload,row.interaction).length!==row.item_count||row.media_required!==(row.interaction==='fixed_audio')) return null; } catch { return null; }
  }
  const writingChoices=[],reviews=rows.map(r=>r.review_status);
  const media=[],mediaIds=new Set();
  let blueprint,writingTask=null,timeGroups=[];
  if(rows.some(row=>row.media_required)||form.payload.writingTask||form.payload.scope==='complete_supported_written') {
    blueprint=(await client.query('SELECT payload FROM exam_blueprint WHERE exam_id=$1 AND version=$2',[examId,form.blueprint_version])).rows[0]?.payload;
    if(!blueprint) return null;
  }
  if(form.payload.scope==='complete_supported_written') {
    try {
      timeGroups=validateCompleteForm(blueprint.exam,blueprint,form.payload);
      validateCompleteMembers(examId,blueprint,form.payload,rows);
    } catch {return null;}
  }
  if(rows.some(row=>row.media_required)) {
    if(!['practice','mock'].includes(form.payload.attemptMode)) return null;
    for(const row of rows.filter(row=>row.media_required)) {
      const part=blueprint.sections.find(section=>section.id===row.section)?.parts.find(part=>part.family===row.family);
      let allowance;
      try {if(!part||part.itemCount!==row.item_count) return null;allowance=validatePlayback(part,examId)[form.payload.attemptMode];} catch {return null;}
      row.recordings=[];
      for(const recording of row.payload.recordings) {
        const identity=recording.mediaId+'@'+recording.mediaVersion;
        if(mediaIds.has(identity)) return null;
        mediaIds.add(identity);
        const asset=(await client.query(`SELECT m.*,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status
          FROM exam_media m JOIN content_version c USING(content_version_id) LEFT JOIN content_rights cr USING(content_version_id)
          WHERE m.media_id=$1 AND m.version=$2 AND m.exam_id=$3`,[recording.mediaId,recording.mediaVersion,examId])).rows[0];
        if(!asset) return null;
        if(!contentIsServable(asset)) {if(newStart) return null;blockedReason ||= 'rights_blocked';}
        reviews.push(asset.review_status);
        media.push(asset);
        row.recordings.push({id:recording.id,media_id:asset.media_id,media_version:asset.version,label:recording.label,
          duration_ms:asset.duration_ms,mime_type:asset.mime_type,max_plays:allowance});
      }
      if(!contentIsServable(row)) {if(newStart) return null;blockedReason ||= 'rights_blocked';}
    }
  }
  for(const choice of form.payload.writingChoices||[]) {
    const options=[];
    for(const option of choice.options) {
      const task=await readWritingTask(client,option.taskId,option.taskVersion);
      if(!task||task.exam_id!==examId||task.section!==choice.section) return null;
      if(!writingServable(task)) { if(newStart) return null; blockedReason ||= 'rights_blocked'; }
      reviews.push(task.review_status,task.rubric_review_status);
      options.push({id:option.id,task:writingTaskDto(task)});
    }
    writingChoices.push({id:choice.id,section:choice.section,options});
  }
  if(form.payload.writingTask) {
    const binding=form.payload.writingTask,part=blueprint.sections.find(s=>s.id===binding.section)?.parts.find(p=>p.family==='writing');
    const task=await readWritingTask(client,binding.taskId,binding.taskVersion);
    if(form.payload.writingChoices!==undefined||examId!=='telc-deutsch-b1'||blueprint.exam?.language!=='de'||binding.section!=='writing'||!form.payload.sections.includes(binding.section)||part?.interaction!=='extended_writing'||part.itemCount!==1||part.mediaRequired||!task||task.exam_id!==examId||task.family!=='writing'||task.section!==binding.section||task.rubric_id!=='writing.telc-b1'||task.rubric_version!=='v1') return null;
    if(!writingServable(task)) {if(newStart) return null;blockedReason ||= 'rights_blocked';}
    reviews.push(task.review_status,task.rubric_review_status);
    writingTask={section:binding.section,task:writingTaskDto(task)};
  }
  if (newStart && rows.some(r=>!contentIsServable(r))) return null;
  return {release,form,members:blockedReason?[]:rows,media:blockedReason?[]:media,writingChoices:blockedReason?[]:writingChoices,writingTask:blockedReason?null:writingTask,timeGroups,blockedReason,
    reviewStatus:reviews.length && reviews.every(r=>r==='approved')?'approved':'unreviewed'};
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
      mode:form.payload.mode,time_limit_seconds:form.payload.timeLimitSeconds,writing_choice_count:(form.payload.writingChoices||[]).length,writing_task_count:form.payload.writingTask?1:0,item_count:members.reduce((n,m)=>n+m.item_count,0),
      ...(form.payload.attemptMode?{attempt_mode:form.payload.attemptMode}:{}),
      review_status:item.reviewStatus});
  }
  return forms;
}

/** Full immutable writing binding; never chooses a latest rubric version. */
export async function readWritingTask(client,taskId,version) {
 return (await client.query(`SELECT t.*,c.source_path,c.review_status,COALESCE(cr.basis,c.rights_status) AS rights_status,
 r.criteria,r.max_total,r.policy,r.feedback_kind,rc.review_status AS rubric_review_status,
 COALESCE(rr.basis,rc.rights_status) AS rubric_rights_status
 FROM task_version t JOIN content_version c USING(content_version_id) LEFT JOIN content_rights cr USING(content_version_id)
 JOIN rubric_version r ON r.rubric_id=t.rubric_id AND r.version=t.rubric_version AND r.exam_id=t.exam_id
 JOIN content_version rc ON rc.content_version_id=r.content_version_id LEFT JOIN content_rights rr ON rr.content_version_id=rc.content_version_id
 WHERE t.task_id=$1 AND t.version=$2`,[taskId,version])).rows[0];
}
export function writingServable(t) { return contentIsServable(t)&&contentIsServable({review_status:t.rubric_review_status,rights_status:t.rubric_rights_status}); }
export function writingTaskDto(t) {
 const {task_id,version,exam_id,family,section,register,topic,situation,adressat,leitpunkte,rubric_id,rubric_version,review_status,rights_status}=t;
 return {task_id,version,exam_id,family,section,register,topic,situation,adressat,leitpunkte,rubric_id,rubric_version,review_status,rights_status};
}
/** Imported standalone discovery uses current membership; owned resumes may use an older eligible release. */
export async function writingAccess(client,t,{historical=false}={}) {
 if(!t) return 'content_unavailable';
 if(!t.source_path?.startsWith('content/exams/')) return null;
 if(!writingServable(t)) return 'rights_blocked';
 const rows=(await client.query(`SELECT r.version,r.state,h.release_version AS head_version,head.manifest AS head_manifest
 FROM exam_release r JOIN exam_release_form rf ON rf.exam_id=r.exam_id AND rf.release_version=r.version
 JOIN exam_form f ON f.exam_id=rf.exam_id AND f.form_id=rf.form_id AND f.version=rf.form_version
 JOIN exam_release_head h ON h.exam_id=r.exam_id JOIN exam_release head ON head.exam_id=h.exam_id AND head.version=h.release_version
 WHERE r.exam_id=$1 AND (EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(f.payload->'writingChoices','[]'::jsonb)) g,
 jsonb_array_elements(g->'options') o WHERE o->>'taskId'=$2 AND o->>'taskVersion'=$3)
 OR (f.payload->'writingTask'->>'taskId'=$2 AND f.payload->'writingTask'->>'taskVersion'=$3))`,[t.exam_id,t.task_id,t.version])).rows;
 const eligible=rows.filter(r=>(historical||r.version===r.head_version)&&permittedStates().includes(r.state));
 if(!eligible.length) return 'content_policy_blocked';
 return eligible.some(r=>!r.head_manifest?.release?.resumeBlockedReleases?.includes(r.version))?null:'rights_blocked';
}

/** A revision keeps its independent navigation while inheriting its original prompt's rights fence. */
export async function readWritingOrigin(client,attemptId,ownerId) {
 return (await client.query(`WITH RECURSIVE lineage AS (
   SELECT id,parent_submission_id FROM attempts WHERE id=$1 AND owner_id=$2
   UNION ALL
   SELECT a.id,a.parent_submission_id FROM lineage l JOIN submissions s ON s.id=l.parent_submission_id AND s.owner_id=$2
   JOIN attempts a ON a.id=s.attempt_id AND a.owner_id=$2
 ) SELECT r.*,w.run_id,w.binding_kind,w.choice_group_id,w.selected_option_id FROM lineage l
 JOIN mock_writing w ON w.attempt_id=l.id AND w.owner_id=$2 JOIN mock_run r ON r.id=w.run_id AND r.owner_id=w.owner_id LIMIT 1`,[attemptId,ownerId])).rows[0]??null;
}
