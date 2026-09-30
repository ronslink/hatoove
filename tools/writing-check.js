/** Focused writing regression checks. Run with: node tools/writing-check.js
 * All browser storage and HTTP calls stay in memory; no paid AI calls or learner
 * progress are touched.
 */
import assert from 'node:assert/strict';
import * as store from '../public/js/store.js';
import * as ai from '../public/js/ai.js';

const local = new Map();
globalThis.localStorage = {
  getItem: (key) => local.get(key) ?? null,
  setItem: (key, value) => local.set(key, String(value)),
  removeItem: (key) => local.delete(key),
};

let configured = false;
let respondAI;
const requests = [];
const response = (data, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => data });
globalThis.fetch = async (url, options = {}) => {
  if (url === '/api/config') return response({ configured });
  if (url === '/api/progress') return response({ ok: true });
  assert.equal(url, '/api/ai', `unexpected request: ${url}`);
  assert.equal(typeof respondAI, 'function', 'no AI response was configured for this test');
  const request = JSON.parse(options.body);
  requests.push(request);
  return respondAI(request);
};

function validTask(register) {
  return {
    situation: 'Sie möchten am Samstag gemeinsam kochen und schreiben eine E-Mail.',
    adressat: register === 'du' ? 'Ihr Freund Alex (du)' : 'Ihre Kursleiterin Frau Berger (Sie)',
    register,
    leitpunkte: ['Nennen Sie den Anlass.', 'Schlagen Sie eine Uhrzeit vor.', 'Beschreiben Sie das Essen.', 'Bitten Sie um eine Antwort.'],
    tipps: ['Behandeln Sie alle vier Leitpunkte.'],
  };
}

const answerWith = (raw) => { respondAI = () => response({ ok: true, content: JSON.stringify(raw) }); };
async function reset(useAI = false) {
  configured = useAI;
  requests.length = 0;
  respondAI = undefined;
  store.resetAll();
  await ai.refreshStatus();
}

function fourPoints(task) {
  assert.equal(task.leitpunkte.length, 4, 'every writing task needs four guiding points');
  assert.ok(task.leitpunkte.every((point) => typeof point === 'string' && point.trim()), 'guiding points must be nonblank strings');
}

const checks = [];
const check = (name, run) => checks.push({ name, run });

check('offline rotation alternates du/Sie and visits six different topics before repeating', async () => {
  await reset();
  const tasks = [];
  for (let i = 0; i < 6; i++) tasks.push(await ai.nextWritingTask());
  assert.deepEqual(tasks.map((task) => task.register), ['du', 'Sie', 'du', 'Sie', 'du', 'Sie']);
  assert.equal(new Set(tasks.map((task) => task.topic)).size, 6);
  for (const task of tasks) {
    fourPoints(task);
    assert.equal(task.source, 'offline');
  }
  assert.equal(store.getState().settings.writingTaskIndex, 6);
  const repeated = await ai.nextWritingTask();
  assert.equal(repeated.register, 'du');
  assert.equal(repeated.topic, tasks[0].topic);
  assert.equal(requests.length, 0, 'offline practice should make no AI calls');
});

check('rotation continues after export/import and keeps other learner settings', async () => {
  await reset();
  store.getState().settings.dailyGoal = 35;
  await ai.nextWritingTask();
  const saved = store.exportJSON();
  store.resetAll();
  store.importJSON(saved);
  assert.equal(store.getState().settings.writingTaskIndex, 1);
  assert.equal(store.getState().settings.dailyGoal, 35);
  const task = await ai.nextWritingTask();
  assert.equal(task.register, 'Sie');
  assert.equal(store.getState().settings.writingTaskIndex, 2);
});

check('legacy saves without a rotation counter start with an informal email', async () => {
  await reset();
  const legacy = JSON.parse(store.exportJSON());
  delete legacy.settings.writingTaskIndex;
  store.importJSON(JSON.stringify(legacy));
  assert.equal((await ai.nextWritingTask()).register, 'du');
  assert.equal(store.getState().settings.writingTaskIndex, 1);
});

check('AI prompts explicitly request the selected register and four points', async () => {
  await reset(true);
  for (const register of ['du', 'Sie']) {
    answerWith(validTask(register));
    const task = await ai.genWritingTask({ register, difficulty: 61 });
    const prompt = requests.at(-1).messages.find((message) => message.role === 'user').content;
    assert.match(prompt, new RegExp(`"register"\\s*:\\s*"${register}"`));
    assert.match(prompt, /(?:vier|4)\s+Leitpunkte/i);
    assert.equal(task.register, register);
    assert.equal(task.difficulty, 61);
    assert.equal(task.source, 'ai');
    fourPoints(task);
  }
});

