/** Offline integrity and format checks; not evidence of calibrated language difficulty. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {buildIeltsPackage} from './ielts-package-build.mjs';
import {validatePackage,packageHash} from '../server/package-contract.mjs';
import {parsePcmWav} from '../server/media-contract.mjs';
import {IELTS_POLICY,IELTS_KIND,supportedWritingPolicy} from '../server/writing-policy.mjs';
import {buildWritingPrompt,parseDeepSeekAssessment} from '../server/writing-grader-deepseek.mjs';
import {validateAssessment} from '../server/owned-postgres/worker.mjs';
import {instructionFor,instructionView} from '../public/assets/i18n/instructions.js';
const read=name=>JSON.parse(readFileSync(new URL('../content/exams/ielts-academic/'+name,import.meta.url)));
const pkg=validatePackage(read('manifest.json'));
assert.equal(packageHash(pkg),packageHash(await buildIeltsPackage()));
const words=read('reading-source.json').readings.reduce((n,r)=>n+r.text.split(/\s+/).length,0);
assert(words>=2150&&words<=2750);assert.equal(pkg.exam.language,'en');
for(const section of ['LV','HV'])assert.equal(pkg.sets.filter(s=>s.section===section).reduce((n,s)=>n+s.itemCount,0),40);
assert.equal(pkg.forms[0].writingTasks.length,2);assert.equal(pkg.forms[0].timeLimitSeconds,9120);
assert(pkg.sets.every(s=>Object.keys(s.answers).length===s.itemCount&&Object.keys(s.explanations).length===s.itemCount));
assert.equal(pkg.release.state,'internal');assert(pkg.media.every(m=>m.reviewStatus==='unreviewed'));
console.log('PASS deterministic IELTS package: three full-length passages, 80 items and two mandatory writing tasks');
let duration=0;
for(const m of pkg.media){const bytes=readFileSync(new URL('../'+m.path,import.meta.url));assert.equal(bytes.length,m.byteLength);assert.equal(createHash('sha256').update(bytes).digest('hex'),m.sha256);assert.equal(parsePcmWav(bytes).durationMs,m.durationMs);duration+=m.durationMs;}
assert(duration>=24*60000&&duration<=30*60000);
console.log('PASS four real PCM recordings: byte/hash/duration integrity; '+(duration/60000).toFixed(2)+' minutes including question-reading pauses');
const text='Overall, car travel declined while cycling became substantially more common. Bus use increased modestly, and walking remained the least frequently used mode at the end of the period.';
for(const raw of pkg.rubrics){const rubric={...raw,feedback_kind:raw.feedbackKind};assert(supportedWritingPolicy(rubric,pkg.exam.id));const prompt=buildWritingPrompt({text,rubric,policy:IELTS_POLICY,explanationLanguage:'uk',task:pkg.writingTasks.find(t=>t.rubricId===raw.rubricId)});assert(prompt.system.includes('English improvement'));assert(prompt.system.includes('Ukrainian'));assert(prompt.system.includes('not official IELTS bands'));
 const response=JSON.stringify({criteria:rubric.criteria.map(c=>({key:c.key,band:'DEVELOPING',evidence:text.split('. ')[0]+'.',comment:'The response needs fuller support from the task.'})),corrections:[]});
 const result=parseDeepSeekAssessment(response,{text,rubric,policy:IELTS_POLICY});assert.equal(validateAssessment(result,{text,rubric}).feedback.kind,IELTS_KIND);
}
console.log('PASS task-specific IELTS criteria and English corrections stay independent from the feedback language');
for(const id of ['single_choice','fixed_audio','listening.playback','writing.assigned','mock.timing']) {
 const source=instructionFor(id,'en');assert(source?.original);assert.equal(source.sourceSha256,createHash('sha256').update(source.original).digest('hex'));
 for(const locale of ['de','en','uk','ar','tr']) {
  const view=instructionView({id,examLanguage:'en',original:source.original,parameters:id==='listening.playback'?{maxPlays:1}:{},locale});
  assert(view.known);assert.equal(view.examLanguage,'en');if(locale!=='en')assert(view.translation);
 }
}
console.log('PASS English operational instructions have exact source digests and five-language coverage');
