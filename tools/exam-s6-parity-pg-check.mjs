/** Canonical reader/SQL parity in one disposable synthetic package; every mutation rolls back. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createFixture} from '../server/owned-postgres/bootstrap.mjs';
import {readReleasedForm} from '../server/owned-postgres/packages.mjs';
import {objectiveItems} from '../server/package-contract.mjs';
import {publishCompleteDtzFixture} from './exam-s6-fixture.mjs';

if(process.env.OWNAPI_PG_ALLOW!=='1'||!process.env.OWNAPI_PG_PORT||[4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))throw Error('Explicit disposable PostgreSQL port required');
const DTZ='dtz-a2-b1',keys=['B1PREP_CONTENT_MODE','B1PREP_SERVE_REVIEW','B1PREP_SERVE_RIGHTS'],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
let db,mediaRoot,pkg,passed=0;
const q=p=>p.questions?.[0]??p.recordings?.[0].questions[0]??p.groups?.[0].questions[0]??p.situations?.[0]??p.gaps?.[0];
async function check(name,{family='LV1',change,blueprint=false,valid=false,renameId=false,numericWire=false}) {
 const set=pkg.internal.sets.find(s=>s.family===family),payload=structuredClone(blueprint?pkg.internal.blueprint:set.payload),answers=structuredClone(set.answers);
 const oldId=String(q(set.payload).n);change(payload);
 if(renameId){answers[String(q(payload).n)]=answers[oldId];if(String(q(payload).n)!==oldId)delete answers[oldId];}
 if(!blueprint){let accepted=true;try{objectiveItems(payload,set.interaction);}catch{accepted=false;}assert.equal(accepted,valid,name+': canonical objective expectation');}
 const c=await db.admin.connect();
 try {
  await c.query('BEGIN');await c.query('SET LOCAL session_replication_role=replica');
  if(blueprint)await c.query('UPDATE exam_blueprint SET payload=$1::jsonb WHERE exam_id=$2 AND version=$3',[JSON.stringify({...payload,exam:pkg.internal.exam}),DTZ,pkg.internal.blueprint.version]);
  else {await c.query('UPDATE objective_set SET payload=$1::jsonb WHERE set_id=$2 AND version=$3',[JSON.stringify(payload),set.setId,set.version]);await c.query('UPDATE objective_key SET answers=$1::jsonb WHERE set_id=$2 AND version=$3',[JSON.stringify(answers),set.setId,set.version]);
   if(numericWire)await c.query("UPDATE objective_set SET payload=jsonb_set(payload,'{questions,0,n}','1.0') WHERE set_id=$1 AND version=$2",[set.setId,set.version]);}
  const sql=(await c.query('SELECT * FROM current_release_eligibility($1,ARRAY[\'generated\'])',[DTZ])).rows[0];
  const read=await readReleasedForm(c,{examId:DTZ,formId:pkg.formId,formVersion:pkg.formVersion,releaseVersion:pkg.releaseVersion,newStart:true});
  assert.equal(Boolean(read&&!read.blockedReason),valid,name+': canonical reader expectation');
  assert.equal(sql.eligible,valid,name+': SQL must agree with canonical reader');
  await c.query('ROLLBACK');passed++;console.log('PASS '+name);
 }finally{await c.query('ROLLBACK');c.release();}
}
try {
 process.env.B1PREP_CONTENT_MODE='public';delete process.env.B1PREP_SERVE_REVIEW;delete process.env.B1PREP_SERVE_RIGHTS;
 mediaRoot=await mkdtemp(path.join(tmpdir(),'hatoove-s6-parity-'));db=await createFixture();pkg=await publishCompleteDtzFixture(db,{mediaRoot,version:'v9880',availableVersion:'v9881'});
 for(const role of ['learner','payments','worker'])for(const signature of ['s6_payload_text(jsonb,integer)','s6_payload_identity(jsonb,integer)','complete_dtz_objective_eligible(jsonb,text,integer,jsonb)'])
  assert.equal((await db.admin.query('SELECT has_function_privilege($1,$2,\'EXECUTE\') AS allowed',[db.roles[role],db.schema+'.'+signature])).rows[0].allowed,false,role+' cannot execute '+signature);
 passed++;console.log('PASS private helper authority remains restricted');
 await check('unchanged complete public package',{change:()=>{},valid:true});
 for(const family of ['LV1','LV2','LV3','LV5','HV1'])await check(family+' conflicting item alias',{family,change:p=>q(p).id='alien'});
 for(const value of [1.5,9007199254740992])await check('unsafe numeric item '+value,{change:p=>q(p).n=value,renameId:true});
 await check('equal item alias stays valid',{change:p=>q(p).id=q(p).n,valid:true});
 await check('safe numeric item identity',{change:p=>q(p).n=1,renameId:true,valid:true});
 await check('JSON numeric1.0 follows canonical String(number)',{change:p=>q(p).n=1,renameId:true,numericWire:true,valid:true});
 await check('null item alias',{change:p=>q(p).id=null});
 for(const field of ['answer','answers','answer_key','correct','correct_answer','solution','solutions','why','grammar','explanation','explanations','script','transcript'])
  await check('recursive protected '+field,{change:p=>p.extra=[{nested:{[field.toUpperCase()]:'private synthetic value'}}]});
 await check('root protected answer key',{change:p=>p.answers={'1':'a'}});
 for(const [label,change]of [
  ['51 options',p=>{for(let i=0;i<51;i++)q(p).options['extra'+i]='Synthetic';}],
  ['option key length33',p=>q(p).options['x'.repeat(33)]='Synthetic'],
  ['option text20001',p=>q(p).options[Object.keys(q(p).options)[0]]='x'.repeat(20001)],
  ['passage100001',p=>p.text='x'.repeat(100001)],
  ['question20001',p=>q(p).question='x'.repeat(20001)],
  ['UTF16 option overflow',p=>q(p).options[Object.keys(q(p).options)[0]]='😀'.repeat(10001)],
 ])await check(label,{change});
 for(const [label,change]of [
  ['option key32',p=>q(p).options['x'.repeat(32)]='Synthetic'],
  ['option text20000',p=>q(p).options[Object.keys(q(p).options)[0]]='x'.repeat(20000)],
  ['passage100000',p=>p.text='x'.repeat(100000)],
  ['question20000',p=>q(p).question='x'.repeat(20000)],
  ['UTF16 option boundary',p=>q(p).options[Object.keys(q(p).options)[0]]='😀'.repeat(10000)],
  ['non-protected extra metadata',p=>p.extra={nested:'public'}],
  ['single-choice whitespace follows canonical reader',p=>{p.text=' ';q(p).question=' ';}],
 ])await check(label,{change,valid:true});
 for(const [label,change]of [
  ['51 ads',p=>{for(let i=0;i<51;i++)p.ads.push({id:'extra'+i,text:'Synthetic'});}],
  ['numeric ad identity',p=>p.ads.push({id:88,text:'Synthetic'})],
  ['ad text20001',p=>p.ads[0].text='x'.repeat(20001)],
  ['ad identity33',p=>p.ads.push({id:'x'.repeat(33),text:'Synthetic'})],
  ['reserved x ad identity',p=>p.ads.push({id:'x',text:'Synthetic'})],
  ['missing ads',p=>delete p.ads],
 ])await check(label,{family:'LV2',change});
 await check('ad text20000',{family:'LV2',change:p=>p.ads[0].text='x'.repeat(20000),valid:true});
 await check('49 ads plus no-match is50 options',{family:'LV2',change:p=>{while(p.ads.length<49)p.ads.push({id:'extra'+p.ads.length,text:'Synthetic'});},valid:true});
 await check('50 ads plus no-match exceeds50 options',{family:'LV2',change:p=>{while(p.ads.length<50)p.ads.push({id:'extra'+p.ads.length,text:'Synthetic'});}});
 await check('safe numeric group identity',{family:'LV3',change:p=>p.groups[0].id=42,valid:true});
 await check('fractional group identity',{family:'LV3',change:p=>p.groups[0].id=1.5});
 await check('group passage100001',{family:'LV3',change:p=>p.groups[0].text='x'.repeat(100001)});
 for(const family of ['LV3','HV1'])for(const level of ['payload','group','question'])await check(family+' unknown '+level+' field',{family,change:p=>{const target=level==='payload'?p:level==='question'?q(p):p.groups?.[0]??p.recordings[0];target.extra=true;}});
 await check('recording identity whitespace',{family:'HV1',change:p=>p.recordings[0].id='invalid id'});
 await check('recording label1001',{family:'HV1',change:p=>p.recordings[0].label='x'.repeat(1001)});
 await check('recording label1000',{family:'HV1',change:p=>p.recordings[0].label='x'.repeat(1000),valid:true});
 for(const [name,value,valid]of [['NBSP','\u00a0',false],['FEFF','\ufeff',false],['NEL','\u0085',true],['zero width space','\u200b',true]]) {
  await check('audio label '+name,{family:'HV1',change:p=>p.recordings[0].label=value,valid});
  await check('audio question '+name,{family:'HV1',change:p=>q(p).question=value,valid});
  await check('group passage '+name,{family:'LV3',change:p=>p.groups[0].text=value,valid});
  await check('group question '+name,{family:'LV3',change:p=>q(p).question=value,valid});
 }
 await check('gap letter100001',{family:'LV5',change:p=>p.letter='x'.repeat(100001)});
 await check('time group invalid ID',{blueprint:true,change:p=>{p.timeGroups[0].id='invalid id';p.sections[0].timeGroup='invalid id';}});
 await check('time group unknown field',{blueprint:true,change:p=>p.timeGroups[0].extra=true});
 await check('valid renamed time group',{blueprint:true,change:p=>{p.timeGroups[0].id='synthetic-group';p.sections[0].timeGroup='synthetic-group';},valid:true});
 console.log('S6 canonical payload parity: '+passed+' passed (rollback-only synthetic mutations)');
}finally{try{await db?.cleanup();}finally{if(mediaRoot&&path.dirname(mediaRoot)===tmpdir()&&path.basename(mediaRoot).startsWith('hatoove-s6-parity-'))await rm(mediaRoot,{recursive:true,force:true});for(const[k,v]of Object.entries(saved))if(v===undefined)delete process.env[k];else process.env[k]=v;}}
