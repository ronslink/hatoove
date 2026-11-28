/** Explicit, bounded real-provider acceptance probe; never run by CI or startup. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {readDeepSeekConfig,createDeepSeekGrader,DEEPSEEK_PROVIDER_SELECTOR} from '../server/writing-grader-deepseek.mjs';
import {validateProviderIdentity,createUsageCapture,estimateAttemptCost} from '../server/provider-attempt-contract.mjs';
import {validateAssessment} from '../server/owned-postgres/worker.mjs';

if(process.argv[2]!=='--live')throw Error('Explicit --live required');
const config=readDeepSeekConfig(process.env);
if(config.mode!=='live')throw Error('Live provider required');
const pkg=JSON.parse(readFileSync(new URL('../content/exams/goethe-zertifikat-b2/manifest.json',import.meta.url)));
const rubric={...pkg.rubrics[0],feedback_kind:pkg.rubrics[0].feedbackKind};
const task=pkg.writingTasks[0];
// Authored acceptance response, not learner data or a predetermined assessment.
const text='Meiner Ansicht nach sollten Schulen künstliche Intelligenz gezielt einsetzen, ohne das selbstständige Denken zu ersetzen. Ein Werkzeug kann beispielsweise verschiedene Erklärungen anbieten, wenn jemand eine Aufgabe nicht versteht. Auch schnelle Rückmeldungen zu einem eigenen Text können helfen. Allerdings klingt eine falsche Antwort manchmal sehr überzeugend. Deshalb müssen Schülerinnen und Schüler lernen, Angaben mit verlässlichen Quellen zu vergleichen. Ein weiteres Risiko besteht darin, dass persönliche Daten an einen Anbieter übertragen werden. Namen oder vertrauliche Informationen gehören daher nicht in solche Programme. Ich schlage vor, dass jede Klasse zunächst gemeinsam an einem anonymen Beispiel arbeitet. Anschließend sollen die Lernenden ihre eigenen Lösungen entwickeln und dokumentieren, welche Unterstützung sie verwendet haben. Lehrkräfte sollten nicht nur das Ergebnis, sondern auch diesen Arbeitsprozess besprechen. Bei Prüfungen müssen eindeutige Regeln gelten. So lässt sich die Technik sinnvoll nutzen, während Verantwortung und Urteilsfähigkeit bei den Menschen bleiben. Dafür benötigen auch die Lehrkräfte Fortbildungen und genügend Zeit, um geeignete Aufgaben vorzubereiten.';
const identity=validateProviderIdentity(DEEPSEEK_PROVIDER_SELECTOR);
const capture=createUsageCapture(identity);
// This standalone probe has exactly one bounded call; no production ledger is touched.
const grade=createDeepSeekGrader({...config,dailyUsdLimit:0.05,estimateSpendUsdToday:async()=>0});
try{
 const result=await grade({text,task,rubric,policy:rubric.policy,explanationLanguage:'en'},capture);
 validateAssessment(result,{rubric,text});
 assert.equal(result.feedback.criteria.length,4);
 const receipt=capture.close();
 assert.equal(receipt.usageBasis,'reported');
 const cost=estimateAttemptCost(identity,{transportStatus:'response',receiptCaptured:true,receipt});
 console.log(JSON.stringify({passed:true,provider:identity.providerId,transport:identity.transportMode,requestedModel:identity.requestedModel,reportedModel:receipt.modelReported,criteria:result.feedback.criteria.map(c=>({key:c.key,band:c.band,evidenceExact:text.includes(c.evidence)})),tokens:{input:receipt.inputTokens,output:receipt.outputTokens},cost}));
}catch(error){console.error(JSON.stringify({passed:false,code:['grader_error','grader_budget_exceeded','invalid_assessment'].includes(error.code)?error.code:'live_check_failed'}));process.exitCode=1;}
