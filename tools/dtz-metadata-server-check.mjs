#!/usr/bin/env node
/** Selected-package metadata contracts. Optional PostgreSQL coverage uses an explicit disposable DB. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { blueprintParts, blueprintMetadata } from '../server/exam-parts.mjs';
import { createOwnedApi } from '../server/owned-api.mjs';
import { createPostgresDatastore } from '../server/owned-postgres/adapter.mjs';
import { createExamCatalogue } from '../server/preparation-contract.mjs';

const TELC = 'telc-deutsch-b1', DTZ = 'dtz-a2-b1';
const source = async file => JSON.parse(await readFile(new URL('../' + file, import.meta.url), 'utf8'));
const telc = (await source('content/exams/telc-deutsch-b1/listening-package.json')).blueprint;
const dtz = (await source('content/exams/dtz-a2-b1/writing-manifest.json')).blueprint;
let passed = 0;
const check = async (name, run) => { await run(); passed++; console.log('PASS ' + name); };
const clone = value => structuredClone(value);
const prepId = randomUUID(), ownerId = randomUUID();
const request = async (api, suffix = '?preparationId=' + prepId) => {
  const response = await api.handle({ method: 'GET', path: '/api/v1/exam-parts' + suffix, headers: {}, originChecked: true });
  return { status: response.status, data: JSON.parse(response.body) };
};
function fakeApi(overrides = {}) {
  const unused = async () => { throw Error('Unexpected port call'); };
  const methods = ['create','read','save','submit','result','retry','remove','listTasks','listObjectiveSets','readObjectiveSet',
    'readRubric','listVocab','listNouns','listGuides','readGuide','listExams','listPreparations','readPreparation',
    'createPreparation','updatePreparation','readCredits'];
  const datastore = { ...Object.fromEntries(methods.map(name => [name, unused])),
    resolvePreparation: async (owner, id) => { assert.equal(owner, ownerId); assert.equal(id, prepId); return { id, exam_id: DTZ }; },
    ...overrides };
  return createOwnedApi({ datastore, sessions: { signUp: unused, signIn: unused, signOut: unused,
    getSession: async () => ({ userId: ownerId }) } });
}

await check('blueprint order includes every DTZ reading part without telc item or point defaults', () => {
  const parts = blueprintParts(dtz);
  assert.deepEqual(parts.map(p => p.family), ['LV1','LV2','LV3','LV4','LV5','writing']);
  assert.deepEqual(parts.slice(0, 5).map(p => p.part), [1,2,3,4,5]);
  assert.deepEqual(parts.slice(0, 5).map(p => p.itemCount), [5,5,6,3,6]);
  assert.equal(parts.find(p => p.family === 'LV2').interaction, 'matching_ads');
  assert.ok(parts.every(p => p.points === null));
  assert.equal(parts.at(-1).part, null);
});
await check('sections retain writing, shared time groups and unknown facts without inference', () => {
  const readingWriting = blueprintMetadata(dtz);
  assert.deepEqual(readingWriting.sections.map(s => s.id), ['LV','SA']);
  assert.equal(readingWriting.sections[1].timeGroup, null);
  assert.ok(readingWriting.sections.every(s => s.points === null));
  assert.deepEqual(readingWriting.time_groups, dtz.timeGroups);
  assert.deepEqual(blueprintMetadata(telc).time_groups, telc.timeGroups);
  const partial = { sections: [{ id: 'HV', parts: [{ family: 'HV4', itemCount: 3, mediaRequired: true }] }] };
  assert.deepEqual(blueprintMetadata(partial).time_groups, []);
  assert.equal(blueprintParts(partial)[0].playback, null);
});
await check('declared section/part order wins even when it differs from telc order', () => {
  const reordered = clone(telc); reordered.sections.reverse();
  assert.deepEqual(blueprintParts(reordered).map(p => p.family), reordered.sections.flatMap(s => s.parts.map(p => p.family)));
  assert.deepEqual(blueprintParts(telc).filter(p => p.section === 'HV').map(p => p.playback.mock), [1,2,2]);
});
await check('malformed or duplicate structure and inconsistent timings fail closed', () => {
  for (const mutate of [p => p.sections.push(clone(p.sections[0])), p => p.sections[0].parts.push(clone(p.sections[0].parts[0])),
    p => p.sections[0].parts = [], p => p.timeGroups[0].seconds = -1, p => p.sections[0].timeGroup = 'missing']) {
    const invalid = clone(dtz); mutate(invalid); assert.throws(() => blueprintMetadata(invalid), /exam_blueprint_invalid/);
  }
});
const metadata = { exam_id: DTZ, release_version: 'v3', blueprint_version: 'v3', ...blueprintMetadata(dtz) };
await check('route preserves exact scoped metadata and refuses cross-exam or absent preparation', async () => {
  let reads = 0;
  const api = fakeApi({ readExamMetadata: async (owner, { examId }) => { reads++; assert.equal(owner, ownerId); assert.equal(examId, DTZ); return metadata; } });
  assert.deepEqual(await request(api), { status: 200, data: metadata });
  assert.equal((await request(api, '?preparationId=' + prepId + '&examId=' + TELC)).status, 422);
  assert.equal((await request(api, '')).status, 422);
  assert.equal(reads, 1);
  assert.equal((await request(fakeApi({ readExamMetadata: async () => ({ ...metadata, exam_id: TELC }) }))).status, 503);
});
await check('legacy parts-only ports advertise no invented release, structure or timing', async () => {
  const parts = blueprintParts(dtz);
  const response = await request(fakeApi({ listExamParts: async () => parts }));
  assert.deepEqual(response, { status: 200, data: { exam_id: DTZ, release_version: null, blueprint_version: null, sections: [], time_groups: [], parts } });
  assert.equal((await request(fakeApi())).status, 503);
});

if (process.argv.includes('--postgres')) {
  const portNumber = Number(process.env.OWNAPI_PG_PORT);
  assert.equal(process.env.OWNAPI_PG_ALLOW, '1', 'explicit disposable database opt-in required');
  assert.ok(Number.isInteger(portNumber) && portNumber > 0 && ![4300,55435,55440].includes(portNumber), 'explicit isolated port required');
  assert.ok(process.env.OWNAPI_PG_HOST && process.env.OWNAPI_PG_DATABASE && process.env.OWNAPI_PG_USER, 'explicit database identity required');
  assert.ok(!['postgres','template0','template1'].includes(process.env.OWNAPI_PG_DATABASE));
  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
  delete process.env.B1PREP_SERVE_REVIEW; delete process.env.B1PREP_SERVE_RIGHTS;
  const { createFixture } = await import('../server/owned-postgres/bootstrap.mjs');
  const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
  const { importPackage } = await import('../server/owned-postgres/package-importer.mjs');
  const { listReleasedForms } = await import('../server/owned-postgres/packages.mjs');
  const { recordReviewerAuthority, recordContentReview } = await import('../server/owned-postgres/content-review.mjs');
  const { createCompleteFixture } = await import('./exam-s5b-fixture.mjs');
  const mediaRoot = await mkdtemp(path.join(os.tmpdir(), 'hatoove-dtz-metadata-'));
  const catalogue = createExamCatalogue({ enabled: [TELC, DTZ] });
  let db, world;
  try {
    db = await createFixture();
    const packages = await Promise.all([TELC, DTZ].map(examId => createCompleteFixture({ examId, mediaRoot, durationMs: 250 })));
    for (const item of packages) await importPackage(db.migration, item, { mediaRoot });
    world = await createPostgresWorld({ fixture: db, examCatalogue: catalogue });
    const signup = await world.sessions.signUp({ name: 'Synthetic metadata', email: 'metadata-' + randomUUID() + '@example.invalid', password: 'Synthetic-metadata-contract-2026' });
    const cookie = String(signup.setCookie).split(';')[0];
    const owner = (await world.sessions.getSession({ cookie })).userId;
    const port = world.store.port;
    const preparations = await port.listPreparations(owner);
    const dtzPreparation = (await port.createPreparation(owner, DTZ)).preparation;
    const get = async (api, id, extra = '') => {
      const result = await api.handle({ method: 'GET', path: '/api/v1/exam-parts?preparationId=' + id + extra, headers: { cookie }, originChecked: true });
      return { status: result.status, data: JSON.parse(result.body) };
    };
    await check('postgres: both exact releases supply their own ordered parts, writing section and schedule', async () => {
      for (const item of packages) {
        const actual = await port.readExamMetadata(owner, { examId: item.exam.id });
        assert.equal(actual.exam_id, item.exam.id); assert.equal(actual.release_version, item.release.version); assert.equal(actual.blueprint_version, item.blueprint.version);
        assert.deepEqual(actual.sections.map(s => s.id), item.blueprint.sections.map(s => s.id));
        assert.deepEqual(actual.time_groups, item.blueprint.timeGroups);
        assert.deepEqual(actual.parts.map(p => p.family), item.blueprint.sections.flatMap(s => s.parts.filter(p => p.family !== 'writing').map(p => p.family)));
        assert.deepEqual(await port.listExamParts(owner, { examId: item.exam.id }), actual.parts);
        assert.ok(actual.sections.some(s => ['SA','writing'].includes(s.id))); assert.ok(!actual.parts.some(p => p.family === 'writing'));
        assert.ok(actual.parts.every(p => p.points === null));
        const forms = await listReleasedForms(db.learner, item.exam.id);
        assert.equal(forms.length, 1); assert.deepEqual(forms[0].time_groups, item.blueprint.timeGroups);
        assert.equal(forms[0].time_limit_seconds, item.blueprint.timeGroups.reduce((n,g) => n + g.seconds, 0));
      }
    });
    await check('postgres: actual HTTP scopes metadata to the selected preparation', async () => {
      const result = await get(world.api, dtzPreparation.id);
      assert.equal(result.status, 200); assert.equal(result.data.exam_id, DTZ);
      assert.deepEqual(result.data.parts.filter(p => p.section === 'HV').map(p => p.family), ['HV1','HV2','HV3','HV4']);
      assert.deepEqual(result.data.parts.filter(p => p.section === 'HV').map(p => p.playback.mock), [1,1,1,1]);
      assert.equal((await get(world.api, dtzPreparation.id, '&examId=' + TELC)).status, 422);
      assert.equal((await get(world.api, randomUUID())).status, 404);
      assert.equal((await get(world.api, preparations[0].id)).data.exam_id, TELC);
    });
    await check('postgres: metadata and legacy parts use a single read-only snapshot', async () => {
      const statements = [];
      const pool = { connect: async () => {
        const connection = await db.learner.connect();
        return { query: (sql, values) => { statements.push(sql); return connection.query(sql, values); }, release: () => connection.release() };
      } };
      const observed = createPostgresDatastore({ pool, examCatalogue: catalogue });
      for (const method of ['readExamMetadata','listExamParts']) {
        statements.length = 0; await observed[method](owner, { examId: DTZ });
        assert.equal(statements.filter(sql => sql === 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY').length, 1);
        assert.ok(!statements.some(sql => /\b(INSERT|UPDATE|DELETE)\b/i.test(sql)));
      }
    });
    await check('postgres: withheld objective family loses its tile while writing structure survives', async () => {
      const transaction = async run => {
        const client = await db.migration.connect();
        try { await client.query('BEGIN'); const result = await run(client); await client.query('COMMIT'); return result; }
        catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
      };
      const authority = await transaction(client => recordReviewerAuthority(client, { eventId: randomUUID(), reviewerId: 'synthetic.metadata.parts', reviewerName: 'Synthetic negative fixture only', examId: TELC, category: 'educational', language: '', action: 'grant', expectedAuthorityId: null, evidenceRef: 'fixture://synthetic-metadata-appointment', evidenceSha256: 'c'.repeat(64), rationale: 'Disposable negative fixture; no real content approval' }));
      const rows = (await db.migration.query('SELECT DISTINCT c.content_version_id,c.content_sha256 FROM objective_set s JOIN content_version c USING(content_version_id) WHERE s.exam_id=$1 AND s.family=$2', [TELC,'LV3'])).rows;
      assert.ok(rows.length);
      for (const row of rows) {
        const projection = (await db.migration.query('SELECT * FROM effective_content_review($1)', [row.content_version_id])).rows[0];
        await transaction(client => recordContentReview(client, { eventId: randomUUID(), subject: { kind: 'content', examId: TELC, subjectId: row.content_version_id, version: '', sha256: row.content_sha256 }, category: 'educational', language: '', authorityId: authority.authorityId, expectedDecisionId: projection.decision_ids[0] || null, decision: 'reject', evidenceRef: 'fixture://synthetic-metadata-withheld-family', evidenceSha256: 'd'.repeat(64), rationale: 'Disposable negative fixture only; preserve all source rows', packetSha256: null }));
      }
      const actual = await port.readExamMetadata(owner, { examId: TELC });
      assert.ok(!actual.parts.some(p => p.family === 'LV3')); assert.ok(actual.parts.some(p => p.family === 'LV2'));
      assert.ok(actual.sections.some(s => s.id === 'writing'));
    });
    await check('postgres: public policy withholds internal DTZ structure and complete forms', async () => {
      process.env.B1PREP_CONTENT_MODE = 'public';
      try {
        assert.deepEqual(await port.readExamMetadata(owner, { examId: DTZ }), { exam_id: DTZ, release_version: null, blueprint_version: null, sections: [], time_groups: [], parts: [] });
        assert.deepEqual(await listReleasedForms(db.learner, DTZ), []);
      } finally { process.env.B1PREP_CONTENT_MODE = 'internal-preview'; }
    });
  } finally {
    if (world) await world.teardown(); else if (db) await db.cleanup();
    await rm(mediaRoot, { recursive: true, force: true });
  }
}
console.log(`DTZ metadata server: ${passed} checks passed`);
