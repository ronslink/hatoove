/** Feedback regression checks, entirely in memory (no API charges or saved progress).
 * Run: node tools/feedback-check.js [path/to/public/js/ai.js]
 * The optional module path also checks a staged desktop-app copy.
 */
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const moduleURL = process.argv[2]
  ? pathToFileURL(resolve(process.argv[2]))
  : new URL('../public/js/ai.js', import.meta.url);
const local = new Map();
globalThis.localStorage = {
  getItem: (key) => local.get(key) ?? null,
  setItem: (key, value) => local.set(key, String(value)),
  removeItem: (key) => local.delete(key),
};

const requests = [];
let queued = [];
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const success = (content, extra = {}) => response({ ok: true, content, ...extra });
const objectResponse = (value, extra) => success(JSON.stringify(value), extra);
globalThis.fetch = async (url, options = {}) => {
  if (url === '/api/config') return response({ configured: true });
  if (url === '/api/progress') return response({ ok: true });
  assert.equal(url, '/api/ai', `unexpected request: ${url}`);
  requests.push(JSON.parse(options.body));
  assert.ok(queued.length, 'unexpected extra AI request');
  const next = queued.shift();
  if (next instanceof Error) throw next;
  return next;
};

const store = await import(new URL('./store.js', moduleURL));
const ai = await import(moduleURL);
const call = (options = {}) => ai.callAI({
  system: 'Original system instruction.',
  user: 'Original learner response with umlauts: Grüße.',
  temperature: 0.4,
  maxTokens: 4096,
  timeoutMs: 120000,
  ...options,
});
function supply(...responses) {
  requests.length = 0;
  queued = responses;
}

function speakingFeedback() {
  return {
    criteria: ['struktur', 'wortschatz', 'fluessigkeit', 'interaktion'].map((key, index) => ({
      key, score: 70 + index, comment: 'Klares Feedback.',
    })).concat({ key: 'aussprache', score: null, comment: 'Aus Transkript nicht beurteilbar.' }),
    points: 18,
    band: 'gut',
    corrections: [{ original: 'Ich gehen', corrected: 'Ich gehe', explanation: 'Die Verbform passt zum Subjekt.' }],
    betterPhrases: [{ said: 'Ich denke so.', better: 'Ich bin der Meinung, dass …' }],
    strengths: ['Gute Gliederung.'],
    priorities: ['Verbformen üben.'],
  };
}
const grade = () => ai.gradeSpeaking({
  task: { situation: 'Planen Sie einen Ausflug.', keywords: ['Termin', 'Ziel'] },
  transcript: 'Ich schlage vor, dass wir am Samstag einen Ausflug machen.',
  partId: 'SP3',
  durationSec: 45,
});

const checks = [];
const check = (name, run) => checks.push({ name, run });

check('valid plain and fenced JSON objects need only one request', async () => {
  for (const content of ['{"message":"Grüße"}', '```json\n{"message":"Grüße"}\n```']) {
    supply(success(content));
    assert.deepEqual(await call(), { message: 'Grüße' });
    assert.equal(requests.length, 1);
  }
});

check('malformed JSON retries once with the same work and a stricter, larger request', async () => {
  supply(success('{"score":0-100}'), objectResponse({ score: 72 }));
  assert.deepEqual(await call(), { score: 72 });
  assert.equal(requests.length, 2);
  const [first, retry] = requests;
  assert.equal(retry.messages.length, 2);
  assert.deepEqual(retry.messages[1], first.messages[1], 'retry must retain the original learner submission');
  assert.ok(retry.messages[0].content.startsWith(first.messages[0].content));
  assert.ok(retry.messages[0].content.length > first.messages[0].content.length);
  assert.match(retry.messages[0].content, /JSON/i);
  assert.ok(retry.temperature < first.temperature);
  assert.ok(retry.maxTokens > first.maxTokens);
  assert.ok(retry.maxTokens <= 8192);
  assert.equal(retry.timeoutMs, first.timeoutMs);
  assert.equal(retry.json, true);
});

check('array, null and primitive JSON cannot be mistaken for a feedback object', async () => {
  for (const content of ['[]', '[{"score":72}]', 'null', 'false', '42', '"feedback"']) {
    supply(success(content), objectResponse({ recovered: true }));
    assert.deepEqual(await call(), { recovered: true });
    assert.equal(requests.length, 2, `expected a retry for ${content}`);
  }
});

check('length-limited responses retry even when their partial content parses', async () => {
  for (const content of ['{"partial":true}', '{"partial":']) {
    supply(success(content, { finishReason: 'length' }), objectResponse({ complete: true }));
    assert.deepEqual(await call(), { complete: true });
    assert.equal(requests.length, 2);
  }
});

check('empty content and malformed upstream envelopes retry once', async () => {
  const firstResponses = [
    success(''),
    response({ ok: false, code: 'EMPTY', error: 'No upstream content.' }, 502),
    response({ ok: false, code: 'BAD_ENVELOPE', error: 'Invalid upstream envelope.' }, 502),
  ];
  for (const first of firstResponses) {
    supply(first, objectResponse({ recovered: true }));
    assert.deepEqual(await call(), { recovered: true });
    assert.equal(requests.length, 2);
  }
});

