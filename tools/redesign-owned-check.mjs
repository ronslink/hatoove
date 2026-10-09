/** Exact-item retries against real PostgreSQL, only inside an explicitly isolated browser test project. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
assert.match(process.env.REDESIGN_TEST_PROJECT || '', /^hatoove-browser-\d+-\d+$/);
assert.equal(process.env.OWNAPI_PG_ALLOW, '1');
assert.equal(process.env.OWNAPI_PG_HOST, '127.0.0.1');
assert.ok(![4300,55435,55440].includes(Number(process.env.OWNAPI_PG_PORT)));
process.env.B1PREP_CONTENT_MODE = 'internal-preview';
const db = await createFixture();
let world, passes=0;
const leg = async (name,run) => { await run(); passes++; console.log('PASS '+name); };
try {
  world = await createPostgresWorld({fixture:db});
  const port=world.store.port;
  const user = async name => {
    const signup=await world.sessions.signUp({name,email:name+'-'+randomUUID()+'@example.invalid',password:'Synthetic-redesign-fixture-2026'});
    const cookie=String(signup.setCookie).split(';')[0];
    return {cookie,id:(await world.sessions.getSession({cookie})).userId};
  };
  const owner=await user('retry-owner'), foreign=await user('retry-foreign');
  const prep=(await port.createPreparation(owner.id,'telc-deutsch-b1')).preparation;
  const other=(await port.createPreparation(foreign.id,'telc-deutsch-b1')).preparation;
  const served=await port.practiceSetForPart(owner.id,{preparationId:prep.id,family:'LV2'});
  const first=served.set.items[0], second=served.set.items[1];
  const keys=(await db.admin.query('SELECT answers FROM objective_key WHERE set_id=$1 AND version=$2',[served.set.set_id,served.set.version])).rows[0].answers;
  const wrong=first.options.find(option=>option.value!==keys[first.item_id]); assert.ok(wrong);
  await port.answerObjectiveItem(owner.id,{preparationId:prep.id,setId:served.set.set_id,version:served.set.version,itemId:first.item_id,answer:wrong.value});
  const mistakes=await port.listMistakes(owner.id,{preparationId:prep.id});
  const evidence=mistakes.items.find(row=>row.item_id===first.item_id);
  await leg('mistake contains the original passage and human answer options',()=>{
    assert.equal(evidence.task.prompt,first.prompt); assert.equal(evidence.material.text,served.set.material.text);
    assert.ok(evidence.evidence_id); assert.ok(evidence.task.options.length); assert.equal(evidence.correct_answer,keys[first.item_id]);
  });
  const target=await port.practiceSetForPart(owner.id,{preparationId:prep.id,family:'LV2',evidenceId:evidence.evidence_id});
  await leg('retry serves exactly the recorded item without any answer key',()=>{
    assert.deepEqual(target.set.items.map(row=>row.item_id),[first.item_id]); assert.equal(target.round,null);
    assert.ok(!JSON.stringify(target.set).includes('correct_answer')); assert.ok(!('expected' in target.set.items[0]));
  });
  await leg('foreign owner and preparation cannot reopen that evidence',async()=>{
    await assert.rejects(port.practiceSetForPart(foreign.id,{preparationId:other.id,family:'LV2',evidenceId:evidence.evidence_id}),error=>error.status===404);
    await assert.rejects(port.practiceSetForPart(owner.id,{preparationId:other.id,family:'LV2',evidenceId:evidence.evidence_id}),error=>error.status===404);
  });
  await leg('a substituted item is refused without writing evidence or closing the retry',async()=>{
    await assert.rejects(port.checkPracticeAttempt(owner.id,{preparationId:prep.id,attemptId:target.attempt.attempt_id,answers:[{item_id:second.item_id,answer:keys[second.item_id]}]}),error=>error.status===422&&error.code==='retry_item_mismatch');
    const row=(await db.admin.query('SELECT state,answered_count FROM practice_attempt WHERE attempt_id=$1',[target.attempt.attempt_id])).rows[0];
    assert.equal(row.state,'open'); assert.equal(row.answered_count,0);
  });
  await leg('retry identity is immutable even to a privileged test writer',async()=>{
    await assert.rejects(db.admin.query('UPDATE practice_attempt SET retry_item_id=$2 WHERE attempt_id=$1',[target.attempt.attempt_id,second.item_id]),/practice_attempt_identity_immutable/);
  });
  await leg('the exact item checks once and clears its own mistake',async()=>{
    const result=await port.checkPracticeAttempt(owner.id,{preparationId:prep.id,attemptId:target.attempt.attempt_id,answers:[{item_id:first.item_id,answer:keys[first.item_id]}]});
    assert.equal(result.correct_count,1); assert.equal(result.answered_count,1);
    assert.equal((await port.listMistakes(owner.id,{preparationId:prep.id})).count,0);
    await assert.rejects(port.checkPracticeAttempt(owner.id,{preparationId:prep.id,attemptId:target.attempt.attempt_id,answers:[{item_id:first.item_id,answer:keys[first.item_id]}]}),error=>error.status===409);
  });
  await leg('one-item completion is not a completed whole set',async()=>{
    const next=await port.practiceSetForPart(owner.id,{preparationId:prep.id,family:'LV2'});
    assert.equal(next.round.round,1); assert.equal(next.round.wrapped,false);
    const row=(await db.admin.query("SELECT count(*)::int AS n FROM practice_attempt WHERE owner_id=$1 AND state='checked' AND retry_item_id IS NULL",[owner.id])).rows[0]; assert.equal(row.n,0);
  });
  await leg('archived preparations remain read-only',async()=>{
    const live=await port.readPreparation(owner.id,prep.id);
    await port.updatePreparation(owner.id,prep.id,live.revision,{state:'archived'});
    await assert.rejects(port.practiceSetForPart(owner.id,{preparationId:prep.id,family:'LV2',evidenceId:evidence.evidence_id}),error=>error.status===409);
  });
  console.log(`${passes} PostgreSQL retry checks passed`);
} finally { if(world) await world.teardown(); else await db.cleanup(); }
