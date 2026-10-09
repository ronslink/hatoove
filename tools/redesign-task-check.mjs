import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ownRoot = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(process.argv.find(arg => arg.startsWith('--source-root='))?.slice(14) || ownRoot);
const { runnerMarkup, runnerStateFromServed, createPartRunnerView, applyChecked } = await import(pathToFileURL(path.join(root, 'public/app/part-runner.js')));
const count = (text, regex) => [...text.matchAll(regex)].length;
const options = Array.from({ length: 10 }, (_, index) => ({ id: String.fromCharCode(97 + index), text: 'Authored option ' + index, value: String.fromCharCode(97 + index) }));
const setFor = family => ({ set_id: 'synthetic-' + family, version: 'v1', family, section: family.slice(0, 2), part: 1, title: 'Synthetic task', material: { letter: 'Guten Tag,\nBitte {21} und {22}.\nVielen Dank!' }, items: Array.from({ length: family.startsWith('SB') ? 2 : 5 }, (_, i) => ({ item_id: String(family.startsWith('SB') ? 21 + i : i + 1), ordinal: i + 1, prompt: family.startsWith('SB') ? '' : 'Authored text ' + (i + 1), answer_kind: 'choice', options: family === 'SB1' ? options.slice(0, 3) : options })) });
const responseFor = family => ({ ok: true, data: { family, attempt: { attempt_id: '11111111-2222-4333-8444-555555555555' }, set: setFor(family) } });
const stateFor = family => runnerStateFromServed({ family, response: responseFor(family), examLanguage: 'de' });
let failures = 0, passes = 0;
async function check(name, run) { try { await run(); console.log('PASS ' + name); passes++; } catch (error) { console.log('FAIL ' + name + ': ' + error.message.split('\n')[0]); failures++; } }

for (const family of ['LV1', 'LV3']) await check(family + ' shares one bank and one picker per text, all options still selectable', () => {
  const markup = runnerMarkup(stateFor(family), { locale: 'de', examLanguage: 'de' });
  assert.equal(count(markup, /data-layout-bank/g), 1);
  assert.equal(count(markup, /<select /g), 5);
  assert.equal(count(markup, /type="radio"/g), 0);
  assert.equal(count(markup, /<option value="j"/g), 5);
});
await check('SB1 choices open at authored numbered gaps and preserve the letter', () => {
  const markup = runnerMarkup(stateFor('SB1'), { locale: 'de', examLanguage: 'de' });
  assert.match(markup, /data-task-layout="inline-gaps"/);
  assert.equal(count(markup, /data-gap-open=/g), 2);
  assert.ok(!markup.includes('{21}') && !markup.includes('{22}'));
  assert.equal(count(markup, /Guten Tag,/g), 1);
});
await check('SB2 shares one word bank and renders its two gaps in place', () => {
  const markup = runnerMarkup(stateFor('SB2'), { locale: 'de', examLanguage: 'de' });
  assert.equal(count(markup, /data-layout-bank/g), 1);
  assert.equal(count(markup, /<select /g), 2);
  assert.ok(!markup.includes('{21}'));
});
await check('a used heading remains selectable and has a text marker', () => {
  const state = stateFor('LV1'); state.answers['1'] = { key: 'b', value: 'b' };
  const markup = runnerMarkup(state, { locale: 'de', examLanguage: 'de' });
  assert.match(markup, /data-bank-key="b" data-used="true"/);
  assert.equal(count(markup, /<option value="b"/g), 5);
  assert.ok(markup.includes('bereits gewählt'));
});
await check('mistake-only gaps keep the original letter with no raw markers', () => {
  const state = stateFor('SB2'); state.set.items = state.set.items.slice(0, 1);
  const markup = runnerMarkup(state, { locale: 'de', examLanguage: 'de' });
  assert.ok(!/\{\d+\}/.test(markup)); assert.ok(markup.includes('Guten Tag,'));
});
await check('review names the pick and correct answer without repeating the shared bank', () => {
  const state = stateFor('LV1');
  const reviewed = applyChecked(state, { correct_count: 0, answered_count: 5, items: state.set.items.map(item => ({ item_id: item.item_id, chosen: 'a', expected: 'b', correct: false })) });
  const markup = runnerMarkup(reviewed, { locale: 'de', examLanguage: 'de' });
  assert.equal(count(markup, /data-layout-bank/g), 1);
  assert.equal(count(markup, /data-option-marker="chosen"/g), 5);
  assert.equal(count(markup, /data-option-marker="key"/g), 5);
  assert.equal(count(markup, /data-option-id="/g), 10);
  assert.match(markup, /role="status" data-review-verdict="wrong"/);
});
await check('finalized mock preserves a false pick and true key, both locked and named', async () => {
  const {mockReviewAnswerTiles} = await import(pathToFileURL(path.join(root, 'public/app/mock.js')));
  const item = {options:[{id:'true',label:'richtig'},{id:'false',label:'falsch'}]};
  const markup = mockReviewAnswerTiles(item, {item_id:'41',answer:false,correct_answer:true,correct:false}, {locale:'uk',examLanguage:'de'});
  assert.match(markup, /data-tile-state="wrong" data-option-id="false"/);
  assert.match(markup, /data-tile-state="correct" data-option-id="true"/);
  assert.equal(count(markup, / disabled/g), 2);
  assert.match(markup, /value="false"[^>]* checked disabled/);
  assert.equal(count(markup, /data-option-marker="chosen"/g), 1);
  assert.equal(count(markup, /data-option-marker="key"/g), 1);
  assert.match(markup, /lang="de" dir="ltr">falsch/);
});
await check('network rejection retains every pick, permits retry and fences concurrent evaluation', async () => {
  let rejectRequest, calls = 0;
  const api = { practice: { next: async () => responseFor('LV1'), check: () => { calls++; return new Promise((resolve, reject) => { rejectRequest = reject; }); } } };
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const view = createPartRunnerView({ api, family: 'LV1', examLanguage: 'de' });
  await view.mount(host);
  for (const item of setFor('LV1').items) host.onchange({ target: { closest: selector => selector === '[data-answer-item]' ? { dataset: { answerItem: item.item_id }, value: 'b' } : null } });
  const checking = view.evaluate();
  assert.equal(await view.evaluate(), false);
  assert.equal(calls, 1);
  rejectRequest(Error('Synthetic offline'));
  assert.equal(await checking, false);
  assert.equal(Object.keys(view.snapshot().answers).length, 5);
  assert.equal(view.snapshot().phase, 'answering');
  assert.match(view.markup(), /data-runner-evaluate-ready="true"/);
  const originalConfirm = globalThis.confirm;
  globalThis.confirm = () => false; assert.equal(view.canLeave(), false);
  host.onchange({ target: { closest: selector => selector === '[data-answer-item]' ? { dataset: { answerItem: '1' }, tagName: 'SELECT', value: '' } : null } });
  assert.equal(view.snapshot().answers['1'], undefined);
  assert.match(view.markup(), /data-runner-evaluate-ready="false"/);
  globalThis.confirm = () => true; assert.equal(view.canLeave(), true);
  globalThis.confirm = originalConfirm;
  view.unmount();
});
console.log(`${passes} passed, ${failures} failed`);
process.exitCode = failures ? 1 : 0;
