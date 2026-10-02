#!/usr/bin/env node
/** Deterministic structure hints and recovered content. No model, browser or existing learner data. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { checkSentence, SENTENCE_TEXT_LIMIT } from '../server/sentence-building.mjs';
import { createOwnedApi } from '../server/owned-api.mjs';
import { createMemoryDatastore, createMemorySessions } from './owned-api-check.mjs';

const checks = [];
const check = (name, run) => checks.push({ name, run });
const codes = (text) => checkSentence(text).hints.map((hint) => hint.code);
const bank = JSON.parse(readFileSync(new URL('../content/drills/recovered-grammar.json', import.meta.url), 'utf8'));
const setId = 'telc-deutsch-b1.sb1.grammar-wortstellung-v1';
let world;
let cookie;
let otherCookie;
const pg = process.argv.includes('--backend=postgres');

check('simple sentence exposes a candidate verb and never a correctness or score claim', () => {
  const result = checkSentence('Ich komme morgen.');
  assert.equal(result.kind, 'structural-hints'); assert.equal(result.limited, true);
  assert.match(result.limitation, /keine vollständige Grammatikprüfung/u);
  assert.deepEqual(result.clauses[0].finite, { word: 'komme', index: 1 });
  assert.equal(result.clauses[0].type, 'main'); assert.deepEqual(result.hints, []);
  for (const key of ['score', 'grade', 'correct', 'errors', 'passed']) assert.equal(key in result, false);
});
check('simple subordinate and main-clause order produce cautious hints', () => {
  assert.ok(codes('Ich bleibe zu Hause, weil ich bin müde.').includes('subordinate_verb_position'));
  assert.ok(codes('Morgen ich gehe zur Arbeit.').includes('main_verb_position'));
  assert.ok(!codes('Ich bleibe zu Hause, weil ich müde bin.').includes('subordinate_verb_position'));
  assert.ok(!codes('Morgen gehe ich zur Arbeit.').includes('main_verb_position'));
});
check('opening subordinate clause is distinguished from sentence boundaries and embedded clauses', () => {
  assert.ok(codes('Weil ich müde bin, ich bleibe zu Hause.').includes('main_after_subordinate'));
  assert.ok(!codes('Weil ich müde bin, bleibe ich zu Hause.').includes('main_after_subordinate'));
  assert.ok(!codes('Weil ich müde bin. Ich bleibe zu Hause.').includes('main_after_subordinate'));
  assert.ok(!codes('Ich bleibe, weil ich müde bin, und ich lese.').includes('main_after_subordinate'));
  assert.ok(!codes('Wenn du kommst, dann gehen wir.').includes('main_after_subordinate'));
});
check('multiword subjects, focus particles, ordinals and adjectives do not trigger old false corrections', () => {
  for (const text of ['Mein Bruder und ich gehen nach Hause.', 'Auch ich gehe nach Hause.',
    'Nur ich gehe nach Hause.', 'Ich habe eine schöne Wohnung.', 'Der kleine Junge spielt.']) {
    assert.deepEqual(codes(text).filter((code) => /position|capital|noun/u.test(code)), [], text);
  }
  const ordinal = checkSentence('Am 3. Mai fahre ich nach Berlin.');
  assert.equal(ordinal.clauses.length, 1); assert.equal(ordinal.clauses[0].finite.word, 'fahre');
});
check('unknown forms are uncertain rather than guessed from suffixes or final position', () => {
  for (const text of ['Die Quantenfluide oszillieren.', 'weil die Quantenfluide oszillieren',
    'Eine schöne Woche.', 'مرحبا بالعالم', '12345', '🙂']) {
    const result = checkSentence(text);
    assert.equal(result.clauses[0].finite, null, text);
    assert.equal(result.clauses[0].type, 'uncertain', text);
    assert.ok(result.hints.some((hint) => hint.severity === 'uncertain'), text);
  }
});
check('complex auxiliary clusters avoid a false verb-final correction', () => {
  for (const text of ['weil ich habe arbeiten müssen', 'weil ich hätte kommen können']) {
    const result = checkSentence(text);
    assert.equal(result.clauses[0].type, 'uncertain');
    assert.ok(!codes(text).includes('subordinate_verb_position'));
  }
  assert.ok(!codes('weil wir morgen kommen können').includes('subordinate_verb_position'));
});
check('questions and possible sentence brackets are hints without grammatical approval', () => {
  assert.equal(checkSentence('Kommst du morgen?').clauses[0].type, 'question');
  assert.equal(checkSentence('Warum kommst du morgen?').clauses[0].type, 'question');
  assert.ok(codes('Ich kann morgen kommen.').includes('verb_bracket'));
  assert.ok(codes('Ich habe gestern gelernt.').includes('verb_bracket'));
  assert.ok(!codes('Ich habe Brot.').includes('verb_bracket'));
});
check('finite-first imperatives and ambiguous prepositions are not confidently classified as questions or conjunctions', () => {
  assert.equal(checkSentence('Gehen Sie bitte.').clauses[0].type, 'uncertain');
  assert.equal(checkSentence('Als Lehrer arbeite ich hier.').clauses[0].trigger, null);
  assert.equal(checkSentence('Da draußen ist es warm.').clauses[0].trigger, null);
  assert.equal(checkSentence('Seit gestern arbeite ich hier.').clauses[0].trigger, null);
});
check('results are deterministic, bounded and explicit when clause analysis is truncated', () => {
  const text = 'Ich komme morgen, weil ich heute arbeite.';
  assert.deepEqual(checkSentence(text), checkSentence(text));
  const many = checkSentence('Ich komme. '.repeat(40));
  assert.equal(many.truncated, true); assert.equal(many.clauses.length, 24);
  assert.ok(many.hints.some((hint) => hint.code === 'clause_limit'));
  assert.ok(JSON.stringify(many).length < 60000);
  for (const value of ['', '   ', null, 1, {}, 'x'.repeat(SENTENCE_TEXT_LIMIT + 1)]) assert.throws(() => checkSentence(value));
  assert.ok(checkSentence('x'.repeat(SENTENCE_TEXT_LIMIT)).limited);
});
check('full recovered bank preserves source identities and generated unreviewed provenance', () => {
  assert.equal(Object.keys(bank.banks).length, 17);
  const all = Object.values(bank.banks).flat();
  assert.equal(all.length, 240); assert.equal(new Set(all.map((row) => row.id)).size, 240);
  assert.equal(bank.rights_basis, 'generated'); assert.equal(bank.review_status, 'unreviewed');
  assert.equal(bank.source.commit, '3a9254ce3905b7d4de430e3d129edf0f62c90962');
  assert.match(bank.source.sha256, /^[a-f0-9]{64}$/);
  for (const [tag, items] of Object.entries(bank.banks)) for (const [index, item] of items.entries()) {
    let hash = 2166136261;
    for (let i = 0; i < item.q.length; i++) { hash ^= item.q.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    assert.equal(item.id, `g_${tag}_${(hash >>> 0).toString(36)}`);
    assert.equal(item.ordinal, index + 1);
    assert.equal(item.options.filter((option) => option === item.answer).length, 1);
    assert.ok(item.why && item.q);
  }
});

const call = async (method, path, body, sourceCookie = cookie, originChecked = true) => {
  const response = await world.api.handle({ method, path, originChecked,
    headers: { 'content-type': 'application/json', ...(sourceCookie ? { cookie: sourceCookie } : {}) },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: JSON.parse(response.body), cookie: String(response.headers['set-cookie'] || '').split(';')[0] };
};
const expect = (response, status = 200) => {
  assert.equal(response.status, status, JSON.stringify(response.body)); return response.body;
};
check('authenticated sentence route refuses anonymous, foreign-origin and malformed requests', async () => {
  if (pg) {
    const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
    world = await createPostgresWorld();
  } else {
    const store = createMemoryDatastore(); const sessions = createMemorySessions();
    world = { store, api: createOwnedApi({ datastore: store.port, sessions, settings: store.settings }) };
  }
  const signup = await call('POST', '/api/auth/sign-up/email',
    { name: 'Synthetic sentence learner', email: `sentence-${randomUUID()}@example.invalid`, password: 'synthetic-sentence-password' }, null);
  expect(signup); cookie = signup.cookie;
  const other = await call('POST', '/api/auth/sign-up/email',
    { name: 'Other sentence learner', email: `sentence-${randomUUID()}@example.invalid`, password: 'synthetic-sentence-password' }, null);
  expect(other); otherCookie = other.cookie;
  expect(await call('POST', '/api/v1/sentence-check', { text: 'Ich komme.' }, null), 401);
  expect(await call('POST', '/api/v1/sentence-check', { text: 'Ich komme.' }, cookie, false), 403);
  for (const body of [{}, { text: '' }, { text: ' ' }, { text: null }, { text: 1 },
    { text: 'x'.repeat(2001) }, { text: 'Ich komme.', owner_id: 'other' }, { text: 'Ich komme.', model: 'anything' }]) {
    expect(await call('POST', '/api/v1/sentence-check', body), 422);
  }
  expect(await call('GET', '/api/v1/sentence-check'), 404);
});
check('sentence route matches the pure analyser and persists no learner text', async () => {
  const before = await world.store.inspect.fingerprint();
  const text = 'SYNTHETIC: Morgen ich gehe nach Hause.';
  const result = expect(await call('POST', '/api/v1/sentence-check', { text }));
  assert.deepEqual(result, checkSentence(text));
  const after = await world.store.inspect.fingerprint(); assert.equal(after, before);
  assert.deepEqual(expect(await call('GET', '/api/v1/attempts')).attempts, []);
});

if (pg) {
  check('forward migration serves only the selected grammar bank with no answer keys', async () => {
    const all = expect(await call('GET', '/api/v1/objective-sets?family=SB1'));
    const entry = all.find((row) => row.set_id === setId);
    assert.ok(entry); assert.equal(entry.item_count, 12);
    assert.equal(entry.review_status, 'unreviewed'); assert.equal(entry.rights_status, 'generated');
    const detail = expect(await call('GET', `/api/v1/objective-sets/${setId}?version=v1`));
    assert.equal(detail.payload.practice_kind, 'grammar-drill');
    assert.match(detail.payload.instruction, /kein telc-Prüfungssatz/u);
    assert.equal(detail.payload.gaps.length, 12);
    const unsafe = /^(answer|answerKey|answers|explanation|explanations|why|correct)$/u;
    const walk = (value) => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) {
      assert.equal(unsafe.test(key), false, `learner payload leaks ${key}`); walk(child);
    } };
    walk(detail);
    const row = (await world.fixture.admin.query('SELECT content_sha256 FROM content_version WHERE content_version_id=$1', [setId + '@v1'])).rows[0];
    assert.equal(row.content_sha256, createHash('sha256').update(JSON.stringify(bank.banks.wortstellung_nebensatz)).digest('hex'));
    const recovered = (await world.fixture.admin.query("SELECT count(*)::int AS n FROM objective_set WHERE set_id LIKE '%grammar-wortstellung%'")).rows[0];
    assert.equal(recovered.n, 1);
    await assert.rejects(world.fixture.learner.query('SELECT answers FROM objective_key LIMIT 1'), (error) => error.code === '42501');
  });
  check('every selected item retains identity, key and explanation; marking records owner-scoped evidence', async () => {
    const detail = expect(await call('GET', `/api/v1/objective-sets/${setId}`));
    const key = (await world.fixture.admin.query('SELECT answers,explanations FROM objective_key WHERE set_id=$1 AND version=$2', [setId, 'v1'])).rows[0];
    for (const item of bank.banks.wortstellung_nebensatz) {
      const gap = detail.payload.gaps.find((row) => row.n === item.id);
      assert.ok(gap); assert.equal(gap.prompt, item.q); assert.equal(gap.options[key.answers[item.id]], item.answer);
      assert.equal(key.explanations[item.id], item.why);
      assert.equal(expect(await call('POST', `/api/v1/objective-sets/${setId}/answers`,
        { version: 'v1', itemId: item.id, answer: key.answers[item.id] }), 201).correct, true);
    }
    const first = detail.payload.gaps[0];
    const wrong = Object.keys(first.options).find((option) => option !== key.answers[first.n]);
    assert.equal(expect(await call('POST', `/api/v1/objective-sets/${setId}/answers`,
      { version: 'v1', itemId: first.n, answer: wrong }), 201).correct, false);
    const mine = expect(await call('GET', '/api/v1/export')).objective_evidence;
    assert.equal(mine.length, 13); assert.ok(mine.every((row) => row.set_id === setId && row.version === 'v1'));
    assert.deepEqual(expect(await call('GET', '/api/v1/export', undefined, otherCookie)).objective_evidence, []);
    const previous = process.env.B1PREP_SERVE_RIGHTS;
    try {
      process.env.B1PREP_SERVE_RIGHTS = 'licensed';
      expect(await call('GET', `/api/v1/objective-sets/${setId}`), 404);
      expect(await call('POST', `/api/v1/objective-sets/${setId}/answers`, { itemId: first.n, answer: wrong }), 404);
    } finally { if (previous === undefined) delete process.env.B1PREP_SERVE_RIGHTS; else process.env.B1PREP_SERVE_RIGHTS = previous; }
  });
}

let passed = 0;
const failures = [];
try {
  for (const test of checks) {
    try { await test.run(); passed += 1; console.log(`PASS ${test.name}`); }
    catch (error) { failures.push(test.name); console.log(`FAIL ${test.name}\n${error.stack}`); }
  }
} finally { if (world?.teardown) await world.teardown(); }
console.log(`\n${passed} passed, ${failures.length} failed (${pg ? 'PostgreSQL/RLS and migrated content' : 'offline analyser and memory API'})`);
process.exitCode = failures.length ? 1 : 0;
