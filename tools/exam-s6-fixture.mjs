/** Synthetic public-admission simulation. Never import this helper from runtime source. */
import {createCompleteFixture} from './exam-s5b-fixture.mjs';
import {importPackage} from '../server/owned-postgres/package-importer.mjs';
import {randomUUID} from 'node:crypto';
import {validatePackage,packageHash,canonicalJson} from '../server/package-contract.mjs';
import {recordReviewerAuthority,recordContentReview} from '../server/owned-postgres/content-review.mjs';

async function assertFixture(db,client=db?.migration) {
  if(process.env.OWNAPI_PG_ALLOW!=='1'||!/^ownapi_[a-z0-9_]+$/.test(db?.schema||'')||!db.admin||!db.migration)
    throw Error('Synthetic review requires an explicit disposable ownapi fixture');
  const targets=await Promise.all([db.admin.query('SELECT current_schema() AS schema'),client.query('SELECT current_schema() AS schema')]);
  if(targets.some(result=>result.rows[0]?.schema!==db.schema))throw Error('Synthetic review connection does not target its disposable schema');
  const role=(await client.query('SELECT current_user AS role')).rows[0]?.role;
  if(role!==db.roles?.migration)throw Error('Synthetic review requires the exact disposable migration role');
}

async function fixturePackage({mediaRoot,version,availableVersion}) {
  if(version===availableVersion)throw Error('Synthetic available release requires a new immutable identity');
  const internal=await createCompleteFixture({examId:'dtz-a2-b1',mediaRoot,version,releaseVersion:version,blueprintVersion:version});
  // Keep the real authored manifests unchanged. Every copied reference gets this fixture version.
  for(const set of internal.sets)set.version=version;
  for(const rubric of internal.rubrics||[])rubric.version=version;
  for(const task of internal.writingTasks||[]){task.version=version;task.rubricVersion=version;}
  for(const form of internal.forms){
    for(const member of form.members)member.version=version;
    for(const group of form.writingChoices||[])for(const option of group.options)option.taskVersion=version;
  }
  for(const row of [...internal.sets,...internal.media,...internal.writingTasks,...internal.rubrics])
    row.source='synthetic:exam-s6-fixture; test-only review simulation, no actual educational approval';
  const contentIds=[...internal.sets.map(x=>x.setId+'@'+x.version),...internal.media.map(x=>x.mediaId+'@'+x.version),
    ...internal.writingTasks.map(x=>x.taskId+'@'+x.version),...internal.rubrics.map(x=>x.rubricId+'@'+x.version)];
  const published={...structuredClone(internal),release:{version:availableVersion,state:'available',resumeBlockedReleases:[]},sets:[],media:[],writingTasks:[],rubrics:[]};
  return {internal,published,contentIds,formId:internal.forms[0].id,formVersion:version,releaseVersion:availableVersion};
}

/** Caller owns a migration-role transaction in the verified synthetic fixture. */
export async function syntheticContentReview(db,client,subject,{decision='approve',mediaRoot}={}) {
  await assertFixture(db,client);
  const actual=(await client.query('SELECT current_schema() AS schema,current_user AS role')).rows[0];
  if(actual.schema!==db.schema||actual.role!==db.roles.migration)throw Error('Synthetic review client mismatch');
  const scope=(await client.query('SELECT * FROM resolve_review_subject($1,$2,$3,$4)',[subject.kind,subject.examId,subject.subjectId,subject.version])).rows[0];
  if(!scope||scope.subject_sha256!==subject.sha256)throw Error('Synthetic review target mismatch');
  const reviewerId='synthetic.exam-s6.'+scope.category;
  const head=(await client.query('SELECT authority_id,action FROM content_review_authority WHERE reviewer_id=$1 AND exam_id=$2 AND category=$3 AND language=$4 ORDER BY revision DESC LIMIT 1',[reviewerId,subject.examId,scope.category,scope.language])).rows[0];
  const evidence={evidenceRef:'fixture://exam-s6/no-real-approval',evidenceSha256:'6'.repeat(64),rationale:'Synthetic disposable fixture only; no actual human approval'};
  const authority=head?.action==='grant'?{authorityId:head.authority_id}:await recordReviewerAuthority(client,{...evidence,eventId:randomUUID(),reviewerId,reviewerName:'Synthetic fixture reviewer — not a human attestation',examId:subject.examId,category:scope.category,language:scope.language,action:'grant',expectedAuthorityId:head?.authority_id??null});
  const previous=(await client.query('SELECT decision_id FROM content_review_decision WHERE exam_id=$1 AND subject_kind=$2 AND subject_id=$3 AND subject_version=$4 AND subject_sha256=$5 AND category=$6 AND language=$7 ORDER BY revision DESC LIMIT 1',[subject.examId,subject.kind,subject.subjectId,subject.version,subject.sha256,scope.category,scope.language])).rows[0];
  return recordContentReview(client,{...evidence,eventId:randomUUID(),subject,category:scope.category,language:scope.language,authorityId:authority.authorityId,expectedDecisionId:previous?.decision_id??null,decision,packetSha256:null},{mediaRoot});
}

