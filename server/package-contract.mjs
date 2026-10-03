/** Declarative package validation with explicit supported-format policy. No SQL or provider calls. */
import { DTZ_KEYS, DTZ_BANDS, DTZ_POLICY, DTZ_KIND } from './writing-policy.mjs';
import { createHash } from 'node:crypto';
import { validateMediaDescriptor } from './media-contract.mjs';

export const INTERACTIONS = Object.freeze(['matching_headlines','single_choice','matching_ads','gap_choice','gap_bank','grouped_choice','fixed_audio']);
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const VERSION = /^v[0-9]{1,4}$/;
const object = v => v && typeof v === 'object' && !Array.isArray(v);
const invalid = message => { const e = new Error(message); e.code = 'invalid_package'; throw e; };
const demand = (v,message) => { if (!v) invalid(message); };
const text = (v,max=1000) => typeof v === 'string' && v.length>0 && v.length<=max;
const unique = a => new Set(a).size === a.length;
const keys = (o,allowed,at) => demand(object(o) && Object.keys(o).every(k=>allowed.includes(k)), `${at}: unknown field or invalid object`);
export function canonicalJson(value) {
  if (Array.isArray(value)) return '['+value.map(canonicalJson).join(',')+']';
  if (object(value)) return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJson(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
export const packageHash = value => createHash('sha256').update(canonicalJson(value)).digest('hex');
const SECRET = /^(answer|answers|answer_key|correct|correct_answer|solution|solutions|why|grammar|explanation|explanations|script|transcript)$/i;
export function assertPublicPayload(value) {
  if (Array.isArray(value)) { value.forEach(assertPublicPayload); return; }
  if (!object(value)) return;
  for (const [k,v] of Object.entries(value)) { demand(!SECRET.test(k),`protected field in public payload: ${k}`); assertPublicPayload(v); }
}

/** Item identities and offered answer vocabularies; reused by importer reference checks. */
export function objectiveItems(payload,interaction) {
  demand(object(payload) && INTERACTIONS.includes(interaction),'unsupported interaction');
  assertPublicPayload(payload);
  let rows,choices;
  const bank=(values,label)=>{
    demand(Array.isArray(values) && values.length>1 && values.length<=50 && values.every(x=>object(x)&&text(x.id,32)&&text(x[label],20000)),'invalid option text/bank');
    return values.map(x=>x.id);
  };
  if (interaction==='matching_headlines') { rows=payload.texts; choices=bank(payload.headlines,'text'); }
  if (interaction==='matching_ads') { rows=payload.situations; choices=[...bank(payload.ads,'text'),'x']; }
  if (interaction==='single_choice') rows=payload.questions;
  if (interaction==='fixed_audio') {
    keys(payload,['recordings'],'audio payload');
    demand(Array.isArray(payload.recordings) && payload.recordings.length>0 && payload.recordings.length<=100,'invalid recordings');
    rows=[];
    for(const recording of payload.recordings) {
      keys(recording,['id','mediaId','mediaVersion','label','questions'],'recording');
      demand(text(recording.id,128)&&ID.test(recording.id)&&text(recording.mediaId,128)&&ID.test(recording.mediaId)&&VERSION.test(recording.mediaVersion),'invalid recording identity');
      demand(text(recording.label,1000)&&recording.label.trim().length>0&&Array.isArray(recording.questions)&&recording.questions.length>0,'invalid recording label/questions');
      for(const row of recording.questions) {
        keys(row,['n','question','options'],'audio question');
        demand(text(row.question,20000)&&row.question.trim().length>0,'missing audio question');
        rows.push(row);
      }
    }
    demand(unique(payload.recordings.map(r=>r.id)),'duplicate recording');
    demand(unique(payload.recordings.map(r=>r.mediaId+'@'+r.mediaVersion)),'duplicate recording media');
  }
  if (interaction==='grouped_choice') {
    keys(payload,['groups'],'grouped payload');
    demand(Array.isArray(payload.groups) && payload.groups.length>0 && payload.groups.length<=100,'invalid groups');
    const groupIds=[];
    rows=[];
    for (const group of payload.groups) {
      keys(group,['id','text','questions'],'group');
      demand((typeof group.id==='string' || Number.isSafeInteger(group.id)) && text(String(group.id),32) && ID.test(String(group.id)),'invalid group identity');
      demand(text(group.text,100000) && group.text.trim().length>0 && Array.isArray(group.questions) && group.questions.length>0,'invalid group passage/questions');
      groupIds.push(String(group.id));
      for (const row of group.questions) {
        keys(row,['n','question','options'],'group question');
        demand(text(row.question,20000) && row.question.trim().length>0,'missing question text');
        rows.push(row);
      }
    }
    demand(unique(groupIds),'duplicate group');
  }
  if (interaction==='gap_choice' || interaction==='gap_bank') rows=payload.gaps;
  if (interaction==='gap_bank') choices=bank(payload.bank,'word');
  if (interaction==='single_choice') demand(text(payload.text,100000),'missing passage text');
  if (interaction==='gap_choice'||interaction==='gap_bank') demand(text(payload.letter,100000),'missing gap-fill text');
  demand(Array.isArray(rows) && rows.length>0 && rows.length<=100,'missing or oversized items');
  if (choices) demand(choices.length>1 && choices.every(x=>text(x,32)) && unique(choices),'invalid answer bank');
  const items=rows.map(row=>{
    demand(object(row),'invalid item');
    const rawId=interaction==='matching_headlines' ? row.id : row.n;
    demand(typeof rawId==='string' || Number.isSafeInteger(rawId),'invalid item identity');
    const id=String(rawId);
    demand(interaction==='matching_headlines' || row.id===undefined || ((typeof row.id==='string' || Number.isSafeInteger(row.id)) && String(row.id)===id),'conflicting item identity');
    if(interaction==='matching_headlines'||interaction==='matching_ads') demand(text(row.text,20000),'missing item text');
    if(interaction==='single_choice') demand(text(row.question,20000),'missing question text');
    if(!choices) demand(object(row.options)&&Object.values(row.options).every(v=>text(v,20000)),'invalid option text');
    const options=choices || (object(row.options)?Object.keys(row.options):[]);
    demand(text(id,32) && ID.test(id) && options.length>1 && options.length<=50 && options.every(x=>text(x,32)) && unique(options),'invalid item identity/options');
    return {id,options};
  });
  demand(unique(items.map(x=>x.id)),'duplicate item');
  return items;
}

export function validatePackage(input) {
  // JSON-only inputs have bounded size/depth and no executable package fields.
  let source;
  try { source=JSON.stringify(input); } catch { invalid('not JSON'); }
  demand(source && source.length<=2_000_000,'package too large');
  const p=JSON.parse(source);
  keys(p,['schemaVersion','exam','blueprint','release','forms','sets','writingTasks','rubrics','media'],'package');
  demand(p.schemaVersion===1,'unsupported schemaVersion');
  keys(p.exam,['id','title','language','levelModel'],'exam');
  demand(text(p.exam.id,64) && /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.exam.id) && text(p.exam.title,200) && text(p.exam.language,40) && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(p.exam.language),'invalid exam');
  demand(object(p.exam.levelModel) && text(p.exam.levelModel.type,40),'invalid level model');
  assertPublicPayload(p.exam);
  // The declared scale has a numeric `correct` value; it is a scoring rule, not an answer key.
  assertPublicPayload({...p.blueprint,assessment:undefined});
  keys(p.blueprint,['version','sections','assessment','sources','timeGroups'],'blueprint');
  demand(VERSION.test(p.blueprint.version),'invalid blueprint version');
  demand(Array.isArray(p.blueprint.sections) && p.blueprint.sections.length>0 && p.blueprint.sections.length<=20,'invalid sections');
  for (const s of p.blueprint.sections) {
    keys(s,['id','title','parts','timeGroup'],'section');
    demand(text(s.id,128) && ID.test(s.id) && text(s.title,200) && Array.isArray(s.parts) && s.parts.length>0 && s.parts.length<=20,'invalid section');
    for (const part of s.parts) {
      keys(part,['family','itemCount','interaction','mediaRequired','playback'],'part');
      demand(text(part.family,128) && ID.test(part.family) && Number.isSafeInteger(part.itemCount) && part.itemCount>0 && part.itemCount<=100 && text(part.interaction,40) && typeof part.mediaRequired==='boolean','invalid blueprint part');
      if(part.playback!==undefined) validatePlayback(part,p.exam.id);
    }
    demand(unique(s.parts.map(x=>x.family)),'duplicate part');
  }
  demand(unique(p.blueprint.sections.map(x=>x.id)),'duplicate section');
  const scale=p.blueprint.assessment;
  keys(scale,['policy','correct','incorrect'],'assessment');
  demand(scale.policy==='objective-count-v1' && Number.isFinite(scale.correct) && scale.correct>0 && Number.isFinite(scale.incorrect) && scale.incorrect>=0 && scale.incorrect<scale.correct,'unsupported assessment scale');
  keys(p.release,['version','state','resumeBlockedReleases'],'release');
  demand(VERSION.test(p.release.version) && ['hidden','internal','available','withdrawn'].includes(p.release.state),'invalid release');
  p.release.resumeBlockedReleases ??= [];
  demand(Array.isArray(p.release.resumeBlockedReleases) && p.release.resumeBlockedReleases.length<=100 && p.release.resumeBlockedReleases.every(v=>VERSION.test(v)) && unique(p.release.resumeBlockedReleases),'invalid resume restrictions');
  demand(Array.isArray(p.forms) && p.forms.length<=100,'invalid forms');
  demand(p.forms.length>0 || ['hidden','withdrawn'].includes(p.release.state),'empty release');
  demand(unique(p.forms.map(f=>f.id+'@'+f.version)),'duplicate form');
  for (const f of p.forms) {
    keys(f,['id','version','title','scope','sections','mode','timeLimitSeconds','feedback','members','writingChoices','attemptMode'],'form');
    demand(text(f.id,128) && ID.test(f.id) && VERSION.test(f.version) && text(f.title,200),'invalid form identity');
    demand(['section','complete_supported_written'].includes(f.scope) && f.feedback==='finalise','unsupported form policy');
    demand(Array.isArray(f.sections) && f.sections.length>0 && unique(f.sections) && f.sections.every(id=>p.blueprint.sections.some(s=>s.id===id)),'invalid form sections');
    demand((f.mode==='untimed' && f.timeLimitSeconds===null) || (f.mode==='timed' && Number.isSafeInteger(f.timeLimitSeconds) && f.timeLimitSeconds>=1 && f.timeLimitSeconds<=86400),'invalid timing');
    demand(Array.isArray(f.members) && (f.members.length>0 || f.writingChoices?.length===1) && f.members.length<=50 && unique(f.members.map(m=>m.setId+'@'+m.version)),'invalid/duplicate members');
    for (const m of f.members) {
      keys(m,['setId','version','interaction','itemCount'],'member');
      demand(text(m.setId,128) && ID.test(m.setId) && VERSION.test(m.version) && INTERACTIONS.includes(m.interaction) && Number.isSafeInteger(m.itemCount) && m.itemCount>0 && m.itemCount<=100,'invalid member');
    }
    if(f.members.some(m=>m.interaction==='fixed_audio')) {
      demand(['practice','mock'].includes(f.attemptMode),'listening form requires attemptMode');
      validateListeningBlueprint(p);
      for(const id of f.sections) for(const part of p.blueprint.sections.find(s=>s.id===id).parts)
        if(part.mediaRequired) validatePlayback(part,p.exam.id);
    } else demand(f.attemptMode===undefined,'attemptMode requires listening');
    demand(f.members.reduce((sum,m)=>sum+m.itemCount,0)<=500,'form exceeds saved response limit');
    if (f.writingChoices !== undefined) {
      demand(Array.isArray(f.writingChoices) && f.writingChoices.length===1,'one writing choice group required');
      for (const choice of f.writingChoices) {
        keys(choice,['id','section','options'],'writing choice');
        demand(text(choice.id,128)&&ID.test(choice.id)&&f.sections.includes(choice.section),'invalid writing choice');
        demand(Array.isArray(choice.options)&&choice.options.length===2&&choice.options[0].id==='A'&&choice.options[1].id==='B','writing options must be A/B');
        for(const o of choice.options) { keys(o,['id','taskId','taskVersion'],'writing option'); demand(text(o.taskId,128)&&ID.test(o.taskId)&&VERSION.test(o.taskVersion),'invalid writing option'); }
        demand(unique(choice.options.map(o=>o.taskId+'@'+o.taskVersion)),'duplicate writing option');
      }
    }
    if (f.scope==='complete_supported_written') {
      // S2 deliberately ships no complete-written capability. A shortened blueprint cannot evade
      // missing listening/writing by redefining the target examination's supported scope.
      invalid('complete written forms require the later reviewed media/writing contract');
    }
  }
  p.sets ??=[];
  demand(Array.isArray(p.sets) && p.sets.length<=200 && unique(p.sets.map(s=>s.setId+'@'+s.version)),'invalid/duplicate sets');
  for (const s of p.sets) {
    keys(s,['setId','version','examId','family','section','part','title','payload','itemCount','interaction','answers','explanations','reviewStatus','rightsStatus','source'],'set');
    demand(text(s.setId,128) && ID.test(s.setId) && VERSION.test(s.version) && s.examId===p.exam.id && text(s.family,128) && ID.test(s.family) && text(s.title,200) && Number.isInteger(s.part) && s.part>0,'invalid set identity');
    const section=p.blueprint.sections.find(x=>x.id===s.section);
    const part=section?.parts.find(x=>x.family===s.family);
    demand(part && part.interaction===s.interaction && part.mediaRequired===(s.interaction==='fixed_audio'),'set blueprint mismatch');
    if(s.interaction==='fixed_audio') {validateListeningBlueprint(p);validatePlayback(part,p.exam.id);}
    const items=objectiveItems(s.payload,s.interaction);
    demand(items.length===s.itemCount && s.itemCount===part.itemCount,'item count mismatch');
    demand(object(s.answers) && Object.keys(s.answers).length===items.length && items.every(i=>i.options.includes(s.answers[i.id])),'invalid answer key');
    demand(object(s.explanations) && Object.keys(s.explanations).every(k=>items.some(i=>i.id===k) && text(s.explanations[k],4000)),'invalid explanations');
    demand(['approved','unreviewed'].includes(s.reviewStatus) && ['generated','licensed','commissioned','unknown'].includes(s.rightsStatus) && text(s.source,500),'invalid source/review/rights');
    // The importer cannot grant educational or legal approval. It imports draft/generated source only;
    // an available release must reference separately approved existing database content.
    demand(s.reviewStatus==='unreviewed' && s.rightsStatus==='generated','new imports require separate review/rights approval');
  }
  if(p.media!==undefined) {
    demand(Array.isArray(p.media)&&p.media.length<=200&&unique(p.media.map(m=>m.mediaId+'@'+m.version)),'invalid/duplicate media');
    for(const media of p.media) validateMediaDescriptor(media,p.exam.id);
  }
  const hadRubrics=Object.hasOwn(p,'rubrics'),hadWriting=Object.hasOwn(p,'writingTasks');
  p.rubrics ??=[]; p.writingTasks ??=[];
  demand(Array.isArray(p.rubrics)&&p.rubrics.length<=20&&unique(p.rubrics.map(r=>r.rubricId+'@'+r.version)),'invalid rubrics');
  for(const r of p.rubrics) {
    keys(r,['rubricId','version','examId','family','policy','feedbackKind','criteria','reviewStatus','rightsStatus','source'],'rubric');
    demand(text(r.rubricId,128)&&ID.test(r.rubricId)&&VERSION.test(r.version)&&r.examId===p.exam.id&&r.family==='writing','invalid rubric identity');
    demand(r.examId==='dtz-a2-b1'&&r.policy===DTZ_POLICY&&r.feedbackKind===DTZ_KIND,'unsupported writing policy');
    demand(Array.isArray(r.criteria)&&r.criteria.length===4&&unique(r.criteria.map(c=>c.key))&&DTZ_KEYS.every(k=>r.criteria.some(c=>c.key===k)),'invalid DTZ criteria');
    for(const c of r.criteria) {
      keys(c,['key','label','bands','bandLabels','descriptors'],'criterion');
      demand(text(c.label,200)&&canonicalJson(c.bands)===canonicalJson(DTZ_BANDS),'invalid DTZ scale');
      for(const field of ['bandLabels','descriptors']) demand(object(c[field])&&Object.keys(c[field]).length===6&&Object.keys(DTZ_BANDS).every(k=>text(c[field][k],2000)),'invalid criterion '+field);
    }
    demand(r.reviewStatus==='unreviewed'&&r.rightsStatus==='generated'&&text(r.source,1000),'new rubrics need separate review');
  }
  demand(Array.isArray(p.writingTasks)&&p.writingTasks.length<=100&&unique(p.writingTasks.map(t=>t.taskId+'@'+t.version)),'invalid writing tasks');
  for(const t of p.writingTasks) {
    keys(t,['taskId','version','examId','family','section','register','topic','situation','adressat','leitpunkte','rubricId','rubricVersion','reviewStatus','rightsStatus','source'],'writing task');
    demand(text(t.taskId,128)&&ID.test(t.taskId)&&VERSION.test(t.version)&&t.examId===p.exam.id&&t.family==='writing','invalid writing identity');
    const part=p.blueprint.sections.find(s=>s.id===t.section)?.parts.find(x=>x.family===t.family);
    demand(part?.interaction==='writing_choice'&&part.itemCount===1&&!part.mediaRequired,'writing blueprint mismatch');
    demand(['du','Sie'].includes(t.register)&&text(t.topic,200)&&text(t.situation,12000)&&text(t.adressat,1000)&&Array.isArray(t.leitpunkte)&&t.leitpunkte.length===4&&t.leitpunkte.every(x=>text(x,2000)),'invalid writing prompt');
    demand(text(t.rubricId,128)&&ID.test(t.rubricId)&&VERSION.test(t.rubricVersion),'invalid writing rubric');
    demand(t.reviewStatus==='unreviewed'&&t.rightsStatus==='generated'&&text(t.source,1000),'new writing tasks need separate review');
  }
  if (p.release.state==='available' && p.exam.id==='dtz-a2-b1') {
    demand(p.forms.some(f=>f.scope==='complete_supported_written'),'DTZ requires the complete written package');
    demand(p.blueprint.sections.some(s=>s.parts.some(x=>x.mediaRequired)),'DTZ requires reviewed listening');
  }
  if(!hadRubrics) delete p.rubrics; if(!hadWriting) delete p.writingTasks;
  const contentIds=[...p.sets.map(s=>s.setId+'@'+s.version),...(p.media||[]).map(m=>m.mediaId+'@'+m.version),
    ...(p.rubrics||[]).map(r=>r.rubricId+'@'+r.version),...(p.writingTasks||[]).map(t=>t.taskId+'@'+t.version)];
  demand(unique(contentIds),'content identity used by multiple records');
  return p;
}

/** Dormant historical blueprints keep their hashes; actual listening needs the exact policy. */
export function validatePlayback(part,examId) {
  demand(part.mediaRequired===true&&part.interaction==='fixed_audio','playback requires fixed audio');
  keys(part.playback,['practice','mock'],'playback');
  demand(['practice','mock'].every(mode=>Number.isSafeInteger(part.playback[mode])&&part.playback[mode]>0&&part.playback[mode]<=10),'invalid playback allowance');
  const expected=examId==='dtz-a2-b1'?1:examId==='telc-deutsch-b1'?({HV1:1,HV2:2,HV3:2}[part.family]):null;
  if(expected!==null) demand(expected!==undefined&&part.playback.practice===expected&&part.playback.mock===expected,'incorrect target playback policy');
  return part.playback;
}

function validateListeningBlueprint(p) {
  const counts=p.exam.id==='dtz-a2-b1'?[4,5,8,3]:p.exam.id==='telc-deutsch-b1'?[5,10,5]:null;
  if(!counts) return;
  const section=p.blueprint.sections.find(s=>s.id==='HV');
  demand(section?.parts.length===counts.length&&section.parts.every((part,i)=>part.family==='HV'+(i+1)&&part.itemCount===counts[i]&&part.mediaRequired&&part.interaction==='fixed_audio'),'incorrect target listening format');
  demand(p.blueprint.sections.filter(s=>s.id!=='HV').every(s=>s.parts.every(part=>!part.mediaRequired&&part.interaction!=='fixed_audio')),'listening outside target section');
  for(const part of section.parts) validatePlayback(part,p.exam.id);
}
