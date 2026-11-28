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
} from '../server/writing-grader-deepseek.mjs';
import { validateAssessment } from '../server/owned-postgres/worker.mjs';
import { TELC_B1_WRITING_RUBRIC } from '../server/owned-postgres/content-seed.mjs';
import { DTZ_POLICY } from '../server/writing-policy.mjs';

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

await check('default config stays stub and live mode fails closed without key or valid limit', async () => {
  assert.deepEqual(readDeepSeekConfig({}), { mode: 'stub' });
  assert.deepEqual(readDeepSeekConfig({ HATOVE_GRADER_MODE: 'stub' }), { mode: 'stub' });
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
  const grade = createDeepSeekGrader({ apiKey: fakeKey, dailyUsdLimit: 15, fetchImpl, estimateSpendUsdToday: async () => 14.99 });
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

await check('DTZ response validates cleanly and falls back to exact sentence quote if evidence is paraphrased', async () => {
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
  const assessment = await grade({ text: sampleText, rubric: dtzRubric, policy: DTZ_POLICY, explanationLanguage: 'en' }, {});
  validateAssessment(assessment, { rubric: dtzRubric, text: sampleText });
  assert(sampleText.includes(assessment.feedback.criteria[0].evidence));
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

console.log(`DeepSeek writing grader check: ${passed} passed, 0 failed.`);
