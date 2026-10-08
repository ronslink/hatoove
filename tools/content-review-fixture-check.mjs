/** Real two-connection regression for the synthetic review helper; no live data or approval. */
import assert from 'node:assert/strict';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {syntheticContentReview} from './exam-s6-fixture.mjs';

if(process.env.OWNAPI_PG_ALLOW!=='1'||process.env.OWNAPI_PG_HOST!=='127.0.0.1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))throw Error('Explicit isolated PostgreSQL target required');
let db,reviewer,peer,pending,timer;
try{
 db=await createFixture();
 assert.equal(db.migration.options.max,2,'the regression must occupy the complete real migration pool');
 const row=(await db.migration.query('SELECT c.content_version_id,c.exam_id,c.content_sha256 FROM content_version c JOIN rubric_version r USING(content_version_id) LIMIT 1')).rows[0];
 assert.ok(row);
 const baseline=(await db.migration.query('SELECT to_jsonb(d) AS value FROM content_review_decision d ORDER BY decision_id')).rows;
 reviewer=await db.migration.connect();peer=await db.migration.connect();
 assert.notEqual(reviewer.processID,peer.processID);
 assert.equal(db.migration.idleCount,0);
 await reviewer.query('BEGIN');await reviewer.query("SET LOCAL statement_timeout='4s'");
 pending=syntheticContentReview(db,reviewer,{kind:'content',examId:row.exam_id,subjectId:row.content_version_id,version:'',sha256:row.content_sha256},{decision:'withdraw'});
 pending.catch(()=>{});
 const receipt=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Fixture attempted an unavailable third migration connection')),3000);})]);
 assert.equal(receipt.decision,'withdraw');
 assert.equal(db.migration.waitingCount,0);
 await reviewer.query('ROLLBACK');
 assert.deepEqual((await reviewer.query('SELECT to_jsonb(d) AS value FROM content_review_decision d ORDER BY decision_id')).rows,baseline);
}finally{
 clearTimeout(timer);
 // Release the occupied peer before awaiting pending work, so even the old bug cleans up.
 peer?.release();
 try{await pending?.catch(()=>{});}finally{try{await reviewer?.query('ROLLBACK');}finally{reviewer?.release();await db?.cleanup();}}
}
console.log('PASS synthetic review uses the checked-out connection with both pool slots occupied; rollback and fixture cleanup complete');