check('AI task validation rejects wrong/missing registers and incomplete point lists', async () => {
  await reset(true);
  const missingRegister = validTask('du');
  delete missingRegister.register;
  const invalidTasks = [
    validTask('Sie'),
    missingRegister,
    { ...validTask('du'), leitpunkte: ['A', 'B', 'C'] },
    { ...validTask('du'), leitpunkte: ['A', 'B', 'C', 'D', 'E'] },
    { ...validTask('du'), leitpunkte: ['A', 'B', 'C', '   '] },
  ];
  for (const raw of invalidTasks) {
    answerWith(raw);
    await assert.rejects(() => ai.genWritingTask({ register: 'du' }));
  }
});

check('a mismatched AI task falls back in the reserved slot without advancing twice', async () => {
  await reset(true);
  respondAI = () => {
    const saved = JSON.parse(local.get('b1prep.state.v1'));
    assert.equal(saved.settings.writingTaskIndex, 1, 'save the reserved slot before requesting AI');
    return response({ ok: true, content: JSON.stringify(validTask('Sie')) });
  };
  const fallback = await ai.nextWritingTask({ difficulty: 61 });
  assert.equal(fallback.register, 'du');
  assert.equal(fallback.source, 'offline');
  assert.equal(fallback.difficulty, 61);
  assert.ok(fallback.fallbackReason);
  fourPoints(fallback);
  assert.equal(store.getState().settings.writingTaskIndex, 1);

  answerWith(validTask('Sie'));
  const next = await ai.nextWritingTask();
  assert.equal(next.register, 'Sie');
  assert.equal(next.source, 'ai');
  assert.equal(store.getState().settings.writingTaskIndex, 2);
  assert.equal(requests.length, 2);
});

check('an AI network failure also keeps the selected register in fallback', async () => {
  await reset(true);
  store.getState().settings.writingTaskIndex = 1;
  respondAI = () => response({ ok: false, error: 'Test: AI unavailable' }, false);
  const task = await ai.nextWritingTask();
  assert.equal(task.register, 'Sie');
  assert.equal(task.source, 'offline');
  assert.match(task.fallbackReason, /unavailable/);
  assert.equal(store.getState().settings.writingTaskIndex, 2);
  fourPoints(task);
});

check('grading includes the fourth guiding point and preserves its coverage', async () => {
  await reset(true);
  const task = ai.offlineWritingTask({ register: 'du' });
  answerWith({ criteria: [], total: 30, leitpunkteCovered: [true, true, false, true] });
  const result = await ai.gradeWriting({ task, text: 'Liebe Anna, vielen Dank für deine Nachricht.', analysis: {} });
  const prompt = requests.at(-1).messages.find((message) => message.role === 'user').content;
  assert.ok(prompt.includes(`4. ${task.leitpunkte[3]}`), 'grading must receive the fourth point');
  const sample = prompt.match(/"leitpunkteCovered"\s*:\s*(\[[^\]]*\])/);
  assert.ok(sample, 'grading prompt needs a coverage example');
  assert.equal(JSON.parse(sample[1]).length, 4, 'coverage example must ask for four results');
  assert.deepEqual(result.leitpunkteCovered, [true, true, false, true]);
});

check('grading fills missing coverage and drops results beyond the task points', async () => {
  await reset(true);
  const task = ai.offlineWritingTask({ register: 'du' });
  answerWith({ criteria: [], total: 20, leitpunkteCovered: [true, false, true] });
  const missing = await ai.gradeWriting({ task, text: 'Liebe Anna,', analysis: {} });
  assert.deepEqual(missing.leitpunkteCovered, [true, false, true, false]);

  answerWith({ criteria: [], total: 20, leitpunkteCovered: [true, false, true, false, true] });
  const extra = await ai.gradeWriting({ task, text: 'Liebe Anna,', analysis: {} });
  assert.deepEqual(extra.leitpunkteCovered, [true, false, true, false]);
});

let failed = 0;
for (const { name, run } of checks) {
  try {
    await run();
    console.log(`PASS ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`FAIL ${name}\n${error.stack}`);
  }
}
// Clear the deferred save and consume it through the in-memory endpoint stub.
store.saveNow();
await store.flushNow();
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
