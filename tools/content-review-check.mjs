/** Offline input and private-output controls; no database, provider or service. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,readFile,symlink} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {validateReviewerAuthority,validateContentReview,validateReviewSubject} from '../server/content-review-contract.mjs';
import {readExplanationReview} from '../server/owned-postgres/content-review.mjs';
import {parseReviewArgs,privatePacketDestination,writePrivatePacket,main} from './review-content.mjs';
let passed=0;const check=async(name,fn)=>{await fn();console.log('PASS '+name);passed++;};
const sha='a'.repeat(64),authority={eventId:randomUUID(),reviewerId:'fixture.reviewer',reviewerName:'Synthetic fixture reviewer',examId:'dtz-a2-b1',category:'educational',language:'',action:'grant',expectedAuthorityId:null,evidenceRef:'fixture://qualification',evidenceSha256:sha,rationale:'Synthetic fixture only'};
const subject={kind:'content',examId:'dtz-a2-b1',subjectId:'fixture@literal@v1',version:'',sha256:sha};
const decision={eventId:randomUUID(),subject,category:'educational',language:'',authorityId:randomUUID(),expectedDecisionId:null,decision:'approve',evidenceRef:'fixture://review',evidenceSha256:sha,rationale:'Synthetic fixture only',packetSha256:null};
let root;
try{
 await check('strict authority input accepts a scoped synthetic event',()=>assert.deepEqual(validateReviewerAuthority(authority),authority));
 await check('authority malformed scope, unknown keys and predecessor are refused',()=>{for(const patch of [{language:'de'},{category:'*'},{reviewerId:'*'},{expectedAuthorityId:undefined},{extra:true},{rationale:'x'},{eventId:'bad'},{evidenceSha256:'A'.repeat(64)}])assert.throws(()=>validateReviewerAuthority({...authority,...patch}),{code:'review_input_invalid'});});
 await check('opaque content identity is never parsed at an at-sign',()=>assert.deepEqual(validateReviewSubject(subject),subject));
 await check('initial subject types reject translation approval and extra privilege inputs',()=>{for(const patch of [{category:'language',language:'de'},{mediaRoot:'outside'},{authorityId:'bad'},{expectedDecisionId:undefined},{decision:'publish'}])assert.throws(()=>validateContentReview({...decision,...patch}),{code:'review_input_invalid'});});
 await check('exact format identity and required content empty version',()=>{assert.throws(()=>validateReviewSubject({...subject,version:'v1'}));assert.throws(()=>validateReviewSubject({...subject,kind:'blueprint',version:'v1'}));assert.equal(validateReviewSubject({...subject,kind:'blueprint',subjectId:subject.examId,version:'v1'}).kind,'blueprint');});
 await check('CLI defaults to dry-run and requires explicit apply',()=>{assert.equal(parseReviewArgs(['decision','--input','event.json']).apply,false);assert.equal(parseReviewArgs(['decision','--input','event.json','--apply']).apply,true);for(const args of [['decision','--input','x','--apply','--dry-run'],['packet','--subject-file','x','--output','y','--apply'],['authority','--input','x','--input','y'],['coverage','--exam','x','--unknown']])assert.throws(()=>parseReviewArgs(args));});
 await check('CLI cannot default-connect without selected database guard',async()=>{await assert.rejects(main(['coverage','--exam','dtz-a2-b1'],{}),{code:'review_database_selection_required'});});
 await check('personal explanation review remains owner-bound without querying editorial rows',async()=>{const client={query(){throw Error('must not query');}};for(const ownerId of ['fixture-owner','another-owner']){const r=await readExplanationReview(client,{scope:'writing',ownerId,sourceIdentity:{owner_id:'fixture-owner'}});for(const dimension of ['educational','native_language']){assert.equal(r[dimension].review_status,ownerId==='fixture-owner'?'unreviewed':'unavailable');assert.equal(r[dimension].blocked,ownerId!=='fixture-owner');}}});
 await check('incomplete shared review identity fails closed without a database lookup',async()=>{const r=await readExplanationReview({query(){throw Error('must not query');}},{language:'ar'});for(const dimension of ['educational','native_language']){assert.equal(r[dimension].review_status,'unavailable');assert.equal(r[dimension].blocked,true);}});
 root=await mkdtemp(path.join(tmpdir(),'hatoove-review-path-'));const serving=path.join(root,'public'),privateDir=path.join(root,'private');await mkdir(serving);await mkdir(privateDir);
 const options={staticRoots:[serving]};
 await check('packet refuses lexical static destinations and missing parents',async()=>{await assert.rejects(privatePacketDestination(path.join(serving,'packet.json'),options),{code:'review_packet_destination'});await assert.rejects(privatePacketDestination(path.join(root,'missing','packet.json'),options));});
 await check('packet refuses junction/symlink aliases into static roots',async()=>{const alias=path.join(root,'alias');await symlink(serving,alias,process.platform==='win32'?'junction':'dir');await assert.rejects(privatePacketDestination(path.join(alias,'packet.json'),options),{code:'review_packet_destination'});});
 await check('private packet write returns digest only and never overwrites an existing file',async()=>{const output=path.join(privateDir,'packet.json'),value={packet:{protectedKeys:{'1':'a'}},packetSha256:sha};assert.deepEqual(await writePrivatePacket(output,value,options),{packetSha256:sha});assert.deepEqual(JSON.parse(await readFile(output,'utf8')),value);await assert.rejects(writePrivatePacket(output,value,options),{code:'review_packet_exists'});});
 await check('outbound static subtree junctions cannot expose otherwise private packet output',async()=>{await symlink(privateDir,path.join(serving,'outbound'),process.platform==='win32'?'junction':'dir');await assert.rejects(privatePacketDestination(path.join(privateDir,'other.json'),options),{code:'review_packet_destination'});});
 console.log(`Content review offline: ${passed} checks passed.`);
}finally{if(root)await rm(root,{recursive:true,force:true});}
