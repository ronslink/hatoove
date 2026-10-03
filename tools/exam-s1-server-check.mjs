/**
 * EXAM-S1 — offline route-contract check for preparations, exam context and credits.
 *
 * Drives `server/owned-api.mjs` through `handle()` with a small IN-MEMORY datastore that implements the
 * preparation capability and records every WRITE, so a refused request can be proven to have written
 * nothing. Two owners, two synthetic exams (`telc-deutsch-b1` and a synthetic `synthetic-en-b2`, enabled
 * only through the test's own server-side catalogue).
 *
 * What this proves: the HTTP contract — required/invalid/foreign/mismatched context, idempotent creation,
 * revision conflicts with the current DTO, date validation, credits shape, no grant through preparations,
 * settings no longer writing `examDate`. What it does NOT prove: SQL, RLS, migration or locking — see
 * `tools/exam-s1-server-pg-check.mjs` on a disposable database.
 *
 * Against the base commit (0d32619) this fails: the preparation routes do not exist (404) and scoped
 * routes answer without a preparation.
 *
 * Usage: node tools/exam-s1-server-check.mjs
 */

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import { createOwnedApi, Fault } from '../server/owned-api.mjs';
import { createExamCatalogue, isCalendarDate, preparationDto } from '../server/preparation-contract.mjs';

const TELC = 'telc-deutsch-b1';
const SYNTH = 'synthetic-en-b2';
const PACKAGES = {
  [TELC]: { exam_id: TELC, exam: 'telc Deutsch B1', exam_language: 'de', level: 'B1' },
  [SYNTH]: { exam_id: SYNTH, exam: 'Synthetic English B2', exam_language: 'en', level: 'B2' },
  'synthetic-unpublished': { exam_id: 'synthetic-unpublished', exam: 'Unpublished', exam_language: 'fr', level: 'A2' },
};
const SETS = [
  { set_id: 'telc.lv1.01', version: 'v1', exam_id: TELC, family: 'LV1', review_status: 'unreviewed', rights_status: 'generated' },
  { set_id: 'synth.r1.01', version: 'v1', exam_id: SYNTH, family: 'LV1', review_status: 'unreviewed', rights_status: 'generated' },
];
const TASKS = [
  { task_id: 'writing.telc', version: 'v1', exam_id: TELC, rubric_id: 'r.telc', rubric_version: 'v1', review_status: 'unreviewed', rights_status: 'generated', created_at: '2026-01-01' },
  { task_id: 'writing.synth', version: 'v1', exam_id: SYNTH, rubric_id: 'r.synth', rubric_version: 'v1', review_status: 'unreviewed', rights_status: 'generated', created_at: '2026-01-01' },
];

const fail = (status, code) => { throw new Fault(status, code); };

