import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(process.argv[2] || '.');
// Match the tested source root and make German copy assertions independent of the host locale.
const { setLocale } = await import(pathToFileURL(path.join(root, 'public/assets/i18n/core.js')));
setLocale('de');
const { mockMember, mockReviewLabel, createMockSession } = await import(pathToFileURL(path.join(root, 'public/app/mock.js')));
const { initialPreparation, preparationChoices } = await import(pathToFileURL(path.join(root, 'public/app/preparation.js')));
const clone = value => JSON.parse(JSON.stringify(value));
let passed = 0;
const check = async (name, test) => { await test(); passed++; console.log('PASS '+name); };
const group = { set_id:'different-exam.reading',version:'v7',family:'LV3',section:'LV',interaction:'grouped_choice',item_count:4,
  payload:{groups:[{id:'notice',text:'First distinct passage.',questions:[{n:31,question:'Is this true?',options:{richtig:'Richtig',falsch:'Falsch'}},{n:32,question:'Which one?',options:{a:'First',b:'Second',c:'Third'}}]},
    {id:'letter',text:'Second distinct passage.',questions:[{n:33,question:'Another assertion?',options:{richtig:'Richtig',falsch:'Falsch'}},{n:34,question:'Which other?',options:{a:'One',b:'Two',c:'Three'}}]}]}};
