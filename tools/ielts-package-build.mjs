/** Deterministic original IELTS Academic reading/listening/writing package, human review pending. */
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {validatePackage} from '../server/package-contract.mjs';
const dir=new URL('../content/exams/ielts-academic/',import.meta.url);
const read=async name=>JSON.parse(await readFile(new URL(name,dir),'utf8'));
export async function buildIeltsPackage(){
 const [reading,listening,writing,media]=await Promise.all(['reading-source.json','listening-source.json','writing-source.json','listening-media.json'].map(read));
 const exam={id:'ielts-academic',title:'IELTS Academic',language:'en',levelModel:{type:'ielts-band-scale',min:0,max:9}};
 const common={version:'v1',examId:exam.id,reviewStatus:'unreviewed',rightsStatus:'generated'};
 const lv=reading.readings.map((r,i)=>({...common,setId:`ielts-academic.lv${i+1}.original01`,family:r.family,section:'LV',part:i+1,title:r.title,
  interaction:'single_choice',itemCount:r.questions.length,payload:{text:r.text,questions:r.questions.map(({n,question,options})=>({n,question,options}))},
  answers:Object.fromEntries(r.questions.map(q=>[q.n,q.answer])),explanations:Object.fromEntries(r.questions.map(q=>[q.n,q.explanation])),source:reading.provenance}));
 const hv=listening.parts.map(p=>({...common,setId:`ielts-academic.${p.family.toLowerCase()}.original01`,family:p.family,section:'HV',part:p.part,title:p.title,
  interaction:'fixed_audio',itemCount:10,payload:{recordings:p.recordings.map(r=>({id:r.id,mediaId:r.mediaId,mediaVersion:r.mediaVersion,label:r.label,questions:r.questions.map(({n,question,options})=>({n,question,options}))}))},
  answers:Object.fromEntries(p.recordings.flatMap(r=>r.questions.map(q=>[q.n,q.answer]))),explanations:Object.fromEntries(p.recordings.flatMap(r=>r.questions.map(q=>[q.n,q.explanation]))),source:listening.source}));
 const members=sets=>sets.map(s=>({setId:s.setId,version:s.version,interaction:s.interaction,itemCount:s.itemCount}));
 const bindings=writing.writingTasks.map((t,i)=>({id:'task'+(i+1),section:'SA',taskId:t.taskId,taskVersion:t.version}));
 const sections=[{id:'HV',title:'Listening',timeGroup:'listening-32',parts:hv.map(s=>({family:s.family,itemCount:10,interaction:'fixed_audio',mediaRequired:true,playback:{practice:1,mock:1}}))},
  {id:'LV',title:'Academic Reading',timeGroup:'reading-60',parts:lv.map(s=>({family:s.family,itemCount:s.itemCount,interaction:'single_choice',mediaRequired:false}))},
  {id:'SA',title:'Academic Writing',timeGroup:'writing-60',parts:[{family:'writing',itemCount:2,interaction:'extended_writing',mediaRequired:false}]}];
 const sources=[['listening','https://takeielts.britishcouncil.org/what-is-ielts/how-it-works/test-format/listening'],['reading','https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-reading'],['writing','https://ielts.org/take-a-test/test-types/ielts-academic-test/ielts-academic-format-writing']].map(([id,url])=>({id,kind:'official-exam-specification',title:'IELTS Academic '+id,url,retrieved:'2026-11-28',verification:'Format reference only. Original practice content. Computer-style listening allows a two-minute review; no paper answer-transfer period. Speaking excluded. No official overall band or calibration claim.'}));
 const forms=[{id:'ielts-academic.complete.original01',version:'v1',title:'IELTS Academic: Listening, Reading and Writing practice',scope:'complete_supported_written',sections:['HV','LV','SA'],mode:'timed',timeLimitSeconds:9120,attemptMode:'mock',timingPolicy:'ordered-fixed-v1',feedback:'finalise',members:[...members(hv),...members(lv)],writingTasks:bindings},
  {id:'ielts-academic.reading.original01',version:'v1',title:'Academic Reading: three passages',scope:'section',sections:['LV'],mode:'timed',timeLimitSeconds:3600,feedback:'finalise',members:members(lv)},
  {id:'ielts-academic.listening.original01',version:'v1',title:'Listening: four parts',scope:'section',sections:['HV'],mode:'timed',timeLimitSeconds:1920,attemptMode:'mock',feedback:'finalise',members:members(hv)},
  {id:'ielts-academic.writing.original01',version:'v1',title:'Academic Writing: report and essay',scope:'section',sections:['SA'],mode:'timed',timeLimitSeconds:3600,feedback:'finalise',members:[],writingTasks:bindings}];
 const pkg={schemaVersion:1,exam,blueprint:{version:'v1',sections,timeGroups:[{id:'listening-32',seconds:1920,sections:['HV']},{id:'reading-60',seconds:3600,sections:['LV']},{id:'writing-60',seconds:3600,sections:['SA']}],assessment:{policy:'objective-count-v1',correct:1,incorrect:0},sources},release:{version:'v1',state:'internal',resumeBlockedReleases:[]},forms,sets:[...hv,...lv],media:media.media,writingTasks:writing.writingTasks,rubrics:writing.rubrics};
 return validatePackage(pkg);
}
if(process.argv[1]&&pathToFileURL(process.argv[1]).href===import.meta.url){const p=await buildIeltsPackage();await writeFile(new URL('manifest.json',dir),JSON.stringify(p,null,2)+'\n');console.log('Built IELTS Academic: 80 objective items, 2 required writing tasks, '+p.media.length+' recordings; internal/unreviewed.');}
