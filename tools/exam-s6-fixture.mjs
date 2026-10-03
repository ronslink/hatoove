/** Synthetic public-admission simulation. Never import this helper from runtime source. */
import {createCompleteFixture} from './exam-s5b-fixture.mjs';
import {importPackage} from '../server/owned-postgres/package-importer.mjs';

/** Simulates human review only inside bootstrap's unique disposable test schema. */
export async function publishCompleteDtzFixture(db,{mediaRoot,version='v9600',availableVersion='v9601'}={}) {
  if(process.env.OWNAPI_PG_ALLOW!=='1'||!/^ownapi_[a-z0-9_]+$/.test(db?.schema||'')||!db.admin||!db.migration)
    throw Error('Synthetic review requires an explicit disposable ownapi fixture');
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
  await importPackage(db.migration,internal,{mediaRoot});
  const contentIds=[...internal.sets.map(x=>x.setId+'@'+x.version),...internal.media.map(x=>x.mediaId+'@'+x.version),
    ...internal.writingTasks.map(x=>x.taskId+'@'+x.version),...internal.rubrics.map(x=>x.rubricId+'@'+x.version)];
  const client=await db.admin.connect();
  try{
    await client.query('BEGIN');
    // Test seam only: the ordinary importer refuses to manufacture educational approval.
    // Exact IDs and the ownapi schema fence prevent touching any installation or unrelated row.
    await client.query('SET LOCAL session_replication_role=replica');
    const rows=await client.query("UPDATE content_version SET review_status='approved' WHERE content_version_id=ANY($1::text[]) RETURNING content_version_id",[contentIds]);
    if(rows.rowCount!==contentIds.length)throw Error('Incomplete synthetic review identity set');
    await client.query('COMMIT');
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  const published={...structuredClone(internal),release:{version:availableVersion,state:'available',resumeBlockedReleases:[]},sets:[],media:[],writingTasks:[],rubrics:[]};
  await importPackage(db.migration,published,{mediaRoot});
  return {internal,published,contentIds,formId:internal.forms[0].id,formVersion:version,releaseVersion:availableVersion};
}