const exams=[{exam_id:'telc-deutsch-b1',exam:'telc Deutsch B1'},{exam_id:'dtz-a2-b1',exam:'DTZ A2–B1'}];
const telc={id:'telc-preparation',exam_id:exams[0].exam_id,exam:exams[0].exam,state:'active'};
const dtz={id:'dtz-preparation',exam_id:exams[1].exam_id,exam:exams[1].exam,state:'active'};
await check('internal draft status is explicit and missing approval metadata stays unknown',()=>{
  assert.equal(mockReviewLabel({release_state:'internal',review_status:'unreviewed'}),'Interner Entwurf · Fachliche Prüfung ausstehend');
  assert.equal(mockReviewLabel({}),'Prüfstatus nicht angegeben');
});
await check('group order and question order define the stable flattened positions',()=>{
  const form=mockMember(group);assert.deepEqual(form.items.map(item=>item.id),['31','32','33','34']);assert.deepEqual(form.items.map(item=>item.groupId),['notice','notice','letter','letter']);
});
await check('each grouped item carries its own exact passage and mixed option identities',()=>{
  const items=mockMember(group).items;assert.equal(items[0].passage,'First distinct passage.');assert.equal(items[1].passage,items[0].passage);assert.equal(items[2].passage,'Second distinct passage.');
  assert.deepEqual(items[0].options.map(option=>option.id),['richtig','falsch']);assert.deepEqual(items[1].options.map(option=>option.id),['a','b','c']);
});
await check('interaction metadata takes precedence over familiar telc family labels',()=>{
  const misleading={...group,family:'SB2'};assert.equal(mockMember(misleading).items[3].passage,'Second distinct passage.');
  const directory={family:'LV1',interaction:'single_choice',payload:{text:'Directory',questions:[{n:21,question:'Where?',options:{a:'Desk',b:'Hall'}}]}};
  assert.equal(mockMember(directory).passage,'Directory');assert.equal(mockMember(directory).items[0].id,'21');assert.equal(mockMember({...directory,interaction:'unsupported'}),null);
});
await check('reading cloze keeps reading identity and exact letter/options',()=>{
  const cloze={family:'LV5',section:'LV',interaction:'gap_choice',payload:{letter:'Hello [40].',gaps:[{n:40,options:{a:'one',b:'two',c:'three'}}]}};
  const before=JSON.stringify(cloze),form=mockMember(cloze);assert.equal(form.passage,'Hello [40].');assert.equal(form.items[0].id,'40');assert.equal(form.items[0].options[2].id,'c');assert.equal(JSON.stringify(cloze),before);assert.equal(cloze.section,'LV');
});
await check('malformed groups and duplicate stable identities fail closed',()=>{
  const invalid=[];
  const changed=fn=>{const value=clone(group);fn(value.payload);invalid.push(value);};
  changed(p=>p.groups=[]);changed(p=>p.groups={});changed(p=>p.groups[1].id='notice');changed(p=>p.groups[1].questions[0].n=31);
  changed(p=>p.groups[0].text='');changed(p=>p.groups[0].questions=[]);changed(p=>p.groups[0].questions[0].question='');changed(p=>p.groups[0].questions[0].options={a:'Only'});changed(p=>p.groups[0].questions[0].options.richtig={private:true});
  for(const value of invalid)assert.equal(mockMember(value),null);
});
await check('new multi-exam account explicitly chooses despite default telc provisioning',()=>{
  assert.deepEqual(initialPreparation(exams,[telc]),{kind:'choose'});assert.deepEqual(initialPreparation(exams,[]),{kind:'choose'});
  assert.deepEqual(preparationChoices(exams,[telc]).map(choice=>choice.id),['telc-preparation','new:dtz-a2-b1']);
});
await check('default one-exam account retains its automatic existing or new preparation path',()=>{
  assert.deepEqual(initialPreparation([exams[0]],[telc]),{kind:'select',preparation:telc});assert.deepEqual(initialPreparation([exams[0]],[]),{kind:'create',examId:exams[0].exam_id});
});
await check('two owned preparations remain separate choices and archived history remains reachable',()=>{
  assert.deepEqual(preparationChoices(exams,[telc,dtz]).map(choice=>choice.id),['telc-preparation','dtz-preparation']);
  const rows=preparationChoices(exams,[telc,{...dtz,state:'archived'}]);assert.deepEqual(rows.map(row=>row.id),['telc-preparation','dtz-preparation','new:dtz-a2-b1']);assert.match(rows[1].label,/Archiv/);
});
await check('fresh run resume resolves the pinned group-specific passage and scalar answer',async()=>{
  const run={id:'run',revision:3,state:'active',responses:[{setId:group.set_id,version:group.version,itemId:'33',answer:'falsch'}],position:{member:0,item:2},members:[group],result:null};
  const session=createMockSession({api:{mock:{}}});session.load(run);const current=session.state();assert.equal(mockMember(current.run.members[0]).items[current.position.item].passage,'Second distinct passage.');assert.equal(current.responses[0].answer,'falsch');assert.equal(current.dirty,false);
});
await check('edits during save retain group identity while autosave flush drains before switching',async()=>{
  const run={id:'run',revision:1,state:'active',responses:[],position:{member:0,item:0},members:[group],result:null};let release;let calls=0;const sent=[];
  const session=createMockSession({api:{mock:{save:async(id,body)=>{sent.push(clone(body));calls++;if(calls===1)await new Promise(resolve=>{release=resolve;});return {ok:true,data:{...run,revision:body.expectedRevision+1,responses:body.responses,position:body.position}};}}},eventId:()=>String(calls)});session.load(run);
  session.answer(group,'31','richtig');const first=session.flush();session.answer(group,'34','b');const switchFlush=session.flush();release();assert.deepEqual(await Promise.all([first,switchFlush]),[true,true]);assert.equal(sent.length,2);assert.equal(sent[1].responses.find(row=>row.itemId==='34').answer,'b');
});
await check('stale-tab save preserves local grouped answer and reload stores its recovery copy',async()=>{
  const run={id:'run',revision:1,state:'active',responses:[],position:{member:0,item:2},members:[group],result:null};
  const session=createMockSession({api:{mock:{save:async()=>({ok:false,status:409,error:'revision_conflict'}),read:async()=>({ok:true,data:{...run,revision:2,responses:[{setId:group.set_id,version:group.version,itemId:'33',answer:'richtig'}]}})}}});session.load(run);session.answer(group,'33','falsch');assert.equal(await session.flush(),false);assert.equal(session.state().responses[0].answer,'falsch');
  await session.reload();assert.match(session.state().localCopy,/falsch/);assert.equal(session.state().responses[0].answer,'richtig');assert.equal(mockMember(session.state().run.members[0]).items[2].passage,'Second distinct passage.');
});
console.log(passed+' passed; synthetic interaction, selection and transport checks only.');