/** In-memory datastore with the preparation capability. TEST ONLY: no RLS, no SQL. */
function createWorld({ enabled = [TELC] } = {}) {
  const catalogue = createExamCatalogue({ enabled });
  const preparations = new Map();
  const balances = new Map();
  const attempts = new Map();
  const evidence = [];
  const writes = [];
  const now = () => new Date().toISOString();
  const key = (owner, exam) => `${owner}\u0000${exam}`;
  const owned = (owner, id) => {
    const prep = preparations.get(id);
    if (!prep || prep.owner_id !== owner) fail(404, 'not_found');
    return prep;
  };
  const dto = (prep) => preparationDto({ ...prep, ...PACKAGES[prep.exam_id] });
  const provision = (owner, exam, allowance) => {
    const id = randomUUID();
    preparations.set(id, { id, owner_id: owner, exam_id: exam, exam_date: null, state: 'active', revision: 1, created_at: now(), updated_at: now() });
    if (allowance !== null) balances.set(key(owner, exam), { allowance, used: 0, reserved: 0 });
    return id;
  };

  const datastore = {
    // The writing/attempt port (only what this check needs).
    async create(owner, parent, binding, preparationId) {
      const prep = owned(owner, preparationId);
      if (prep.state !== 'active') fail(409, 'preparation_archived');
      const b = binding || { taskId: 'writing.telc', taskVersion: 'v1', rubricId: 'r.telc', rubricVersion: 'v1' };
      const task = TASKS.find((t) => t.task_id === b.taskId && t.version === b.taskVersion);
      if (!task) fail(422, 'task_not_servable');
      if (task.exam_id !== prep.exam_id) fail(422, 'preparation_mismatch');
      const id = randomUUID();
      attempts.set(id, { id, owner_id: owner, preparation_id: prep.id, exam_id: prep.exam_id });
      writes.push('attempt');
      return { id, revision: 1, text: '', preparation_id: prep.id, exam_id: prep.exam_id };
    },
    async read() { fail(404, 'not_found'); },
    async save() { fail(404, 'not_found'); },
    async submit() { fail(404, 'not_found'); },
    async result() { fail(404, 'not_found'); },
    async retry() { fail(404, 'not_found'); },
    async remove() { fail(404, 'not_found'); },
    async listAttempts(owner, { preparationId }) {
      return [...attempts.values()].filter((a) => a.owner_id === owner && a.preparation_id === preparationId);
    },
    async listOpenAttempts(owner, { preparationId }) {
      return [...attempts.values()].filter((a) => a.owner_id === owner && a.preparation_id === preparationId);
    },
    // Catalogue.
    async listTasks(owner, { examId }) { return TASKS.filter((t) => t.exam_id === examId); },
    async listObjectiveSets(owner, { examId }) { return SETS.filter((s) => s.exam_id === examId); },
    async readObjectiveSet(owner, { setId, version }) { return SETS.find((s) => s.set_id === setId && s.version === version) ?? null; },
    async readRubric() { return null; },
    async listVocab() { return []; },
    async listNouns() { return []; },
    async listGuides() { return []; },
    async readGuide() { return null; },
    // Practice.
    async answerObjectiveItem(owner, { preparationId, setId, version, itemId }) {
      const prep = owned(owner, preparationId);
      if (prep.state !== 'active') fail(409, 'preparation_archived');
      const set = SETS.find((s) => s.set_id === setId && s.version === version);
      if (!set) fail(404, 'not_found');
      if (set.exam_id !== prep.exam_id) fail(422, 'preparation_mismatch');
      evidence.push({ owner, preparationId, itemId });
      writes.push('evidence');
      return { evidence_id: randomUUID(), item_id: itemId, correct: true, preparation_id: prep.id, exam_id: prep.exam_id };
    },
    async nextPractice(owner, { preparationId }) { owned(owner, preparationId); return null; },
    async practiceProgress(owner, { preparationId }) {
      owned(owner, preparationId);
      const mine = evidence.filter((e) => e.owner === owner && e.preparationId === preparationId);
      return { totals: { attempts: mine.length, correct: mine.length, accuracy: mine.length ? 1 : null, sections: 0 }, sections: [] };
    },
    async listMistakes(owner, { preparationId }) { owned(owner, preparationId); return { preparation_id: preparationId, count: 0, items: [] }; },
    // Preparations.
    async listExams() { return catalogue.ids.map((id) => PACKAGES[id]).filter(Boolean); },
    async listPreparations(owner) { return [...preparations.values()].filter((p) => p.owner_id === owner).map(dto); },
    async readPreparation(owner, id) { return dto(owned(owner, id)); },
    async resolvePreparation(owner, id) { const p = owned(owner, id); return { id: p.id, exam_id: p.exam_id, state: p.state }; },
    async createPreparation(owner, examId) {
      if (!catalogue.isEnabled(examId) || !PACKAGES[examId]) fail(422, 'exam_unavailable');
      const active = [...preparations.values()].find((p) => p.owner_id === owner && p.exam_id === examId && p.state === 'active');
      if (active) return { created: false, preparation: dto(active) };
      const id = provision(owner, examId, null); // a preparation NEVER grants a balance
      writes.push('preparation');
      return { created: true, preparation: dto(preparations.get(id)) };
    },
    async updatePreparation(owner, id, expectedRevision, patch) {
      const prep = owned(owner, id);
      if (prep.revision !== expectedRevision) { const e = new Fault(409, 'preparation_conflict'); e.current = dto(prep); throw e; }
      if (patch.state === 'active' && prep.state !== 'active'
        && [...preparations.values()].some((p) => p.id !== id && p.owner_id === owner && p.exam_id === prep.exam_id && p.state === 'active')) {
        fail(409, 'active_preparation_exists');
      }
      if (patch.examDate !== undefined) prep.exam_date = patch.examDate;
      if (patch.state !== undefined) prep.state = patch.state;
      prep.revision += 1;
      prep.updated_at = now();
      writes.push('preparation_update');
      return dto(prep);
    },
    async readCredits(owner, id) {
      const prep = owned(owner, id);
      const b = balances.get(key(owner, prep.exam_id)) ?? { allowance: 0, used: 0, reserved: 0 };
      return { examId: prep.exam_id, ...b, available: Math.max(0, b.allowance - b.used - b.reserved) };
    },
  };

  const settingsStore = new Map();
  const settings = {
    async read(owner) { return settingsStore.get(owner) ?? { revision: 0, settings: { examDate: '2026-13-40', dailyGoal: 20, theme: 'system', language: 'de' } }; },
    async write(owner, expectedRevision, patch) {
      const current = await settings.read(owner);
      const next = { revision: current.revision + 1, settings: { ...current.settings, ...patch } };
      settingsStore.set(owner, next);
      writes.push('settings');
      return next;
    },
  };

  const sessionsByToken = new Map([['token-a', 'owner-a'], ['token-b', 'owner-b']]);
  const sessions = {
    async getSession(headers) {
      const token = String(headers.cookie || '').replace(/^s=/, '');
      const userId = sessionsByToken.get(token);
      return userId ? { userId, email: `${userId}@example.invalid` } : null;
    },
    async signUp() { return {}; }, async signIn() { return {}; }, async signOut() { return {}; },
  };

  const api = createOwnedApi({ datastore, sessions, settings });
  const call = async (who, method, path, body) => {
    const response = await api.handle({
      method, path, originChecked: true,
      headers: { cookie: `s=token-${who}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: JSON.parse(response.body) };
  };
  const prepOf = (owner, exam) => [...preparations.values()].find((p) => p.owner_id === owner && p.exam_id === exam && p.state === 'active');
  return { api, call, writes, balances, provision, prepOf, key };
}

const results = [];
async function leg(name, run) {
  try { await run(); results.push([name, true]); console.log(`ok   ${name}`); } catch (error) {
    results.push([name, false]);
    console.log(`FAIL ${name}\n     ${error && error.message ? error.message.split('\n').join('\n     ') : error}`);
  }
}

await leg('calendar dates are real dates', async () => {
  assert.equal(isCalendarDate('2026-02-28'), true);
  assert.equal(isCalendarDate('2028-02-29'), true);
  for (const bad of ['2026-02-29', '2026-02-30', '2026-13-01', '2026-00-10', '2026-1-01', '26-01-01', '', null]) {
    assert.equal(isCalendarDate(bad), false, `${bad} must be refused`);
  }
});

await leg('exams: only the server-enabled package is offered', async () => {
  const w = createWorld();
  const res = await w.call('a', 'GET', '/api/v1/exams');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.exams.map((e) => e.exam_id), [TELC]);
  assert.deepEqual(Object.keys(res.body.exams[0]).sort(), ['exam', 'exam_id', 'exam_language', 'level']);
  assert.equal((await w.call('a', 'GET', '/api/v1/exams?enabled=synthetic-en-b2')).status, 422, 'a query cannot widen the catalogue');
  const w2 = createWorld({ enabled: [TELC, SYNTH] });
  assert.deepEqual((await w2.call('a', 'GET', '/api/v1/exams')).body.exams.map((e) => e.exam_id), [TELC, SYNTH]);
});

await leg('create preparation: 201 new, 200 existing, date preserved, never a grant', async () => {
  const w = createWorld();
  const first = await w.call('a', 'POST', '/api/v1/preparations', { examId: TELC });
  assert.equal(first.status, 201);
  assert.deepEqual(Object.keys(first.body).sort(),
    ['created_at', 'exam', 'exam_date', 'exam_id', 'exam_language', 'id', 'revision', 'state', 'updated_at']);
  const dated = await w.call('a', 'PUT', `/api/v1/preparations/${first.body.id}`, { expectedRevision: 1, examDate: '2026-11-20' });
  assert.equal(dated.status, 200);
  const again = await w.call('a', 'POST', '/api/v1/preparations', { examId: TELC });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  assert.equal(again.body.exam_date, '2026-11-20', 'an idempotent create must not overwrite the date');
  assert.equal(w.balances.size, 0, 'creating a preparation granted no balance');
  const credits = await w.call('a', 'GET', `/api/v1/preparations/${first.body.id}/credits`);
  assert.deepEqual(credits.body, { examId: TELC, allowance: 0, used: 0, reserved: 0, available: 0 });
  assert.equal((await w.call('a', 'POST', '/api/v1/preparations', { examId: SYNTH })).status, 422, 'a disabled package cannot be prepared for');
  assert.equal((await w.call('a', 'POST', '/api/v1/preparations', { examId: TELC, examDate: '2026-11-20' })).status, 422);
});

await leg('update preparation: revision conflict returns the current DTO; dates are validated; identity immutable', async () => {
  const w = createWorld();
  const id = w.provision('owner-a', TELC, 5);
  const ok = await w.call('a', 'PUT', `/api/v1/preparations/${id}`, { expectedRevision: 1, examDate: '2026-12-01' });
  assert.equal(ok.body.revision, 2);
  const before = w.writes.length;
  const stale = await w.call('a', 'PUT', `/api/v1/preparations/${id}`, { expectedRevision: 1, examDate: '2027-01-01' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, 'preparation_conflict');
  assert.equal(stale.body.current.exam_date, '2026-12-01');
  assert.equal(stale.body.current.revision, 2);
  for (const body of [{ expectedRevision: 2, examDate: '2026-02-30' }, { expectedRevision: 2, examDate: '2026-2-1' },
    { expectedRevision: 2, examId: SYNTH }, { expectedRevision: 2 }, { examDate: '2026-12-02' },
    { expectedRevision: 2, state: 'deleted' }]) {
    assert.equal((await w.call('a', 'PUT', `/api/v1/preparations/${id}`, body)).status, 422, JSON.stringify(body));
  }
  assert.equal(w.writes.length, before, 'refused edits wrote nothing');
  assert.equal((await w.call('b', 'PUT', `/api/v1/preparations/${id}`, { expectedRevision: 2, examDate: null })).status, 404);
  assert.equal((await w.call('b', 'GET', `/api/v1/preparations/${id}`)).status, 404);
  assert.equal((await w.call('b', 'GET', `/api/v1/preparations/${id}/credits`)).status, 404);
  const cleared = await w.call('a', 'PUT', `/api/v1/preparations/${id}`, { expectedRevision: 2, examDate: null });
  assert.equal(cleared.body.exam_date, null);
});

await leg('archive and resume: history readable, no second active, no credit minted', async () => {
  const w = createWorld();
  const id = w.provision('owner-a', TELC, 3);
  const archived = await w.call('a', 'PUT', `/api/v1/preparations/${id}`, { expectedRevision: 1, state: 'archived' });
  assert.equal(archived.body.state, 'archived');
  assert.equal((await w.call('a', 'POST', '/api/v1/attempts', { preparationId: id })).status, 409, 'no new practice in an archived preparation');
  const fresh = await w.call('a', 'POST', '/api/v1/preparations', { examId: TELC });
  assert.equal(fresh.status, 201);
  const list = await w.call('a', 'GET', '/api/v1/preparations');
  assert.deepEqual(list.body.preparations.map((p) => p.state).sort(), ['active', 'archived'], 'archived history stays listed');
  const resume = await w.call('a', 'PUT', `/api/v1/preparations/${id}`, { expectedRevision: 2, state: 'active' });
  assert.equal(resume.status, 409);
  assert.equal(resume.body.error, 'active_preparation_exists');
  assert.deepEqual(w.balances.get(w.key('owner-a', TELC)), { allowance: 3, used: 0, reserved: 0 }, 'no grant or refill');
});

await leg('scoped reads require a preparation and never default to all exams', async () => {
  const w = createWorld({ enabled: [TELC, SYNTH] });
  const telc = w.provision('owner-a', TELC, 5);
  const synth = w.provision('owner-a', SYNTH, null);
  const foreign = w.provision('owner-b', TELC, 5);
  const routes = ['/api/v1/tasks', '/api/v1/objective-sets', '/api/v1/practice/next', '/api/v1/practice/progress',
    '/api/v1/practice/mistakes', '/api/v1/attempts', '/api/v1/attempts?open=1', '/api/v1/objective-sets/telc.lv1.01?version=v1'];
  for (const route of routes) {
    const sep = route.includes('?') ? '&' : '?';
    const missing = await w.call('a', 'GET', route);
    assert.equal(missing.status, 422, `${route} without context`);
    assert.equal(missing.body.error, 'preparation_required', route);
    assert.equal((await w.call('a', 'GET', `${route}${sep}preparationId=nope`)).body.error, 'invalid_preparation', route);
    assert.equal((await w.call('a', 'GET', `${route}${sep}preparationId=${foreign}`)).status, 404, `${route} foreign`);
    assert.equal((await w.call('a', 'GET', `${route}${sep}preparationId=${randomUUID()}`)).status, 404, `${route} absent`);
    // The attempt index never had an `exam` filter, so there it is simply an unknown query key.
    const examExpected = route.startsWith('/api/v1/attempts') ? 'invalid_query' : 'preparation_mismatch';
    assert.equal((await w.call('a', 'GET', `${route}${sep}preparationId=${telc}&exam=${SYNTH}`)).body.error, examExpected, `${route} exam`);
  }
  const telcTasks = await w.call('a', 'GET', `/api/v1/tasks?preparationId=${telc}`);
  assert.deepEqual(telcTasks.body.map((t) => t.exam_id), [TELC]);
  const synthSets = await w.call('a', 'GET', `/api/v1/objective-sets?preparationId=${synth}`);
  assert.deepEqual(synthSets.body.map((s) => s.exam_id), [SYNTH]);
  const crossRead = await w.call('a', 'GET', `/api/v1/objective-sets/telc.lv1.01?version=v1&preparationId=${synth}`);
  assert.equal(crossRead.body.error, 'preparation_mismatch');
});

await leg('writes: missing/foreign/mismatched context writes nothing', async () => {
  const w = createWorld({ enabled: [TELC, SYNTH] });
  const telc = w.provision('owner-a', TELC, 5);
  const synth = w.provision('owner-a', SYNTH, null);
  const foreign = w.provision('owner-b', TELC, 5);
  const answer = (preparationId, setId = 'telc.lv1.01') => w.call('a', 'POST', `/api/v1/objective-sets/${setId}/answers`,
    { ...(preparationId === undefined ? {} : { preparationId }), itemId: 'i1', answer: 'a', version: 'v1' });
  const before = w.writes.length;
  assert.equal((await answer(undefined)).body.error, 'preparation_required');
  assert.equal((await answer('x')).body.error, 'invalid_preparation');
  assert.equal((await answer(foreign)).status, 404);
  assert.equal((await answer(synth)).body.error, 'preparation_mismatch');
  assert.equal((await w.call('a', 'POST', '/api/v1/attempts', {})).body.error, 'preparation_required');
  assert.equal((await w.call('a', 'POST', '/api/v1/attempts', { preparationId: foreign })).status, 404);
  assert.equal((await w.call('a', 'POST', '/api/v1/attempts', { preparationId: synth, taskId: 'writing.telc', taskVersion: 'v1', rubricId: 'r.telc', rubricVersion: 'v1' })).body.error, 'preparation_mismatch');
  assert.equal(w.writes.length, before, 'no refused request wrote anything');
  assert.equal((await answer(telc)).status, 201);
  const created = await w.call('a', 'POST', '/api/v1/attempts', { preparationId: telc });
  assert.equal(created.status, 201);
  assert.equal(created.body.preparation_id, telc);
  assert.equal(created.body.exam_id, TELC);
  const listed = await w.call('a', 'GET', `/api/v1/attempts?preparationId=${synth}`);
  assert.deepEqual(listed.body.attempts, [], 'no cross-preparation history');
  const progress = await w.call('a', 'GET', `/api/v1/practice/progress?preparationId=${synth}`);
  assert.equal(progress.body.totals.attempts, 0, 'no cross-preparation evidence');
});

await leg('settings: examDate is read-only legacy, never written', async () => {
  const w = createWorld();
  const read = await w.call('a', 'GET', '/api/v1/settings');
  assert.equal(read.body.settings.examDate, '2026-13-40', 'the raw legacy value stays readable');
  const before = w.writes.length;
  assert.equal((await w.call('a', 'PUT', '/api/v1/settings', { expectedRevision: 0, examDate: '2026-12-01' })).status, 422);
  assert.equal((await w.call('a', 'PUT', '/api/v1/settings', { expectedRevision: 0, settings: { examDate: '2026-12-01' } })).status, 422);
  assert.equal(w.writes.length, before);
  const theme = await w.call('a', 'PUT', '/api/v1/settings', { expectedRevision: 0, theme: 'dark' });
  assert.equal(theme.status, 200);
  assert.equal(theme.body.settings.examDate, '2026-13-40', 'a settings write leaves the legacy date alone');
});

await leg('unwired preparations fail closed on scoped routes', async () => {
  const datastore = {
    create() {}, read() {}, save() {}, submit() {}, result() {}, retry() {}, remove() {},
    listTasks: async () => [{ exam_id: TELC }], listObjectiveSets: async () => [], readObjectiveSet: async () => null,
    readRubric: async () => null, listVocab: async () => [], listNouns: async () => [], listGuides: async () => [], readGuide: async () => null,
  };
  const sessions = { getSession: async () => ({ userId: 'owner-a' }), signUp() {}, signIn() {}, signOut() {} };
  const api = createOwnedApi({ datastore, sessions });
  const res = await api.handle({ method: 'GET', path: '/api/v1/tasks', headers: {} });
  assert.equal(res.status, 503);
  assert.equal(JSON.parse(res.body).error, 'preparations_unavailable');
});

const failed = results.filter(([, ok]) => !ok);
console.log(`\nexam-s1-server-check: ${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length ? 1 : 0;
