/** Complete-form integration fixtures: internal content and technical PCM signals, never release approval. */
import { readFile } from 'node:fs/promises';
import { createListeningFixture } from './exam-s5-fixture.mjs';
import { WRITING_TASKS, TELC_B1_WRITING_RUBRIC } from '../server/owned-postgres/content-seed.mjs';
const source = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), 'utf8'));
export async function createCompleteFixture({examId='telc-deutsch-b1',mediaRoot,version='v9100',releaseVersion='v9100',blueprintVersion='v9100',durationMs=7000}={}) {
  const dtz=examId==='dtz-a2-b1';
  if(!dtz&&examId!=='telc-deutsch-b1')throw Error('Unsupported technical fixture exam');
  const audio=await createListeningFixture({examId,mediaRoot,version,releaseVersion,blueprintVersion,durationMs});
  const reading=await source('../content/exams/'+examId+'/manifest.json');
  const writing=dtz?await source('../content/exams/dtz-a2-b1/writing-manifest.json'):null;
  const groups=dtz?[{id:'dtz-hv-25',seconds:1500,sections:['HV']},{id:'dtz-lv-45',seconds:2700,sections:['LV']},{id:'dtz-sa-30',seconds:1800,sections:['SA']}]
    :[{id:'lv-sb-90',seconds:5400,sections:['LV','SB']},{id:'hv-30',seconds:1800,sections:['HV']},{id:'writing-30',seconds:1800,sections:['writing']}];
  const sectionById=new Map(reading.blueprint.sections.map(s=>[s.id,structuredClone(s)]));
  sectionById.set('HV',structuredClone(audio.blueprint.sections[0]));
  if(dtz)sectionById.set('SA',structuredClone(writing.blueprint.sections.find(s=>s.id==='SA')));
  const sections=groups.flatMap(group=>group.sections.map(id=>({...sectionById.get(id),timeGroup:group.id})));
  const readMembers=structuredClone(reading.forms[0].members);
  const sbMembers=dtz?[]:[{setId:'telc-deutsch-b1.sb1.01',version:'v1',interaction:'gap_choice',itemCount:10},{setId:'telc-deutsch-b1.sb2.01',version:'v1',interaction:'gap_bank',itemCount:10}];
  const audioMembers=structuredClone(audio.forms[0].members);
  const task=dtz?null:{...structuredClone(WRITING_TASKS[0]),taskId:'s5b.telc.writing.assigned',version,
    examId,family:'writing',section:'writing',rubricId:TELC_B1_WRITING_RUBRIC.rubricId,rubricVersion:TELC_B1_WRITING_RUBRIC.version,
    reviewStatus:'unreviewed',rightsStatus:'generated',source:'synthetic:exam-s5b-fixture; internal generated prompt, no educational approval'};
  const form={id:'s5b.'+examId+'.complete',version,title:'Schriftliche Prüfung · interne Technikprobe',scope:'complete_supported_written',
    sections:groups.flatMap(g=>g.sections),mode:'timed',timeLimitSeconds:groups.reduce((sum,g)=>sum+g.seconds,0),attemptMode:'mock',
    timingPolicy:'ordered-fixed-v1',feedback:'finalise',members:dtz?[...audioMembers,...readMembers]:[...readMembers,...sbMembers,...audioMembers],
    ...(dtz?{writingChoices:structuredClone(writing.forms[0].writingChoices)}:{writingTask:{section:'writing',taskId:task.taskId,taskVersion:task.version}})};
  return {schemaVersion:1,exam:reading.exam,blueprint:{version:blueprintVersion,timeGroups:groups,sections,assessment:reading.blueprint.assessment},
    release:{version:releaseVersion,state:'internal',resumeBlockedReleases:[]},forms:[form],
    sets:[...(dtz?reading.sets:[]),...audio.sets],media:audio.media,writingTasks:dtz?writing.writingTasks:[task],...(dtz?{rubrics:writing.rubrics}:{})};
}
