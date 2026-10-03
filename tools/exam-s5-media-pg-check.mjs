#!/usr/bin/env node
/** Restricted-role listening/media acceptance against an explicitly disposable database only. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import {importHistoricalDefaultPackage,assertHistoricalProjectionAbsent} from './historical-content-fixture.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresDatastore } from '../server/owned-postgres/adapter.mjs';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';
import { createExamCatalogue } from '../server/preparation-contract.mjs';
import { createOwnedApi } from '../server/owned-api.mjs';
import { createListeningFixture } from './exam-s5-fixture.mjs';

if (process.env.OWNAPI_PG_ALLOW !== '1' || !process.env.OWNAPI_PG_PORT || [4300,55440].includes(Number(process.env.OWNAPI_PG_PORT)))
  throw new Error('Explicit disposable OWNAPI_PG_ALLOW=1 and OWNAPI_PG_PORT required; learner ports forbidden.');
process.env.B1PREP_CONTENT_MODE = 'internal-preview';
delete process.env.B1PREP_SERVE_REVIEW; delete process.env.B1PREP_SERVE_RIGHTS;
const DTZ = 'dtz-a2-b1', TELC = 'telc-deutsch-b1';
const mediaRoot = await mkdtemp(path.join(tmpdir(), 'hatoove-s5-media-'));
const catalogue = createExamCatalogue({ enabled: [TELC,DTZ] });
const db = await createFixture({ stopBefore: '0029-' });
const world = await createPostgresWorld({ fixture: db, examCatalogue: catalogue });
const port = createPostgresDatastore({ pool: db.learner, examCatalogue: catalogue, mediaRoot });
const api = createOwnedApi({ datastore: port, sessions: world.sessions, settings: world.settings, accountDeletion: world.deletion });
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const reject = (promise, code) => assert.rejects(promise, e => e.code === code);
async function owner(tag) {
  const outcome = await world.sessions.signUp({ name: 'Synthetic S5 ' + tag, email: `s5-${tag}-${randomUUID()}@example.invalid`, password: 'synthetic-s5-password' });
  const cookie = String(outcome.setCookie).split(';')[0], session = await world.sessions.getSession({ cookie });
  return { id: session.userId, cookie, telc: (await port.listPreparations(session.userId))[0] };
}
async function sqlAs(ownerId, fn) {
  const client = await db.learner.connect();
  try { await client.query('BEGIN'); await client.query("SELECT set_config('hatoove.owner_id',$1,true)", [ownerId]); const result = await fn(client); await client.query('COMMIT'); return result; }
  catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
const start = async (o, examId = DTZ, mode = 'practice', overrides = {}) => (await port.startMockRun(o.id, {
  preparationId: examId === DTZ ? o.dtz.id : o.telc.id, formId: `s5.${examId}.listening.${mode}`, formVersion: 'v1',
  releaseVersion: 'v9001', eventId: randomUUID(), ...overrides })).run;
const firstRecording = run => run.members.flatMap(member => member.recordings)[0];
const event = (recording, patch = {}) => ({ eventId: randomUUID(), mediaId: recording.media_id, mediaVersion: recording.media_version,
  expectedRevision: 0, action: 'begin', ...patch });
const update = (o, run, recording, current, patch) => port.mutateMockPlayback(o.id, run.id,
  event(recording, { expectedRevision: current.revision, playbackId: current.playback_id, ...patch }));
const mediaUrl = (run, recording) => `/api/v1/mock-runs/${run.id}/media/${recording.media_id}/${recording.media_version}`;
const request = (o, url, patch = {}) => api.handle({ method: 'GET', path: url, headers: { cookie: o.cookie, 'x-hatoove-account': o.id }, ...patch });

try {
  await importHistoricalDefaultPackage(db);
  const a = await owner('a'), b = await owner('b');
  await check('forward migration leaves existing learner run bytes intact and keeps S4 functions protected', async () => {
    // Inspect the pre-upgrade release relation through its historical SQL contract.
    const form = await sqlAs(a.id, async c => (await c.query('SELECT f.form_id,f.form_version AS version,f.release_version FROM exam_release_form f JOIN exam_release_head h USING(exam_id,release_version) WHERE f.exam_id=$1 ORDER BY f.form_id LIMIT 1',[TELC])).rows[0]);
    // The latest adapter requires the latest schema. Create the historical run using its old SQL grant.
    const old = await sqlAs(a.id, async c => (await c.query(`INSERT INTO mock_run
      (id,owner_id,preparation_id,exam_id,release_version,blueprint_version,form_id,form_version,start_event_id,title,scope,mode)
      SELECT $1,$2,$3,f.exam_id,$4,f.blueprint_version,f.form_id,f.version,$5,f.payload->>'title',f.payload->>'scope',f.payload->>'mode'
      FROM exam_form f WHERE f.exam_id=$6 AND f.form_id=$7 AND f.version=$8 RETURNING *`,
      [randomUUID(),a.id,a.telc.id,form.release_version,randomUUID(),TELC,form.form_id,form.version])).rows[0]);
    const before = (await db.admin.query('SELECT * FROM mock_run WHERE id=$1', [old.id])).rows[0];
    await assertHistoricalProjectionAbsent(db);
    assert.deepEqual(await db.applyRemaining(), ['0029-fixed-media.sql','0030-listening-playback.sql','0031-assigned-mock-writing.sql','0032-ordered-mock-time-groups.sql','0033-content-rights-fence.sql','0034-complete-dtz-admission.sql','0035-content-review.sql','0036-content-review-consumers.sql']);
    assert.deepEqual((await db.admin.query('SELECT * FROM mock_run WHERE id=$1', [old.id])).rows[0], before);
    assert.equal((await port.finaliseMockRun(a.id, old.id, { expectedRevision: old.revision, eventId: randomUUID() })).result.total, 20);
    const f = (await db.admin.query("SELECT proname,prosecdef,proconfig FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname IN ('protect_mock_run','finalise_mock_run','protect_listening_playback')")).rows;
    assert.equal(f.length, 3); assert.ok(f.every(row => row.prosecdef && row.proconfig.some(value => value.startsWith('search_path='))));
    assert.equal((await db.admin.query("SELECT has_function_privilege('public','finalise_mock_run(uuid,integer)','EXECUTE') AS allowed")).rows[0].allowed, false);
  });
  const dtz = await createListeningFixture({ examId: DTZ, mediaRoot, durationMs: 30000 });
  const telc = await createListeningFixture({ examId: TELC, mediaRoot, durationMs: 30000 });
  await importPackage(db.migration, dtz, { mediaRoot }); await importPackage(db.migration, telc, { mediaRoot });
  a.dtz = (await port.createPreparation(a.id, DTZ)).preparation; b.dtz = (await port.createPreparation(b.id, DTZ)).preparation;
  let run = await start(a), recording = firstRecording(run), current;

  await check('run DTO pins 20 questions, attempt mode and public recording metadata without private fields', async () => {
    assert.equal(run.attempt_mode, 'practice'); assert.equal(run.mode, 'untimed');
    assert.deepEqual(run.members.map(member => member.item_count), [4,5,8,3]);
    assert.equal(run.members.flatMap(member => member.recordings).length, 16);
    assert.ok(!JSON.stringify(run).includes('content/exams/')); assert.ok(!JSON.stringify(run).includes('sha256'));
    assert.ok(!JSON.stringify(run).includes('content_version_id')); assert.ok(!JSON.stringify(run).includes('correct_answer'));
    assert.equal((await start(a, DTZ, 'mock')).attempt_mode, 'mock');
    const ready = await port.readMockPlayback(a.id, run.id); assert.equal(ready.length, 16);
    assert.ok(ready.every(item => item.state === 'ready' && item.plays_used === 0 && item.revision === 0 && item.playback_id === null));
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM listening_playback')).rows[0].n, 0);
  });
  await check('full/range/HEAD bytes require owned exact run/version and do not consume', async () => {
    const url = mediaUrl(run, recording), metadata = dtz.media[0];
    const full = await request(a, url); assert.equal(full.status, 200); assert.equal(full.body.length, metadata.byteLength);
    assert.equal(full.headers.etag, `"sha256-${metadata.sha256}"`); assert.equal(full.headers['cache-control'], 'private, no-store');
    const partial = await request(a, url, { headers: { cookie: a.cookie, 'x-hatoove-account': a.id, range: 'bytes=10-19' } });
    assert.equal(partial.status, 206); assert.deepEqual(partial.body, full.body.subarray(10,20));
    const head = await request(a, url, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    assert.equal(head.headers['content-length'], String(metadata.byteLength));
    assert.equal((await request(b, url)).status, 404);
    assert.equal((await request(a, url.replace(/v1$/, 'v2'))).status, 404);
    assert.equal((await request(a, url, { headers: { cookie: a.cookie, 'x-hatoove-account': b.id } })).status, 409);
    assert.equal((await api.handle({ method: 'GET', path: url })).status, 401);
    await reject(port.readMockPlayback(b.id, run.id), 'not_found');
    assert.equal((await port.readMockPlayback(a.id, run.id))[0].plays_used, 0);
  });
  await check('missing/corrupt media refuses GET/HEAD/begin without consuming allowance', async () => {
    const file = path.join(mediaRoot, ...dtz.media[0].path.slice('content/exams/'.length).split('/'));
    const original = await readFile(file);
    await rename(file, file + '.missing');
    try {
      assert.equal(JSON.parse((await request(a, mediaUrl(run, recording))).body).error, 'media_unavailable');
      await reject(port.mutateMockPlayback(a.id, run.id, event(recording)), 'media_unavailable');
    } finally { await rename(file + '.missing', file); }
    const changed = Buffer.from(original); changed[100] ^= 1; await writeFile(file, changed);
    try {
      assert.equal(JSON.parse((await request(a, mediaUrl(run, recording), { method: 'HEAD' })).body).error, 'media_integrity');
      await reject(port.mutateMockPlayback(a.id, run.id, event(recording)), 'media_integrity');
    } finally { await writeFile(file, original); }
    assert.equal((await port.readMockPlayback(a.id, run.id))[0].plays_used, 0);
  });
  let beginBody;
  await check('concurrent begins debit once and exact receipt retry returns safe current state', async () => {
    beginBody = event(recording);
    const attempts = await Promise.allSettled([port.mutateMockPlayback(a.id, run.id, beginBody), port.mutateMockPlayback(a.id, run.id, event(recording))]);
    assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1,
      attempts.filter(result => result.status === 'rejected').map(result => result.reason.stack).join('\n'));
    assert.equal(attempts.find(result => result.status === 'rejected').reason.code, 'playback_conflict');
    // Whichever request won is used for the receipt assertions below.
    if (attempts[0].status !== 'fulfilled') {
      const stored = (await db.admin.query('SELECT event_id FROM listening_playback_event WHERE run_id=$1', [run.id])).rows[0];
      beginBody = { ...beginBody, eventId: stored.event_id };
    }
    current = (await port.readMockPlayback(a.id, run.id))[0];
    assert.equal(current.plays_used, 1); assert.equal(current.uncertain, true);
    const retry = await port.mutateMockPlayback(a.id, run.id, beginBody);
    assert.equal(retry.revision, current.revision); assert.equal(retry.plays_used, 1); assert.equal(retry.uncertain, true);
    await reject(port.mutateMockPlayback(a.id, run.id, { ...beginBody, expectedRevision: 1 }), 'playback_conflict');
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM listening_playback_event WHERE run_id=$1', [run.id])).rows[0].n, 1);
  });
  await check('response autosave and audio checkpoints use independent revisions', async () => {
    const response = { setId: dtz.sets[0].setId, version: 'v1', itemId: '1', answer: dtz.sets[0].answers['1'] };
    const [saved, checkpoint] = await Promise.all([
      port.saveMockRun(a.id, run.id, { expectedRevision: run.revision, eventId: randomUUID(), responses: [response], position: { member: 0, item: 0 } }),
      update(a, run, recording, current, { action: 'checkpoint', positionMs: 1000 }),
    ]);
    run = saved; current = checkpoint; assert.equal(run.revision, 2); assert.equal(current.revision, 2);
    assert.equal((await port.readMockRun(a.id, run.id)).responses[0].answer, response.answer);
    assert.equal((await port.readMockPlayback(a.id, run.id))[0].plays_used, 1);
  });
  await check('stale revision/UUID, backward/oversized positions and early complete leave progress unchanged', async () => {
    const before = (await db.admin.query('SELECT * FROM listening_playback WHERE run_id=$1', [run.id])).rows[0];
    await reject(update(a, run, recording, { ...current, revision: 1 }, { action: 'pause', positionMs: 1000 }), 'playback_conflict');
    await reject(update(a, run, recording, { ...current, playback_id: randomUUID() }, { action: 'pause', positionMs: 1000 }), 'playback_conflict');
    for (const positionMs of [999,30001]) await reject(update(a, run, recording, current, { action: 'checkpoint', positionMs }), 'invalid_playback_position');
    await reject(update(a, run, recording, current, { action: 'complete', positionMs: 1000 }), 'invalid_playback_position');
    assert.deepEqual((await db.admin.query('SELECT * FROM listening_playback WHERE run_id=$1', [run.id])).rows[0], before);
  });
  await check('reload/device recovery rotates UUID, preserves consumed count and fences the old document', async () => {
    const old = current, returned = (await port.readMockPlayback(a.id, run.id))[0];
    assert.equal(returned.uncertain, true); assert.ok(returned.position_ms >= 1000);
    current = await update(a, run, recording, current, { action: 'recover' });
    assert.equal(current.plays_used, 1); assert.ok(current.position_ms >= returned.position_ms);
    assert.notEqual(current.playback_id, old.playback_id); assert.equal(current.uncertain, false);
    const oldReceipt = await port.mutateMockPlayback(a.id, run.id, beginBody);
    assert.equal(oldReceipt.playback_id, current.playback_id); assert.equal(oldReceipt.revision, current.revision);
    assert.equal(oldReceipt.plays_used, 1); assert.equal(oldReceipt.uncertain, true);
    await reject(update(a, run, recording, { ...current, playback_id: old.playback_id }, { action: 'pause', positionMs: current.position_ms }), 'playback_conflict');
  });
  await check('paused return stays fixed and explicit recovery resumes the same play', async () => {
    current = await update(a, run, recording, current, { action: 'pause', positionMs: current.position_ms });
    const returned = (await port.readMockPlayback(a.id, run.id))[0];
    assert.equal(returned.state, 'paused'); assert.equal(returned.uncertain, false); assert.equal(returned.position_ms, current.position_ms);
    await reject(port.mutateMockPlayback(a.id, run.id, event(recording, { expectedRevision: current.revision })), 'playback_recovery_required');
    const pausedPosition = current.position_ms;
    current = await update(a, run, recording, current, { action: 'recover' });
    assert.equal(current.position_ms, pausedPosition); assert.equal(current.plays_used, 1);
  });
  await check('DTZ completion cannot replay; telc second play remains bounded across returns', async () => {
    current = await update(a, run, recording, current, { action: 'complete', positionMs: 30000 });
    await reject(port.mutateMockPlayback(a.id, run.id, event(recording, { expectedRevision: current.revision })), 'playback_exhausted');
    const telcRun = await start(a, TELC), telcRecording = telcRun.members[1].recordings[0];
    assert.equal(telcRecording.max_plays, 2);
    let state = await port.mutateMockPlayback(a.id, telcRun.id, event(telcRecording));
    state = await update(a, telcRun, telcRecording, state, { action: 'complete', positionMs: 30000 });
    state = await port.mutateMockPlayback(a.id, telcRun.id, event(telcRecording, { expectedRevision: state.revision }));
    assert.equal(state.plays_used, 2); assert.equal(state.position_ms, 0);
    state = await update(a, telcRun, telcRecording, state, { action: 'complete', positionMs: 30000 });
    await reject(port.mutateMockPlayback(a.id, telcRun.id, event(telcRecording, { expectedRevision: state.revision })), 'playback_exhausted');
  });
  await check('restricted SQL cannot read another owner, reset progress, raise allowance or delete receipts', async () => {
    assert.equal((await sqlAs(b.id, c => c.query('SELECT * FROM listening_playback WHERE run_id=$1', [run.id]))).rowCount, 0);
    for (const sql of ['UPDATE listening_playback SET max_plays=99 WHERE run_id=$1', 'DELETE FROM listening_playback_event WHERE run_id=$1', 'DELETE FROM listening_playback WHERE run_id=$1'])
      await assert.rejects(sqlAs(a.id, c => c.query(sql, [run.id])), error => error.code === '42501');
    await assert.rejects(sqlAs(a.id, c => c.query("UPDATE listening_playback SET revision=revision+1,position_ms=0,state='playing',plays_used=1 WHERE run_id=$1", [run.id])), /playback_exhausted/);
    await assert.rejects(db.learner.query('SELECT answers FROM objective_key LIMIT 1'), error => error.code === '42501');
    const tables = (await db.admin.query("SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE relnamespace=current_schema()::regnamespace AND relname IN ('listening_playback','listening_playback_event')")).rows;
    assert.equal(tables.length, 2); assert.ok(tables.every(table => table.relrowsecurity && table.relforcerowsecurity));
  });
  await check('SQL insert independently pins owner, run membership, version, allowance and duration', async () => {
    const unused = run.members[0].recordings[1];
    const insert = (ownerId, mediaId, version, maxPlays, duration) => sqlAs(ownerId, c => c.query(`INSERT INTO listening_playback
      (owner_id,run_id,exam_id,media_id,media_version,state,plays_used,max_plays,position_ms,duration_ms,playback_id)
      VALUES($1,$2,$3,$4,$5,'playing',1,$6,0,$7,$8)`, [ownerId, run.id, DTZ, mediaId, version, maxPlays, duration, randomUUID()]));
    await assert.rejects(insert(b.id, unused.media_id, 'v1', 1, 30000), /not_found/);
    await assert.rejects(insert(a.id, unused.media_id, 'v1', 2, 30000), /invalid_playback_identity/);
    await assert.rejects(insert(a.id, unused.media_id, 'v1', 1, 1), /invalid_playback_identity/);
    await assert.rejects(insert(a.id, unused.media_id, 'v2', 1, 30000), /invalid_playback_identity/);
    await assert.rejects(insert(a.id, telc.media[0].mediaId, 'v1', 1, 30000), /invalid_playback_identity/);
    assert.equal((await port.readMockPlayback(a.id, run.id)).find(row => row.media_id === unused.media_id).plays_used, 0);
  });
  await check('fixed audio saves and finalises all 20 ordered questions while preserving grouped/writing support', async () => {
    const responses = dtz.sets.flatMap(set => Object.entries(set.answers).map(([itemId, answer]) => ({ setId: set.setId, version: set.version, itemId, answer })));
    run = await port.saveMockRun(a.id, run.id, { expectedRevision: run.revision, eventId: randomUUID(), responses, position: { member: 3, item: 2 } });
    const finalised = await port.finaliseMockRun(a.id, run.id, { expectedRevision: run.revision, eventId: randomUUID() });
    assert.equal(finalised.result.total, 20); assert.equal(finalised.result.correct, 20); assert.equal(finalised.result.answered, 20);
    assert.deepEqual(finalised.result.items.map(item => item.item_id), Array.from({ length: 20 }, (_, i) => String(i + 1)));
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM item_evidence WHERE mock_run_id=$1', [run.id])).rows[0].n, 20);
    await reject(port.readMockMedia(a.id, run.id, recording.media_id, recording.media_version), 'mock_finalised');
    const beforeReplay=(await db.admin.query('SELECT * FROM listening_playback WHERE run_id=$1 ORDER BY media_id',[run.id])).rows;
    const receiptCount=(await db.admin.query('SELECT count(*)::int AS n FROM listening_playback_event WHERE run_id=$1',[run.id])).rows[0].n;
    const replay=await port.mutateMockPlayback(a.id, run.id, beginBody);
    assert.equal(replay.plays_used,1);
    await reject(port.mutateMockPlayback(a.id, run.id, {...beginBody,eventId:randomUUID()}), 'mock_finalised');
    assert.deepEqual((await db.admin.query('SELECT * FROM listening_playback WHERE run_id=$1 ORDER BY media_id',[run.id])).rows,beforeReplay);
    assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM listening_playback_event WHERE run_id=$1',[run.id])).rows[0].n,receiptCount);
  });
  await check('archive/public-mode/disabled-package boundaries refuse audio and mutations without losing responses', async () => {
    const active = await start(b), rec = firstRecording(active);
    const state = await port.mutateMockPlayback(b.id, active.id, event(rec));
    await port.updatePreparation(b.id, b.dtz.id, b.dtz.revision, { state: 'archived' });
    await reject(port.readMockMedia(b.id, active.id, rec.media_id, rec.media_version), 'preparation_archived');
    await reject(update(b, active, rec, state, { action: 'recover' }), 'preparation_archived');
    b.dtz = await port.readPreparation(b.id, b.dtz.id);
    b.dtz = await port.updatePreparation(b.id, b.dtz.id, b.dtz.revision, { state: 'active' });
    process.env.B1PREP_CONTENT_MODE = 'public';
    try { await reject(port.readMockMedia(b.id, active.id, rec.media_id, rec.media_version), 'mock_content_unavailable'); }
    finally { process.env.B1PREP_CONTENT_MODE = 'internal-preview'; }
    const disabled = createPostgresDatastore({ pool: db.learner, mediaRoot });
    await reject(disabled.readMockMedia(b.id, active.id, rec.media_id, rec.media_version), 'exam_unavailable');
  });
  await check('export keeps learner audio progress without playback UUIDs or receipt transport data', async () => {
    const exported = await port.exportData(a.id);
    assert.ok(exported.listening_playback.length >= 2);
    assert.ok(exported.listening_playback.every(row => !Object.hasOwn(row, 'playback_id') && !Object.hasOwn(row, 'owner_id')));
    assert.ok(!Object.hasOwn(exported, 'listening_playback_event'));
    assert.ok(exported.listening_playback.some(row => row.run_id === run.id && row.plays_used === 1));
  });
  await check('conservative recovery at the duration closes the consumed play without an extra allowance', async () => {
    const active = await start(b), rec = firstRecording(active);
    let state = await port.mutateMockPlayback(b.id, active.id, event(rec));
    state = await update(b, active, rec, state, { action: 'checkpoint', positionMs: rec.duration_ms });
    const returned = (await port.readMockPlayback(b.id, active.id))[0];
    assert.equal(returned.position_ms, rec.duration_ms); assert.equal(returned.uncertain, true);
    state = await update(b, active, rec, state, { action: 'recover' });
    assert.equal(state.state, 'completed'); assert.equal(state.plays_used, 1);
  });
  await check('deadline expiry refuses new bytes and progress while retaining saved state', async () => {
    const timed = structuredClone(telc);
    timed.release.version = 'v9010';
    timed.forms = [{ ...timed.forms[1], id: 's5.deadline-fixture', timeLimitSeconds: 1 }];
    await importPackage(db.migration, timed, { mediaRoot });
    const active = await start(b, TELC, 'mock', { formId: 's5.deadline-fixture', releaseVersion: 'v9010' });
    const rec = firstRecording(active), state = await port.mutateMockPlayback(b.id, active.id, event(rec));
    await new Promise(resolve => setTimeout(resolve, 1100));
    await reject(port.readMockMedia(b.id, active.id, rec.media_id, rec.media_version), 'mock_expired');
    await reject(update(b, active, rec, state, { action: 'recover' }), 'mock_expired');
    assert.equal((await port.readMockRun(b.id, active.id)).expired, true);
    assert.equal((await db.admin.query('SELECT plays_used FROM listening_playback WHERE run_id=$1', [active.id])).rows[0].plays_used, 1);
  });
  await check('exceptional rights withdrawal blocks existing audio/events while retaining saved learner answers', async () => {
    const active = await start(b), rec = firstRecording(active);
    const state = await port.mutateMockPlayback(b.id, active.id, event(rec));
    const blocked = structuredClone(dtz); blocked.release = { version: 'v9002', state: 'withdrawn', resumeBlockedReleases: ['v9001'] };
    await importPackage(db.migration, blocked, { mediaRoot });
    await reject(port.readMockMedia(b.id, active.id, rec.media_id, rec.media_version), 'mock_rights_blocked');
    await reject(update(b, active, rec, state, { action: 'recover' }), 'mock_rights_blocked');
    const protectedRun = await port.readMockRun(a.id, run.id); assert.equal(protectedRun.result, null); assert.equal(protectedRun.responses.length, 20); assert.equal(protectedRun.members.length, 0);
    await assert.rejects(sqlAs(b.id, c => c.query('UPDATE listening_playback SET revision=revision+1 WHERE run_id=$1', [active.id])), /mock_rights_blocked/);
  });
  await check('account deletion removes playback/events before runs and refuses late resurrection', async () => {
    assert.equal((await world.deletion.deleteAccount(a.id)).verifiedAbsent, true);
    for (const table of ['listening_playback_event','listening_playback','mock_run'])
      assert.equal((await db.admin.query(`SELECT 1 FROM ${table} WHERE owner_id=$1`, [a.id])).rowCount, 0);
    await reject(port.readMockPlayback(a.id, run.id), 'not_found');
    await reject(port.mutateMockPlayback(a.id, run.id, beginBody), 'not_found');
  });
  console.log(`EXAM-S5 media PostgreSQL: ${passed} checks passed.`);
} finally {
  await world.teardown();
  await rm(mediaRoot, { recursive: true, force: true });
}
