import assert from 'node:assert/strict';
import { setLocale } from '../public/assets/i18n/core.js';
// These retained copy assertions deliberately exercise the German interface.
setLocale('de');
import { createMockSession, finaliseMockWriting, mockWritingStatus } from '../public/app/mock.js';
import { writingCriterion, writingFeedbackState, writingLabels, writingPrompt } from '../public/app/writing.js';
import { createApi } from '../public/app/api.js';

const copy = value => structuredClone(value);
const choice = { id: 'SA1', options: [{ id: 'A', task: { task_id: 'dtz.a', version: 'v1' } }, { id: 'B', task: { task_id: 'dtz.b', version: 'v1' } }] };
const member = { set_id: 'reading', version: 'v1' };
const base = { id: 'run', revision: 1, state: 'active', responses: [], position: { member: 0, item: 0 }, members: [], writing_choices: [choice], writing: null, result: null };
const attachment = { choice_group_id: 'SA1', selected_option_id: 'A', attempt_id: 'attempt-a', draft_revision: 1, submission_id: null, assessment_state: 'not_started' };
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };
function fixture(extra = {}) {
  let saved = copy(base), serial = 0, intercept = null;
  const calls = [], receipts = new Map();
  const operation = async (kind, id, body) => {
    calls.push({ kind, id, body: copy(body) });
    if (intercept) { const response = await intercept(kind, id, body); if (response) return response; }
    if (receipts.has(body.eventId)) return copy(receipts.get(body.eventId));
    if (body.expectedRevision !== saved.revision) return { ok: false, status: 409, error: 'run_conflict' };
    if (kind === 'save') saved = { ...saved, revision: saved.revision + 1, responses: copy(body.responses), position: copy(body.position) };
    if (kind === 'chooseWriting') saved = { ...saved, revision: saved.revision + 1, writing: { ...attachment, selected_option_id: body.optionId, attempt_id: 'attempt-' + body.optionId.toLowerCase() } };
    if (kind === 'finalise') saved = { ...saved, revision: saved.revision + 1, state: 'finalised', writing: saved.writing && { ...saved.writing, submission_id: 'submission', assessment_state: 'pending' } };
    const response = { ok: true, status: 200, data: copy(saved) }; receipts.set(body.eventId, response); return response;
  };
  const session = createMockSession({ api: { mock: { chooseWriting: (...args) => operation('chooseWriting', ...args), save: (...args) => operation('save', ...args), finalise: (...args) => operation('finalise', ...args), read: async () => ({ ok: true, data: copy(saved) }) } }, eventId: () => 'event-' + ++serial, ...extra });
  session.load(base);
  return { session, calls, get saved() { return saved; }, set saved(value) { saved = copy(value); session.load(saved); }, intercept(fn) { intercept = fn; } };
}

