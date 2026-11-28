#!/usr/bin/env node
/**
 * D10 offline unit tests for `server/writing-grader-deepseek.mjs`.
 * Zero live network calls — uses injected mock `fetchImpl` and mock daily counter.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  readDeepSeekConfig,
  createDeepSeekGrader,
  DEFAULT_DAILY_USD_LIMIT,
  DEFAULT_DEEPSEEK_MODEL,
  DEEPSEEK_PROMPT_VERSION,
  buildWritingPrompt, parseDeepSeekAssessment, DEEPSEEK_PROVIDER_SELECTOR,
} from '../server/writing-grader-deepseek.mjs';
import { validateAssessment } from '../server/owned-postgres/worker.mjs';
import { TELC_B1_WRITING_RUBRIC } from '../server/owned-postgres/content-seed.mjs';
import { DTZ_POLICY } from '../server/writing-policy.mjs';
import {validateProviderIdentity,normalizeUsageReceipt,estimateAttemptCost} from '../server/provider-attempt-contract.mjs';

const rawDtzRubric = JSON.parse(readFileSync(new URL('../content/exams/dtz-a2-b1/writing-manifest.json', import.meta.url), 'utf8')).rubrics[0];
const dtzRubric = { ...rawDtzRubric, feedback_kind: rawDtzRubric.feedbackKind };
const sampleText = 'Sehr geehrte Damen und Herren, ich schreibe Ihnen wegen meiner Monatskarte. Letzte Woche wurde sie an der Haltestelle nicht erkannt. Bitte senden Sie mir eine neue Karte. Mit freundlichen Grüßen';
const fakeKey = 'test-key-synthetic-never-leak-12345';

let passed = 0;
async function check(name, fn) {
  await fn();
  passed += 1;
  console.log('PASS ' + name);
}

await check('runtime requires live credentials and permits stubs only in explicit test mode', async () => {
  assert.throws(()=>readDeepSeekConfig({}), /grader_configuration_invalid/);
  assert.throws(()=>readDeepSeekConfig({ HATOVE_GRADER_MODE: 'stub' }), /grader_configuration_invalid/);
  assert.deepEqual(readDeepSeekConfig({ HATOVE_GRADER_MODE: 'stub', NODE_ENV:'test' }), { mode: 'stub' });
  assert.throws(()=>readDeepSeekConfig({DEEPSEEK_API_KEY:fakeKey,DEEPSEEK_MODEL:'deepseek-chat'}), /grader_configuration_invalid/);
  assert.throws(()=>readDeepSeekConfig({DEEPSEEK_API_KEY:fakeKey,DEEPSEEK_ENDPOINT:'https://example.org'}), /grader_configuration_invalid/);
  assert.throws(() => readDeepSeekConfig({ HATOVE_GRADER_MODE: 'unknown' }), /grader_configuration_invalid/);
  assert.throws(() => readDeepSeekConfig({ HATOVE_GRADER_MODE: 'live' }), /grader_configuration_invalid/);
  assert.throws(() => readDeepSeekConfig({ HATOVE_GRADER_MODE: 'live', DEEPSEEK_API_KEY: fakeKey, HATOVE_GRADER_DAILY_USD_LIMIT: '0' }), /grader_configuration_invalid/);
  const live = readDeepSeekConfig({ HATOVE_GRADER_MODE: 'live', DEEPSEEK_API_KEY: fakeKey });
  assert.equal(live.mode, 'live');
  assert.equal(live.model, DEFAULT_DEEPSEEK_MODEL);
  assert.equal(live.dailyUsdLimit, DEFAULT_DAILY_USD_LIMIT);
  assert.equal(readDeepSeekConfig({ HATOVE_GRADER_MODE: 'live', DEEPSEEK_API_KEY: fakeKey, HATOVE_GRADER_DAILY_USD_LIMIT: '15.50' }).dailyUsdLimit, 15.5);
});

await check('telc B1 response validates cleanly and captures reported token usage', async () => {
  let captured = null;
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return {
      ok: true,
      async json() {
        return {
          choices: [{
            message: {
              content: JSON.stringify({
                criteria: [
                  { key: 'aufgabe', band: 'B', evidence: 'ich schreibe Ihnen wegen meiner Monatskarte.', comment: 'Alle Punkte wurden angesprochen.' },
                  { key: 'kommunikation', band: 'A', evidence: 'Sehr geehrte Damen und Herren,', comment: 'Passende formelle Anrede.' },
                  { key: 'richtigkeit', band: 'B', evidence: 'Bitte senden Sie mir eine neue Karte.', comment: 'Gut verständlicher Satzbau.' },
                ],
                corrections: ['Bitte erstatten Sie mir zusätzlich das Einzelticket.'],
              }),
            },
          }],
          usage: { prompt_tokens: 420, completion_tokens: 180, prompt_cache_hit_tokens: 120 },
        };
      },
    };
  };
  const grade = createDeepSeekGrader({ apiKey: fakeKey, dailyUsdLimit: 15, fetchImpl, estimateSpendUsdToday: async () => 14.9 });
  const assessment = await grade(
    { text: sampleText, rubric: TELC_B1_WRITING_RUBRIC, policy: null, explanationLanguage: 'de' },
    { captureUsage: (u) => { captured = u; } }
  );
  assert.equal(calls, 1);
  assert.equal(assessment.modelVersion, DEFAULT_DEEPSEEK_MODEL);
  assert.equal(assessment.promptVersion, DEEPSEEK_PROMPT_VERSION);
  validateAssessment(assessment, { rubric: TELC_B1_WRITING_RUBRIC, text: sampleText });
  assert.deepEqual(captured, {
    usageBasis: 'reported',
    modelReported: null,
    inputTokens: 420,
    outputTokens: 180,
    cachedInputTokens: 120,
    reasoningOutputTokens: null,
  });
});

await check('DTZ paraphrased evidence is rejected instead of fabricated', async () => {
  const fetchImpl = async () => ({
    ok: true,
    async json() {
      return {
        choices: [{
          message: {
            content: JSON.stringify({
              criteria: [
                { key: 'dtz_aufgabe', band: 'B1', evidence: 'not an exact substring', comment: 'Good coverage.' },
                { key: 'dtz_kommunikation', band: 'B1_PLUS', evidence: 'Sehr geehrte Damen und Herren,', comment: 'Formal register fits.' },
                { key: 'dtz_korrektheit', band: 'B1', evidence: 'Bitte senden Sie mir eine neue Karte.', comment: 'Clear grammar.' },
                { key: 'dtz_wortschatz', band: 'A2_PLUS', evidence: 'Monatskarte', comment: 'Appropriate vocabulary.' },
              ],
              corrections: [],
            }),
          },
        }],
      };
    },
  });
  const grade = createDeepSeekGrader({ apiKey: fakeKey, dailyUsdLimit: 15, fetchImpl, estimateSpendUsdToday: async () => 0.12 });
  await assert.rejects(grade({ text: sampleText, rubric: dtzRubric, policy: DTZ_POLICY, explanationLanguage: 'en' }, {}), /grader_error/);
});

await check('hard $15/day USD spend cap refuses before any HTTP call when reached', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not be called'); };
  const grade = createDeepSeekGrader({ apiKey: fakeKey, dailyUsdLimit: 15, fetchImpl, estimateSpendUsdToday: async () => 15.0 });
  await assert.rejects(
    grade({ text: sampleText, rubric: TELC_B1_WRITING_RUBRIC, policy: null, explanationLanguage: 'de' }, {}),
    (err) => err.code === 'grader_budget_exceeded'
  );
  assert.equal(calls, 0);
});

await check('provider HTTP failures throw fixed grader_error without leaking API key', async () => {
  const fetchImpl = async () => ({ ok: false, status: 502, async json() { return { error: fakeKey }; } });
  const grade = createDeepSeekGrader({ apiKey: fakeKey, dailyUsdLimit: 15, fetchImpl, estimateSpendUsdToday: async () => 0 });
  await assert.rejects(
    grade({ text: sampleText, rubric: TELC_B1_WRITING_RUBRIC, policy: null, explanationLanguage: 'de' }, {}),
    (err) => err.code === 'grader_error' && !String(err.message).includes(fakeKey)
  );
});

await check('bound descriptor text reaches the prompt and duplicate or invalid criteria fail',()=>{
 const rubric=TELC_B1_WRITING_RUBRIC;
 const prompt=buildWritingPrompt({text:sampleText,rubric});
 for(const c of rubric.criteria)for(const descriptor of Object.values(c.descriptors))assert(prompt.system.includes(descriptor));
 const response={criteria:rubric.criteria.map(c=>({key:c.key,band:'B',evidence:'Monatskarte',comment:'Clear text.'})),corrections:[]};
 const parse=value=>parseDeepSeekAssessment(JSON.stringify(value),{text:sampleText,rubric});
 assert.equal(parse(response).feedback.criteria.length,3);
 for(const mutate of [v=>v.criteria.push(v.criteria[0]),v=>v.criteria[1]=v.criteria[0],v=>v.criteria[0].band='Z',v=>v.criteria[0].evidence='invented quote',v=>v.total=45,v=>v.corrections=Array(9).fill('extra')]){const v=structuredClone(response);mutate(v);assert.throws(()=>parse(v),/grader_error/);}
});
await check('live identity and usage yield an estimated cost with no synthetic labels',()=>{
 const i=validateProviderIdentity(DEEPSEEK_PROVIDER_SELECTOR);
 assert.equal(i.providerId,'deepseek');assert.equal(i.transportMode,'https');
 const receipt=normalizeUsageReceipt({usageBasis:'reported',modelReported:'deepseek-flash',inputTokens:1000,cachedInputTokens:200,outputTokens:500,reasoningOutputTokens:null},i);
 const cost=estimateAttemptCost(i,{transportStatus:'response',receiptCaptured:true,receipt});
 assert.equal(cost.estimatedAmount,'0.0008412');assert.equal(cost.currency,'USD');
});
await check('insufficient remaining budget and oversized prompts dispatch nothing',async()=>{
 let calls=0;const fetchImpl=async()=>{calls++;throw Error('unexpected');};
 const input={text:sampleText,rubric:TELC_B1_WRITING_RUBRIC};
 await assert.rejects(createDeepSeekGrader({apiKey:fakeKey,fetchImpl,estimateSpendUsdToday:async()=>14.99})(input),/grader_budget_exceeded/);
 await assert.rejects(createDeepSeekGrader({apiKey:fakeKey,fetchImpl,estimateSpendUsdToday:async()=>0})({...input,text:'x'.repeat(65000)}),/grader_input_too_large/);
 assert.equal(calls,0);
});
console.log(`DeepSeek writing grader check: ${passed} passed, 0 failed.`);
