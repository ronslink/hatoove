/** Authoritative empty index and actual servable-family negatives in a disposable schema. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
const root=path.resolve(process.argv.find(arg=>arg.startsWith('--source-root='))?.slice(14)||fileURLToPath(new URL('../',import.meta.url)));
const {readExamParts,buildIndexModel}=await import(pathToFileURL(path.join(root,'public/app/part-index.js')));
const empty=await readExamParts({examParts:{list:async()=>({ok:true,data:{parts:[]}})}});
assert.equal(empty.source,'payload');assert.equal(empty.error,null);assert.deepEqual(empty.parts,[]);
assert.equal(buildIndexModel(empty).tiles.length,0);
console.log('PASS successful empty part list stays empty without a cited fallback');
const failed=await readExamParts({examParts:{list:async()=>({ok:false,error:'Synthetic unavailable'})}});
assert.equal(failed.source,'unavailable');assert.equal(failed.error,'Synthetic unavailable');
console.log('PASS a failed part read remains distinct from a successful empty list');
if(process.argv.includes('--postgres')) {
  assert.match(process.env.REDESIGN_TEST_PROJECT||'',/^hatoove-browser-\d+-\d+$/);
  assert.equal(process.env.OWNAPI_PG_ALLOW,'1');assert.equal(process.env.OWNAPI_PG_HOST,'127.0.0.1');
  assert.ok(![4300,55435,55440].includes(Number(process.env.OWNAPI_PG_PORT)));
  process.env.B1PREP_CONTENT_MODE='internal-preview';
  const {createFixture}=await import('../server/owned-postgres/bootstrap.mjs');
  const {createPostgresWorld}=await import('../server/owned-postgres/fixture.mjs');
  const {recordReviewerAuthority,recordContentReview}=await import('../server/owned-postgres/content-review.mjs');
  const {readCurrentReleaseEligibility}=await import('../server/owned-postgres/release-eligibility.mjs');
  const db=await createFixture();let world;
  const tx=async run=>{const client=await db.migration.connect();try{await client.query('BEGIN');const result=await run(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}};
  try {
    world=await createPostgresWorld({fixture:db});const port=world.store.port,examId='telc-deutsch-b1';
    const signup=await world.sessions.signUp({name:'Synthetic parts',email:'parts-'+randomUUID()+'@example.invalid',password:'Synthetic-redesign-parts-2026'});
    const owner=(await world.sessions.getSession({cookie:String(signup.setCookie).split(';')[0]})).userId;
    const prep=(await port.createPreparation(owner,examId)).preparation;
    const before=(await db.admin.query('SELECT count(*)::int AS count FROM practice_attempt')).rows[0].count;
    const baseline=await port.listExamParts(owner,{examId});assert.ok(baseline.some(row=>row.family==='LV3'));assert.ok(baseline.some(row=>row.family==='LV2'));
    const authority=await tx(client=>recordReviewerAuthority(client,{eventId:randomUUID(),reviewerId:'synthetic.redesign.parts',reviewerName:'Synthetic negative fixture only',examId,category:'educational',language:'',action:'grant',expectedAuthorityId:null,evidenceRef:'fixture://synthetic-appointment',evidenceSha256:'c'.repeat(64),rationale:'Disposable negative fixture; no real content approval'}));
    const withhold=async family=>{
      const rows=(await db.admin.query('SELECT DISTINCT c.content_version_id,c.content_sha256 FROM objective_set s JOIN content_version c ON c.content_version_id=s.content_version_id WHERE s.exam_id=$1 AND ($2::text IS NULL OR s.family=$2)',[examId,family])).rows;
      for(const row of rows) {
        const projection=(await db.migration.query('SELECT * FROM effective_content_review($1)',[row.content_version_id])).rows[0];
        if(projection.explicit_negative)continue;
        await tx(client=>recordContentReview(client,{eventId:randomUUID(),subject:{kind:'content',examId,subjectId:row.content_version_id,version:'',sha256:row.content_sha256},category:'educational',language:'',authorityId:authority.authorityId,expectedDecisionId:projection.decision_ids[0]||null,decision:'reject',evidenceRef:'fixture://synthetic-withheld-family',evidenceSha256:'d'.repeat(64),rationale:'Disposable negative fixture only; preserve all source rows',packetSha256:null}));
      }
    };
    await withhold('LV3');
    assert.equal((await readCurrentReleaseEligibility(db.learner,examId)).eligible,true);
    const partial=await port.listExamParts(owner,{examId});
    assert.ok(!partial.some(row=>row.family==='LV3'));assert.ok(partial.some(row=>row.family==='LV2'));
    const skill = buildIndexModel({parts:partial,partsSource:'payload',filter:'LV'});
    assert.ok(!skill.tiles.some(row=>row.family==='LV3'));assert.ok(skill.tiles.some(row=>row.family==='LV2'));
    assert.equal(await port.practiceSetForPart(owner,{preparationId:prep.id,family:'LV3'}),null);
    assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM practice_attempt')).rows[0].count,before);
    console.log('PASS withheld family disappears while another family and exam remain available; listing writes no sitting');
    await withhold(null);
    assert.deepEqual(await port.listExamParts(owner,{examId}),[]);
    assert.equal((await db.admin.query('SELECT count(*)::int AS count FROM practice_attempt')).rows[0].count,before);
    console.log('PASS all withheld objective families produce an authoritative empty read without writes');
  } finally {if(world)await world.teardown();else await db.cleanup();}
}