await check('choice binds exact group and option after saving objective responses', async () => {
  const f = fixture(); f.session.answer(member, '1', 'b');
  assert.equal(await f.session.chooseWriting('SA1', 'B'), true);
  assert.deepEqual(f.calls.map(c => c.kind), ['save', 'chooseWriting']);
  assert.deepEqual(f.calls[1].body, { expectedRevision: 2, eventId: 'event-2', choiceGroupId: 'SA1', optionId: 'B' });
  assert.equal(f.session.state().run.writing.attempt_id, 'attempt-b');
  assert.equal(await f.session.chooseWriting('SA1', 'A'), false);
  assert.equal(f.calls.length, 2);
});
await check('unoffered choices and inactive, blocked or archived runs cannot start writing', async () => {
  const f = fixture(); assert.equal(await f.session.chooseWriting('other', 'A'), false); assert.equal(await f.session.chooseWriting('SA1', 'C'), false);
  f.saved = { ...base, blocked_reason: 'rights' }; assert.equal(await f.session.chooseWriting('SA1', 'A'), false);
  f.saved = { ...base, state: 'finalised' }; assert.equal(await f.session.chooseWriting('SA1', 'A'), false);
  assert.equal(f.calls.length, 0);
  const archived = fixture({ canEdit: () => false }); assert.equal(await archived.session.chooseWriting('SA1', 'A'), false);
});
await check('uncertain selection retries the identical choice and cannot silently switch to B', async () => {
  const f = fixture(); let fail = true;
  f.intercept(async () => fail ? { ok: false, status: 0, error: 'network' } : null);
  assert.equal(await f.session.chooseWriting('SA1', 'A'), false);
  assert.equal(await f.session.chooseWriting('SA1', 'B'), false);
  assert.equal(f.session.state().writable, false);
  fail = false; assert.equal(await f.session.flush(), true);
  assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.session.state().run.writing.selected_option_id, 'A');
});
await check('a mismatched choice acknowledgement is refused and retains the pending operation', async () => {
  const f = fixture(); f.intercept(async () => ({ ok: true, data: { ...base, revision: 2, writing: { ...attachment, selected_option_id: 'B' } } }));
  assert.equal(await f.session.chooseWriting('SA1', 'A'), false); assert.equal(f.session.state().run.writing, null); assert.equal(f.session.state().pending, true);
});
await check('late choice response cannot attach text to another loaded run', async () => {
  const f = fixture(); let release;
  f.intercept(() => new Promise(resolve => { release = () => resolve({ ok: true, data: { ...base, revision: 2, writing: attachment } }); }));
  const selecting = f.session.chooseWriting('SA1', 'A'); await new Promise(resolve => setImmediate(resolve));
  f.session.load({ ...base, id: 'other' }); release(); assert.equal(await selecting, false); assert.equal(f.session.state().run.id, 'other'); assert.equal(f.session.state().run.writing, null);
});
await check('parallel choices issue one durable selection', async () => {
  const f = fixture(); const first = f.session.chooseWriting('SA1', 'A'); assert.equal(await f.session.chooseWriting('SA1', 'B'), false); assert.equal(await first, true); assert.equal(f.calls.length, 1);
});
await check('finalise waits for the draft acknowledgement and sends its exact revision and language', async () => {
  const f = fixture(); f.saved = { ...base, writing: attachment }; f.session.answer(member, '1', 'a');
  let release; const writing = { active: { attempt: 'attempt-a', revision: 1 }, flush: () => new Promise(resolve => { release = () => { writing.active.revision = 9; resolve(true); }; }) };
  const pending = finaliseMockWriting({ session: f.session, writing, language: 'ar' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0); release(); assert.equal(await pending, true);
  assert.deepEqual(f.calls.map(c => c.kind), ['save', 'finalise']);
  assert.deepEqual(f.calls[1].body, { expectedRevision: 2, eventId: 'event-2', expectedWritingRevision: 9, explanationLanguage: 'ar' });
});
await check('draft failure or the wrong editor prevents finalisation and preserves objective work', async () => {
  const f = fixture(); f.saved = { ...base, writing: attachment }; f.session.answer(member, '1', 'b');
  assert.equal(await finaliseMockWriting({ session: f.session, writing: { flush: async () => false } }), false);
  assert.equal(f.calls.length, 0); assert.equal(f.session.state().responses[0].answer, 'b');
  assert.equal(await finaliseMockWriting({ session: f.session, writing: { flush: async () => true, active: { attempt: 'other-attempt', revision: 3 } } }), false);
  assert.equal(f.calls.some(c => c.kind === 'finalise'), false);
});
await check('a late draft save cannot finalise a different run', async () => {
  const f = fixture(); f.saved = { ...base, writing: attachment };
  let release;
  const writing = { active: { attempt: 'attempt-a', revision: 2 }, flush: () => new Promise(resolve => { release = () => resolve(true); }) };
  const pending = finaliseMockWriting({ session: f.session, writing }); await new Promise(resolve => setImmediate(resolve));
  f.session.load({ ...base, id: 'new-run' }); release(); assert.equal(await pending, false); assert.equal(f.calls.length, 0);
});
await check('lost finalise response reuses the frozen draft revision and event even after settings change', async () => {
  const f = fixture(); f.saved = { ...base, writing: attachment }; let fail = true;
  f.intercept(async kind => kind === 'finalise' && fail ? { ok: false, status: 0, error: 'network' } : null);
  const writing = { flush: async () => true, active: { attempt: 'attempt-a', revision: 7 } };
  assert.equal(await finaliseMockWriting({ session: f.session, writing, language: 'uk' }), false);
  fail = false; assert.equal(await f.session.flush(), true); assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.calls[1].body.explanationLanguage, 'uk');
});
await check('unselected writing has no fabricated draft revision and objective-only forms keep their body', async () => {
  const writing = { flush: async () => true, active: null };
  const f = fixture(); assert.equal(await finaliseMockWriting({ session: f.session, writing, language: 'tr' }), true);
  assert.deepEqual(f.calls[0].body, { expectedRevision: 1, eventId: 'event-1', explanationLanguage: 'tr' });
  const objective = fixture(); objective.saved = { ...base, writing_choices: [] }; await finaliseMockWriting({ session: objective.session, writing });
  assert.deepEqual(objective.calls[0].body, { expectedRevision: 1, eventId: 'event-1' });
});
await check('bound criterion labels preserve unequal DTZ scales without telc conversion', async () => {
  const rubric = { criteria: [{ key: 'dtz_aufgabe', label: 'Aufgabenbewältigung', bandLabels: { B1_PLUS: '5', B1: '4', ZERO: '0' } }, { key: 'dtz_korrektheit', label: 'Korrektheit', bandLabels: { B1_PLUS: 'B1 gut erfüllt', B1: 'B1 erfüllt', ZERO: '0' } }] };
  assert.deepEqual(writingCriterion({ key: 'dtz_aufgabe', label: 'wrong', band: 'B1_PLUS' }, rubric), { label: 'Aufgabenbewältigung', band: '5' });
  assert.deepEqual(writingCriterion({ key: 'dtz_korrektheit', band: 'B1_PLUS' }, rubric), { label: 'Korrektheit', band: 'B1 gut erfüllt' });
  assert.deepEqual(writingCriterion({ key: 'aufgabe', band: 'A' }, { criteria: [{ key: 'aufgabe', label: 'Aufgabenbewältigung' }] }), { label: 'Aufgabenbewältigung', band: 'A' });
});
await check('blocked or unassessed results never masquerade as pending or assessed feedback', async () => {
  assert.equal(writingFeedbackState({ blocked_reason: 'rights', job: { status: 'succeeded' }, assessment: { feedback: {} } }), 'blocked');
  assert.equal(writingFeedbackState({ job: { status: 'unassessed', failure_code: 'allowance_exhausted' } }), 'unassessed');
  assert.equal(writingFeedbackState({ job: { status: 'failed' } }), 'failed');
  assert.equal(writingFeedbackState({ job: { status: 'running' } }), 'pending');
  assert.equal(writingFeedbackState({ job: { status: 'succeeded' }, assessment: {} }), 'assessed');
  assert.match(mockWritingStatus({ assessment_state: 'unassessed' }), /Unbewertet/);
});
await check('telc wording follows its bound rubric while DTZ and other rubrics stay distinct', async () => {
  const telc = { rubric_id: 'writing.telc-b1', exam_id: 'telc-deutsch-b1' };
  const dtz = { rubric_id: 'writing.dtz', exam_id: 'dtz-a2-b1', feedback_kind: 'dtz-writing-bands' };
  const exact = 'Übungsfeedback nach den telc-Kriterien – keine offizielle Bewertung';
  assert.equal(writingLabels(telc, 'telc-b1-bands').heading, exact);
  assert.equal(writingLabels({ ...telc, feedback_kind: 'telc-b1-bands' }, 'telc-b1-bands').heading, exact);
  assert.equal(writingLabels(null, 'telc-b1-bands').heading, exact);
  assert.equal(writingLabels(telc).notice, 'Vorläufige Rubrik: eigene Beschreibungen, nicht die offizielle Formulierung von telc.');
  for (const [rubric, kind] of [[dtz, 'dtz-writing-bands'], [dtz, 'telc-b1-bands'], [telc, 'dtz-writing-bands'], [{ rubric_id: 'writing.formative', exam_id: 'telc-deutsch-b1' }, 'formative'], [null, null]]) {
    const label = writingLabels(rubric, kind);
    assert.equal(label.heading, 'Übungsfeedback – keine offizielle Bewertung');
    assert.doesNotMatch(label.notice, /telc/);
    assert.match(label.notice, /nicht die offizielle Formulierung/);
  }
});
await check('prompt renders the supplied address and all points without an invented minimum', async () => {
  const html = writingPrompt({ topic: 'An eine Freundin', situation: 'Schreibe einen Brief.', adressat: 'Liebe Freundin', leitpunkte: ['Grund', 'Frage'] }, value => String(value));
  assert.match(html, /Liebe Freundin/); assert.match(html, /Grund/); assert.match(html, /Frage/); assert.doesNotMatch(html, /150|Sehr geehrte|Mindest/);
});
await check('choice API carries only the owned run identity and fences superseded preparation replies', async () => {
  let release; const calls = [];
  const api = createApi({ onSessionInvalid: () => {}, fetchImpl: async (url, init) => {
    calls.push({ url, ...init });
    if (url.includes('get-session')) return { ok: true, status: 200, json: async () => ({ user: { id: 'owner' } }) };
    return new Promise(resolve => { release = () => resolve({ ok: true, status: 200, json: async () => base }); });
  } });
  await api.session(); api.preparations.select({ id: '11111111-1111-4111-8111-111111111111', state: 'active' });
  const body = { expectedRevision: 1, eventId: 'choice-event', choiceGroupId: 'SA1', optionId: 'A' };
  const pending = api.mock.chooseWriting('owned/run', body); assert.equal(calls.at(-1).url, '/api/v1/mock-runs/owned%2Frun/writing-choice'); assert.deepEqual(JSON.parse(calls.at(-1).body), body);
  api.preparations.clear(); release(); assert.equal((await pending).error, 'stale_preparation');
});
console.log(`${passed} passed; synthetic transport and pure client checks only.`);