check('two invalid answers fail without a third request or fabricated result', async () => {
  supply(success('{broken'), success('{broken again'));
  await assert.rejects(() => call());
  assert.equal(requests.length, 2);
});

check('schema rejection retries but does not return an empty object as feedback', async () => {
  supply(objectResponse({}), objectResponse({ accepted: true }));
  assert.deepEqual(await call({ validate: (raw) => raw.accepted === true }), { accepted: true });
  assert.equal(requests.length, 2);
  supply(objectResponse({}), objectResponse({}));
  await assert.rejects(() => call({ validate: (raw) => raw.accepted === true }));
  assert.equal(requests.length, 2);
});

check('retry token budget never exceeds the API cap', async () => {
  supply(success('{broken'), objectResponse({ recovered: true }));
  await call({ maxTokens: 8000 });
  assert.ok(requests[1].maxTokens > 8000);
  assert.ok(requests[1].maxTokens <= 8192);
});

check('key, credit, rate-limit and timeout errors are preserved without a retry', async () => {
  for (const code of ['BAD_KEY', 'NO_CREDIT', 'RATE_LIMIT', 'TIMEOUT']) {
    supply(response({ ok: false, code, error: `Stub ${code}` }, 503));
    await assert.rejects(() => call(), (error) => error.code === code && error.message === `Stub ${code}`);
    assert.equal(requests.length, 1);
  }
});

check('network and aborted fetches do not consume a second request', async () => {
  for (const error of [new TypeError('Failed to fetch'), Object.assign(new Error('Aborted'), { name: 'AbortError' })]) {
    supply(error);
    await assert.rejects(() => call());
    assert.equal(requests.length, 1);
  }
});

check('speaking grading requests valid JSON examples and enough space for feedback', async () => {
  supply(objectResponse(speakingFeedback()));
  const result = await grade();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].maxTokens, 4096);
  const prompt = requests[0].messages.find((message) => message.role === 'user').content;
  const exampleStart = prompt.lastIndexOf('\n{');
  assert.ok(exampleStart >= 0, 'speaking prompt must include a JSON example');
  const example = JSON.parse(prompt.slice(exampleStart));
  assert.equal(typeof example.points, 'number');
  assert.ok(example.criteria.filter((criterion) => criterion.key !== 'aussprache').every((criterion) => typeof criterion.score === 'number'));
  assert.equal(result.points, 18);
  assert.deepEqual(result.criteria.filter((criterion) => criterion.key !== 'aussprache').map((criterion) => criterion.score), [70, 71, 72, 73]);
});

check('speaking empty objects recover on retry and never fabricate a zero score', async () => {
  supply(objectResponse({}), objectResponse(speakingFeedback()));
  assert.equal((await grade()).points, 18);
  assert.equal(requests.length, 2);
  supply(objectResponse({}), objectResponse({}));
  await assert.rejects(() => grade());
  assert.equal(requests.length, 2);
});

check('speaking rejects missing criteria, invalid scores, missing bands and wrong array types', async () => {
  const mutations = [
    (raw) => { raw.criteria.pop(); raw.criteria.pop(); },
    (raw) => { raw.criteria[1] = { ...raw.criteria[0] }; },
    (raw) => { raw.criteria[0].score = '75'; },
    (raw) => { raw.criteria[0].score = null; },
    (raw) => { raw.criteria[0].score = -1; },
    (raw) => { raw.criteria[0].score = 101; },
    (raw) => { raw.points = '18'; },
    (raw) => { raw.points = null; },
    (raw) => { delete raw.points; },
    (raw) => { raw.points = 26; },
    (raw) => { raw.points = -1; },
    (raw) => { raw.band = '  '; },
    ...['corrections', 'betterPhrases', 'strengths', 'priorities'].map((field) => (raw) => { raw[field] = 'not an array'; }),
  ];
  for (const mutate of mutations) {
    const invalid = speakingFeedback();
    mutate(invalid);
    supply(objectResponse(invalid), objectResponse(invalid));
    await assert.rejects(() => grade(), undefined, `invalid feedback was accepted: ${JSON.stringify(invalid)}`);
    assert.equal(requests.length, 2);
  }
});

check('legitimate zero/full scores survive validation and pronunciation remains unscored', async () => {
  for (const [points, score] of [[0, 0], [25, 100]]) {
    const raw = speakingFeedback();
    raw.points = points;
    for (const criterion of raw.criteria) criterion.score = score;
    supply(objectResponse(raw));
    const result = await grade();
    assert.equal(result.points, points);
    assert.ok(result.criteria.filter((criterion) => criterion.key !== 'aussprache').every((criterion) => criterion.score === score));
    assert.equal(result.criteria.find((criterion) => criterion.key === 'aussprache')?.score, null);
    assert.equal(requests.length, 1);
  }
});

let failed = 0;
for (const { name, run } of checks) {
  try {
    store.resetAll();
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
// Consume deferred saves through the stub, leaving no timer or real progress I/O.
store.saveNow();
await store.flushNow();
console.log(`\n${checks.length - failed} passed, ${failed} failed (${moduleURL.pathname})`);
process.exitCode = failed ? 1 : 0;