/** Current-schema synthetic approvals use the same named ledger as the operator workflow. */
export async function publishCompleteDtzFixture(db,{mediaRoot,version='v9600',availableVersion='v9601'}={}) {
  await assertFixture(db);
  const pkg=await fixturePackage({mediaRoot,version,availableVersion});
  await importPackage(db.migration,pkg.internal,{mediaRoot});
  const client=await db.migration.connect();
  try{
    await client.query('BEGIN');
    for(const id of pkg.contentIds){
      const row=(await client.query('SELECT exam_id,content_sha256 FROM content_version WHERE content_version_id=$1',[id])).rows[0];
      if(!row)throw Error('Incomplete synthetic review identity set');
      await syntheticContentReview(db,client,{kind:'content',examId:row.exam_id,subjectId:id,version:'',sha256:row.content_sha256},{mediaRoot});
    }
    const examId=pkg.internal.exam.id;
    const bp=(await client.query('SELECT sha256 FROM exam_blueprint WHERE exam_id=$1 AND version=$2',[examId,version])).rows[0];
    await syntheticContentReview(db,client,{kind:'blueprint',examId,subjectId:examId,version,sha256:bp.sha256},{mediaRoot});
    for(const form of pkg.internal.forms){const row=(await client.query('SELECT sha256 FROM exam_form WHERE exam_id=$1 AND form_id=$2 AND version=$3',[examId,form.id,form.version])).rows[0];await syntheticContentReview(db,client,{kind:'form',examId,subjectId:form.id,version:form.version,sha256:row.sha256},{mediaRoot});}
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  await importPackage(db.migration,pkg.published,{mediaRoot});
  return pkg;
}

/** Historical pre0034 seed only. No production importer fallback or current-schema approval. */
export async function publishLegacyCompleteDtzFixture(db,{mediaRoot,version,availableVersion}={}) {
  await assertFixture(db);
  const old=(await db.migration.query("SELECT to_regclass('content_review_authority') AS review,to_regclass('reviewed_content_version') AS projection,to_regprocedure('current_release_eligibility(text,text[])') AS admission")).rows[0];
  if(old.review||old.projection||old.admission)throw Error('Historical S6 seed requires the exact pre0034 boundary');
  const pkg=await fixturePackage({mediaRoot,version,availableVersion});
  // The current importer can resolve historical internal metadata through this test-only view.
  // Drop it before applying either forward review migration; it never exists in the runtime.
  await db.migration.query('CREATE VIEW reviewed_content_version AS SELECT * FROM content_version');
  try{await importPackage(db.migration,pkg.internal,{mediaRoot});}finally{await db.migration.query('DROP VIEW reviewed_content_version');}
  const p=validatePackage(pkg.published),client=await db.admin.connect();
  try{
    await client.query('BEGIN');
    await client.query('SET LOCAL session_replication_role=replica');
    const rows=await client.query("UPDATE content_version SET review_status='approved' WHERE content_version_id=ANY($1::text[]) RETURNING content_version_id",[pkg.contentIds]);
    if(rows.rowCount!==pkg.contentIds.length)throw Error('Incomplete historical synthetic review set');
    await client.query('SET LOCAL session_replication_role=origin');
    await client.query('INSERT INTO exam_release(exam_id,version,blueprint_version,state,manifest,sha256,publisher) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7)',[p.exam.id,p.release.version,p.blueprint.version,p.release.state,canonicalJson(p),packageHash(p),'historical-synthetic-fixture']);
    for(const f of p.forms)await client.query('INSERT INTO exam_release_form(exam_id,release_version,form_id,form_version) VALUES($1,$2,$3,$4)',[p.exam.id,p.release.version,f.id,f.version]);
    await client.query('UPDATE exam_release_head SET release_version=$2 WHERE exam_id=$1',[p.exam.id,p.release.version]);
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  return pkg;
}
