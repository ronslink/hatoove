#!/usr/bin/env node
/** Offline HTTP/shape negatives. PostgreSQL locking and grading are checked separately. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOwnedApi, Fault } from '../server/owned-api.mjs';
import { MOCK_METHODS, validateStartMockRun, validateSaveMockRun, validatePinnedSnapshot, mockMemberItems } from '../server/mock-contract.mjs';

let passed = 0;
async function check(name, work) { await work(); passed++; console.log('PASS ' + name); }
const id = randomUUID(); const prep = randomUUID(); const event = randomUUID();
const start = { preparationId: prep, formId: 'reading', formVersion: 'v1', releaseVersion: 'v1', eventId: event };
const save = { expectedRevision: 1, eventId: event, responses: [], position: { member: 0, item: 0 } };
const member = { set_id: 'set.one', version: 'v1', interaction: 'single_choice', item_count: 2,
  payload: { questions: [{ n: 1, options: { a: 'One', b: 'Two' } }, { n: 2, options: { a: 'Three', b: 'Four' } }] } };
const writes = [];
const datastore = Object.fromEntries(['create','read','save','submit','result','retry','remove'].map((name) => [name, async () => ({})]));
for (const name of MOCK_METHODS) datastore[name] = async (owner, ...args) => {
  writes.push({ name, owner, args });
  if (name === 'startMockRun') return { created: true, run: { id, state: 'active', result: null } };
  if (name.startsWith('list')) return [];
  return { id, state: 'active', result: null };
};
const sessions = { getSession: async (headers) => headers.cookie === 'owner=a' ? { userId: 'a', email: 'a@example.invalid' } : null,
  signUp: async () => ({}), signIn: async () => ({}), signOut: async () => ({}) };
const api = createOwnedApi({ datastore, sessions });
async function call(method, path, body, cookie = 'owner=a', originChecked = true) {
  const response = await api.handle({ method, path, headers: { cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), originChecked });
  return { status: response.status, body: JSON.parse(response.body) };
}
await check('explicit versions, owned preparation and event required', () => {
  assert.deepEqual(validateStartMockRun(start), start);
  for (const key of Object.keys(start)) assert.throws(() => validateStartMockRun({ ...start, [key]: undefined }), Fault);
  for (const key of ['owner','examId','correct','state']) assert.throws(() => validateStartMockRun({ ...start, [key]: 'injected' }), /unknown_field/);
});
await check('bounded snapshot and exact response shape', () => {
  assert.deepEqual(validateSaveMockRun(save), save);
  const response = { setId: 'set.one', version: 'v1', itemId: '1', answer: 'a' };
  for (const patch of [{ responses: [response,response] }, { responses: [{ ...response, correct: true }] },
    { responses: [{ ...response, answer: {} }] }, { position: { member: 0, item: -1 } }, { expectedRevision: 0 },
    { eventId: 'not-an-event' }, { responses: Array(501).fill(response) }]) {
    assert.throws(() => validateSaveMockRun({ ...save, ...patch }), Fault);
  }
});
await check('pinned items, offered answers and position enforced', () => {
  const response = { setId: 'set.one', version: 'v1', itemId: '1', answer: 'a' };
  validatePinnedSnapshot([member], [response], save.position);
  validatePinnedSnapshot([member], [{ ...response, answer: null }], save.position);
  for (const patch of [{ version: 'v2' }, { itemId: '3' }, { answer: 'c' }])
    assert.throws(() => validatePinnedSnapshot([member], [{ ...response, ...patch }], save.position), Fault);
  assert.throws(() => validatePinnedSnapshot([member], [], { member: 1, item: 0 }), Fault);
});
await check('interaction driven across all five supported shapes', () => {
  for (const [interaction,payload] of [
    ['matching_headlines',{ texts: [{id:'1'}],headlines:[{id:'a'},{id:'b'}] }],
    ['matching_ads',{ situations:[{n:1}],ads:[{id:'a'},{id:'b'}] }],
    ['gap_choice',{gaps:[{n:1,options:{a:'A',b:'B'}}]}],
    ['gap_bank',{gaps:[{n:1}],bank:[{id:'a'},{id:'b'}]}],
  ]) assert.equal(mockMemberItems({ interaction, payload, item_count: 1 }).length, 1);
  assert.throws(() => mockMemberItems({ ...member, interaction: 'writing' }), Fault);
});
await check('mock capability optional; missing cannot disable existing API', async () => {
  const base = Object.fromEntries(['create','read','save','submit','result','retry','remove'].map((name) => [name, async () => ({})]));
  const other = createOwnedApi({ datastore: base, sessions });
  assert.equal(other.configured, true);
  const response = await other.handle({ method:'GET',path:'/api/v1/mock-forms?preparationId='+prep,headers:{cookie:'owner=a'} });
  assert.equal(response.status, 503);
});
await check('session and origin fence run routes before any datastore write', async () => {
  const count = writes.length;
  assert.equal((await call('POST','/api/v1/mock-runs',start,'')).status,401);
  assert.equal((await call('POST','/api/v1/mock-runs',start,'owner=a',false)).status,403);
  assert.equal(writes.length,count);
});
await check('HTTP strict bodies and query shape reject identity injection', async () => {
  const count = writes.length;
  assert.equal((await call('POST','/api/v1/mock-runs',{...start,owner:'b'})).status,422);
  assert.equal((await call('PUT',`/api/v1/mock-runs/${id}`,{...save,result:{correct:2}})).status,422);
  assert.equal((await call('GET','/api/v1/mock-runs?preparationId='+prep+'&owner=b')).status,422);
  assert.equal((await call('GET','/api/v1/mock-runs?preparationId='+prep+'&preparationId='+prep)).status,422);
  assert.equal((await call('GET','/api/v1/mock-forms')).status,422);
  assert.equal(writes.length,count);
});
await check('all routes call owned port using verified owner and exact shape', async () => {
  assert.equal((await call('GET','/api/v1/mock-forms?preparationId='+prep)).status,200);
  assert.equal((await call('GET','/api/v1/mock-runs?preparationId='+prep)).status,200);
  assert.equal((await call('POST','/api/v1/mock-runs',start)).status,201);
  assert.equal((await call('GET',`/api/v1/mock-runs/${id}`)).status,200);
  assert.equal((await call('PUT',`/api/v1/mock-runs/${id}`,save)).status,200);
  assert.equal((await call('POST',`/api/v1/mock-runs/${id}/finalise`,{expectedRevision:1,eventId:event})).status,200);
  assert.ok(writes.every((row) => row.owner === 'a'));
  assert.equal((await call('DELETE',`/api/v1/mock-runs/${id}`,{})).status,404);
});
console.log(`\n${passed} passed, 0 failed (offline mock contract; no database evidence)`);
