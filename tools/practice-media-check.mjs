#!/usr/bin/env node
/**
 * PRACTICE-MEDIA (task-17) — the practice-bound listening playback path, proved against a disposable database.
 *
 *   node tools/practice-media-check.mjs            the legs, plus the built-in mutation proof
 *   node tools/practice-media-check.mjs --list      leg names only
 *
 * DISPOSABLE DATABASE ONLY, and only by explicit opt-in: `OWNAPI_PG_ALLOW=1 OWNAPI_PG_HOST=127.0.0.1`. The
 * fixture is a synthetic technical signal (`tools/exam-s5-fixture.mjs`), never learner material, and the media
 * root is a temporary directory this check creates and removes.
 *
 * WHAT IT PROVES. That a play is accounted on the SERVER against a PRACTICE SITTING, with the same model the
 * mock path uses (`plays_used`/`max_plays`, acknowledged `begin`, one-way state machine, integrity-first), that
 * the allowance is the blueprint's per-family EXAM allowance, that a second listen before "Auswerten" is
 * refused by the server and not merely hidden in the client, that the practice accounting is separate from a
 * mock run's, and that a missing or corrupt file degrades honestly without debiting a play.
 */
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createFixture } from '../server/owned-postgres/bootstrap.mjs';
import { createPostgresWorld } from '../server/owned-postgres/fixture.mjs';
import { createPostgresDatastore } from '../server/owned-postgres/adapter.mjs';
import { importPackage } from '../server/owned-postgres/package-importer.mjs';
import { createOwnedApi } from '../server/owned-api.mjs';
import { practicePlaybackTransition } from '../server/owned-postgres/practice-playback.mjs';
import { normalisePracticeSet, practiceRoundState } from '../server/practice-sets.mjs';
import { createListeningFixture } from './exam-s5-fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAM = 'telc-deutsch-b1';
const LISTENING_SET = 's5.telc-deutsch-b1.hv1';
const SEEDED_SET = 'telc-deutsch-b1.hv1.01';

if (process.env.OWNAPI_PG_ALLOW !== '1' || process.env.OWNAPI_PG_HOST !== '127.0.0.1') {
  throw new Error('explicit local disposable PostgreSQL required (OWNAPI_PG_ALLOW=1, OWNAPI_PG_HOST=127.0.0.1)');
}
/* The fixture publishes UNREVIEWED, generated content; the default `public` mode serves approved only. */
const policyKeys = ['B1PREP_CONTENT_MODE', 'B1PREP_SERVE_REVIEW', 'B1PREP_SERVE_RIGHTS'];
const savedPolicy = Object.fromEntries(policyKeys.map((key) => [key, process.env[key]]));
process.env.B1PREP_CONTENT_MODE = 'internal-preview';
delete process.env.B1PREP_SERVE_REVIEW;
delete process.env.B1PREP_SERVE_RIGHTS;

/* ------------------------------------------------------------------ the two pure guards, shared by the legs and by the mutation proof */

/** The guard the "second listen before Auswerten" leg rests on: a used recording needs a CHECKED sitting. */
function expectPracticeRuleHolds(transition = practicePlaybackTransition) {
  const row = { plays_used: 1, revision: 1, state: 'completed', duration_ms: 1000, position_ms: 1000, playback_id: randomUUID() };
  const recording = { media_id: 'm', media_version: 'v1', duration_ms: 1000, max_plays: 2 };
  const body = { action: 'begin', expectedRevision: 1, mediaId: 'm', mediaVersion: 'v1', eventId: randomUUID() };
  assert.throws(() => transition(row, recording, body, new Date(), { attempt: { state: 'open' } }),
    (error) => error.code === 'practice_check_required' && error.status === 409,
    'a second play before Auswerten must be refused by the transition itself');
  const allowed = transition(row, recording, { ...body, eventId: randomUUID() }, new Date(), { attempt: { state: 'checked' } });
  assert.equal(allowed.plays_used, 2, 'after Auswerten the replay is allowed');
}

/** The guard the packaged listening-corpus leg rests on: `recordings[].questions` ARE the items. */
function expectRecordingsShapeServed(normalise = normalisePracticeSet) {
  const served = normalise({
    set_id: 's5.telc-deutsch-b1.hv1', version: 'v1', family: 'HV1', section: 'HV', part: '1', item_count: 2,
    payload: { recordings: [
      { id: 'rec-1', mediaId: 's5.m1', mediaVersion: 'v1', label: 'Signal', questions: [{ n: 1, question: 'A?', options: { a: 'A', b: 'B' } }] },
      { id: 'rec-2', mediaId: 's5.m2', mediaVersion: 'v1', label: 'Signal', questions: [{ n: 2, question: 'B?', options: { a: 'A', b: 'B' } }] },
    ] },
  });
  assert.deepEqual(served.items.map((item) => item.item_id), ['1', '2'], 'the key is the question number');
  assert.equal(served.items[0].prompt, 'A?');
  assert.equal(served.items[0].answer_kind, 'choice');
  assert.equal(served.material.recordings.length, 2, 'the audio each question belongs to is served as material');
}

/* ------------------------------------------------------------------ harness */

const legNames = [];
const failures = [];
const notes = [];
const leg = async (name, run) => {
  legNames.push(name);
  try { notes.push([name, await run()]); console.log(`PASS ${name}${notes.at(-1)[1] ? `  [${notes.at(-1)[1]}]` : ''}`); }
  catch (error) { failures.push(`${name}: ${String(error.message).split('\n')[0]}`); console.log(`FAIL ${name}: ${String(error.message).split('\n')[0]}`); }
};

const mediaRoot = await mkdtemp(path.join(tmpdir(), 'hatoove-practice-media-'));
const db = await createFixture();
let world = null;
let port = null;
let api = null;
const passed = () => failures.length === 0;

const asOwner = async (ownerId, work) => {
  const client = await db.learner.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [ownerId]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
};

try {
  world = await createPostgresWorld({ fixture: db });
  port = createPostgresDatastore({ pool: db.learner, mediaRoot });
  api = createOwnedApi({ datastore: port, sessions: world.sessions, settings: world.settings, accountDeletion: world.deletion });

  const pkg = await createListeningFixture({ examId: EXAM, mediaRoot, durationMs: 30000 });
  await importPackage(db.migration, pkg, { mediaRoot });

  const who = async (tag) => {
    const outcome = await world.sessions.signUp({
      name: `Practice media ${tag}`, email: `practice-media-${tag}-${randomUUID()}@example.invalid`,
      password: 'synthetic-practice-media-password',
    });
    const cookie = String(outcome.setCookie).split(';')[0];
    const userId = (await world.sessions.getSession({ cookie })).userId;
    const preparation = (await port.listPreparations(userId)).find((row) => row.exam_id === EXAM && row.state === 'active');
    return { id: userId, cookie, preparationId: preparation.id };
  };
  const owner = await who('owner');
  const other = await who('other');

  const call = async (account, method, url, body) => {
    const response = await api.handle({
      method, path: url, originChecked: true,
      headers: { cookie: account.cookie, 'x-hatoove-account': account.id, accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    let json = null;
    try { json = JSON.parse(response.body); } catch { /* byte responses are not JSON */ }
    return { status: response.status, headers: response.headers, json, body: response.body };
  };
  const playbackUrl = (attemptId) => `/api/v1/practice/attempts/${attemptId}/playback`;
  const mediaUrl = (attemptId, mediaId, version) => `/api/v1/practice/attempts/${attemptId}/media/${mediaId}/${version}`;
  const begin = (recording, patch = {}) => ({
    eventId: randomUUID(), mediaId: recording.media_id, mediaVersion: recording.media_version,
    expectedRevision: 0, action: 'begin', ...patch,
  });
  const complete = (recording, current) => ({
    eventId: randomUUID(), mediaId: recording.media_id, mediaVersion: recording.media_version,
    expectedRevision: current.revision, playbackId: current.playback_id, action: 'complete',
    positionMs: current.duration_ms,
  });
  /** An attempt on a set, opened the way the adapter opens one (the fixture owns the sitting's identity). */
  const craftAttempt = async (account, setId, version = 'v1') => {
    const attemptId = randomUUID();
    await asOwner(account.id, async (client) => {
      const set = (await client.query(
        'SELECT family, section, item_count FROM objective_set WHERE set_id=$1 AND version=$2 AND exam_id=$3',
        [setId, version, EXAM])).rows[0];
      assert.ok(set, `the fixture has no set ${setId}`);
      await client.query(
        `INSERT INTO practice_attempt (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [attemptId, account.id, EXAM, account.preparationId, setId, version, set.family, set.section, set.item_count]);
    });
    return attemptId;
  };
  const keysFor = async (setId, version = 'v1') => (await db.admin.query(
    'SELECT answers FROM objective_key WHERE set_id=$1 AND version=$2', [setId, version])).rows[0].answers;
  /**
   * The IMPORTED file's own metadata. The playback DTO deliberately carries no filesystem path, checksum or
   * byte length (it is the mock path's own DTO), so the integrity legs read `exam_media` — the fixture's
   * knowledge of where the bytes are, exactly as the s5 media check does.
   */
  const mediaRow = async (mediaId, version) => (await db.admin.query(
    'SELECT path, sha256, byte_length, duration_ms FROM exam_media WHERE exam_id=$1 AND media_id=$2 AND version=$3',
    [EXAM, mediaId, version])).rows[0];
  const fileOf = (media) => path.join(mediaRoot, ...media.path.slice('content/exams/'.length).split('/'));

  /* ---------------------------------------------------------------- pure guards (offline) */
  await leg('M1 pure: a used recording needs a CHECKED sitting, so a second listen before Auswerten is refused', expectPracticeRuleHolds);
  await leg('M2 pure: a packaged fixed_audio set keeps its questions inside recordings[]', expectRecordingsShapeServed);

  /* ---------------------------------------------------------------- the served sitting and its audio */
  const served = await port.practiceSetForPart(owner.id, { preparationId: owner.preparationId, family: 'HV1' });
  const servedHv3 = await port.practiceSetForPart(owner.id, { preparationId: owner.preparationId, family: 'HV3' });
  let hv1State = null;

  await leg('M3 the serving path hands over the authored set WITH its audio and the exam allowance', async () => {
    assert.ok(served, 'HV1 must serve a set');
    assert.equal(served.set.set_id, LISTENING_SET, 'the imported listening set is the one carrying audio');
    assert.equal(served.set.items.length, 5);
    assert.deepEqual(served.set.items.map((item) => item.item_id), ['1', '2', '3', '4', '5']);
    assert.equal(served.set.material.recordings.length, 5, 'each question is bound to its recording');
    assert.equal(served.attempt.state, 'open');
    hv1State = await port.readPracticePlayback(owner.id, served.attempt.attempt_id);
    assert.equal(hv1State.items.length, 5);
    assert.ok(hv1State.items.every((item) => item.state === 'ready' && item.plays_used === 0
      && item.max_plays === 1 && item.playback_id === null), 'HV1 is heard once in the exam, and nothing is used yet');
    assert.deepEqual(hv1State.sitting,
      { attempt_id: served.attempt.attempt_id, state: 'open', checked: false, plays_used: 0, replay_used: false });
    return `${LISTENING_SET}: 5 items, 5 recordings, max_plays 1`;
  });

  await leg('M4 the allowance is the BLUEPRINT rule per family (HV3 is heard twice, HV1 once)', async () => {
    assert.ok(servedHv3, 'HV3 must serve a set');
    assert.equal(servedHv3.set.set_id, 's5.telc-deutsch-b1.hv3');
    const state = await port.readPracticePlayback(owner.id, servedHv3.attempt.attempt_id);
    assert.ok(state.items.length > 0);
    assert.ok(state.items.every((item) => item.max_plays === 2), 'HV3 is played twice each');
    assert.ok(hv1State.items.every((item) => item.max_plays === 1), 'HV1 is played once');
    return `HV3 max_plays ${state.items[0].max_plays}, HV1 max_plays ${hv1State.items[0].max_plays}`;
  });

  /* ---------------------------------------------------------------- the rule, over HTTP */
  const hv3Recording = (await port.readPracticePlayback(owner.id, servedHv3.attempt.attempt_id)).items[0];
  let hv3Current = null;

  await leg('M5 the server refuses a SECOND listen before Auswerten (over HTTP)', async () => {
    const first = await call(owner, 'POST', playbackUrl(servedHv3.attempt.attempt_id), begin(hv3Recording));
    assert.equal(first.status, 200, first.body);
    assert.equal(first.json.playback.plays_used, 1);
    assert.equal(first.json.playback.state, 'playing');
    hv3Current = first.json.playback;
    const ended = await call(owner, 'POST', playbackUrl(servedHv3.attempt.attempt_id), complete(hv3Recording, hv3Current));
    assert.equal(ended.status, 200, ended.body);
    hv3Current = ended.json.playback;
    assert.equal(hv3Current.state, 'completed');
    // The allowance would still permit a play (2), so ONLY the practice rule can refuse this one.
    const second = await call(owner, 'POST', playbackUrl(servedHv3.attempt.attempt_id), begin(hv3Recording, { expectedRevision: hv3Current.revision }));
    assert.equal(second.status, 409, `a second listen before Auswerten must be 409, got ${second.status} ${second.body}`);
    assert.equal(second.json.error, 'practice_check_required');
    const sitting = await db.admin.query('SELECT plays_used FROM practice_attempt WHERE attempt_id=$1', [servedHv3.attempt.attempt_id]);
    assert.equal(Number(sitting.rows[0].plays_used), 1, 'the refused play must not be counted');
    return 'first listen acknowledged, second refused with practice_check_required, plays_used stays 1';
  });

  await leg('M6 bytes are served only while a play is actually in progress', async () => {
    /*
     * A SECOND RECORDING of the same sitting, not the first: every recording has its own first play, and the
     * sitting is still open, so this is the only way to hold a legitimate play in progress before Auswerten.
     */
    const recording = (await port.readPracticePlayback(owner.id, servedHv3.attempt.attempt_id)).items[1];
    const media = await mediaRow(recording.media_id, recording.media_version);
    const before = await call(owner, 'GET', mediaUrl(servedHv3.attempt.attempt_id, recording.media_id, recording.media_version));
    assert.equal(before.status, 409, 'audio bytes require an acknowledged play');
    assert.equal(before.json.error, 'playback_required');
    const playing = await call(owner, 'POST', playbackUrl(servedHv3.attempt.attempt_id), begin(recording));
    assert.equal(playing.status, 200, playing.body);
    const bytes = await call(owner, 'GET', mediaUrl(servedHv3.attempt.attempt_id, recording.media_id, recording.media_version));
    assert.equal(bytes.status, 200, bytes.body);
    assert.equal(bytes.headers.etag, `"sha256-${media.sha256}"`);
    assert.equal(bytes.body.length, media.byte_length);
    const head = await call(owner, 'HEAD', mediaUrl(servedHv3.attempt.attempt_id, recording.media_id, recording.media_version));
    assert.equal(head.status, 200);
    assert.equal(head.body.length, 0);
    return `${bytes.body.length} bytes with the imported etag; HEAD carries none`;
  });

  /* ---------------------------------------------------------------- after Auswerten */
  await leg('M7 after Auswerten the replay is allowed, and then the allowance is genuinely spent', async () => {
    const keys = await keysFor(servedHv3.set.set_id);
    const checked = await port.checkPracticeAttempt(owner.id, {
      preparationId: owner.preparationId, attemptId: servedHv3.attempt.attempt_id,
      answers: servedHv3.set.items.map((item) => ({ item_id: item.item_id, answer: keys[item.item_id] })),
    });
    assert.equal(checked.state, 'checked');
    // The replay of the FIRST recording, whose one play was completed before Auswerten.
    const replay = await call(owner, 'POST', playbackUrl(servedHv3.attempt.attempt_id), begin(hv3Recording, { expectedRevision: hv3Current.revision }));
    assert.equal(replay.status, 200, `the replay after Auswerten must be allowed, got ${replay.status} ${replay.body}`);
    assert.equal(replay.json.playback.plays_used, 2, 'the replay is the second play');
    const ended = await call(owner, 'POST', playbackUrl(servedHv3.attempt.attempt_id), complete(hv3Recording, replay.json.playback));
    assert.equal(ended.status, 200, ended.body);
    const third = await call(owner, 'POST', playbackUrl(servedHv3.attempt.attempt_id), begin(hv3Recording, { expectedRevision: ended.json.playback.revision }));
    assert.equal(third.status, 409, 'the exam allowance ends at two');
    assert.equal(third.json.error, 'playback_exhausted');
    const sitting = (await db.admin.query(
      'SELECT plays_used, replay_used FROM practice_attempt WHERE attempt_id=$1', [servedHv3.attempt.attempt_id])).rows[0];
    assert.equal(Number(sitting.plays_used), 3, 'three plays total: two of the first recording, one of the second');
    assert.equal(sitting.replay_used, true, 'the sitting records that a replay is spent');
    return 'replay after Auswerten allowed (plays_used 2 for that recording), third play playback_exhausted';
  });

  /* ---------------------------------------------------------------- separation from the mock path */
  await leg('M8 the practice accounting is SEPARATE from a mock run (two tables, two allowances)', async () => {
    const run = (await port.startMockRun(owner.id, {
      preparationId: owner.preparationId, formId: 's5.telc-deutsch-b1.listening.mock', formVersion: 'v1',
      releaseVersion: 'v9001', eventId: randomUUID(),
    })).run;
    const mockRecording = run.members.flatMap((member) => member.recordings)[0];
    const mockBegin = await port.mutateMockPlayback(owner.id, run.id, {
      eventId: randomUUID(), mediaId: mockRecording.media_id, mediaVersion: mockRecording.media_version,
      expectedRevision: 0, action: 'begin',
    });
    assert.equal(mockBegin.plays_used, 1);
    const counts = async () => (await db.admin.query(`SELECT
        (SELECT count(*)::int FROM listening_playback WHERE owner_id=$1) AS mock_rows,
        (SELECT count(*)::int FROM listening_playback WHERE owner_id=$1 AND run_id=$2) AS run_rows,
        (SELECT count(*)::int FROM practice_playback WHERE owner_id=$1) AS practice_rows,
        (SELECT count(*)::int FROM practice_playback WHERE owner_id=$1 AND attempt_id=$3) AS attempt_rows`,
      [owner.id, run.id, served.attempt.attempt_id])).rows[0];
    const before = await counts();
    // A practice play on ANOTHER recording of another sitting must not move the mock run at all.
    const otherRecording = (await port.readPracticePlayback(owner.id, served.attempt.attempt_id)).items[1];
    const practiceBegin = await port.mutatePracticePlayback(owner.id, served.attempt.attempt_id, begin(otherRecording));
    assert.equal(practiceBegin.plays_used, 1);
    const after = await counts();
    assert.equal(after.mock_rows, before.mock_rows, 'a practice play must not add a mock playback row');
    assert.equal(after.run_rows, before.run_rows, 'nor touch the mock run’s own rows');
    assert.equal(after.practice_rows, before.practice_rows + 1, 'it accounts in practice_playback');
    assert.equal(after.attempt_rows, before.attempt_rows + 1, 'against the SITTING that was served, not the other one');
    // ...and the mock play is nowhere in the practice table.
    const crossed = (await db.admin.query(
      `SELECT (SELECT count(*)::int FROM practice_playback WHERE owner_id=$1 AND media_id=$2) AS practice_for_mock_media,
              (SELECT count(*)::int FROM listening_playback WHERE owner_id=$1 AND media_id=$3) AS mock_for_practice_media`,
      [owner.id, mockRecording.media_id, otherRecording.media_id])).rows[0];
    assert.equal(crossed.practice_for_mock_media, 0);
    assert.equal(crossed.mock_for_practice_media, 0);
    const mockRow = (await db.admin.query(
      'SELECT plays_used FROM listening_playback WHERE owner_id=$1 AND run_id=$2 AND media_id=$3',
      [owner.id, run.id, mockRecording.media_id])).rows[0];
    assert.equal(Number(mockRow.plays_used), 1, 'the mock allowance is untouched by practice plays');
    return `listening_playback ${after.mock_rows} row(s) for the run, practice_playback ${after.practice_rows} for the sittings`;
  });

  /* ---------------------------------------------------------------- integrity-first */
  await leg('M9 a MISSING file refuses the play, debits nothing and degrades honestly', async () => {
    const attemptId = await craftAttempt(owner, LISTENING_SET);
    const recording = (await port.readPracticePlayback(owner.id, attemptId)).items[0];
    const media = await mediaRow(recording.media_id, recording.media_version);
    const file = fileOf(media);
    await rename(file, `${file}.missing`);
    try {
      const response = await call(owner, 'POST', playbackUrl(attemptId), begin(recording));
      assert.equal(response.status, 409, `a missing file must not play, got ${response.status} ${response.body}`);
      assert.equal(response.json.error, 'media_unavailable', 'an honest refusal, never a silent success');
      const rows = (await db.admin.query('SELECT count(*)::int AS n FROM practice_playback WHERE attempt_id=$1', [attemptId])).rows[0].n;
      assert.equal(rows, 0, 'a resource that never played must not be recorded as played');
      const bytes = await call(owner, 'GET', mediaUrl(attemptId, recording.media_id, recording.media_version));
      assert.equal(bytes.status, 409);
    } finally { await rename(`${file}.missing`, file); }
    return 'media_unavailable, no practice_playback row, no play debited';
  });

  await leg('M10 a CORRUPT file is an integrity failure, not a silent success', async () => {
    const attemptId = await craftAttempt(owner, LISTENING_SET);
    const recording = (await port.readPracticePlayback(owner.id, attemptId)).items[0];
    const media = await mediaRow(recording.media_id, recording.media_version);
    const file = fileOf(media);
    const original = await readFile(file);
    const changed = Buffer.from(original);
    changed[100] ^= 1;
    await writeFile(file, changed);
    try {
      const response = await call(owner, 'POST', playbackUrl(attemptId), begin(recording));
      assert.equal(response.status, 409, `corrupt bytes must not play, got ${response.status} ${response.body}`);
      assert.equal(response.json.error, 'media_integrity');
      assert.equal((await db.admin.query('SELECT count(*)::int AS n FROM practice_playback WHERE attempt_id=$1', [attemptId])).rows[0].n, 0);
    } finally { await writeFile(file, original); }
    return 'media_integrity, no play debited';
  });

  /* ---------------------------------------------------------------- the SQL guard, without the JS layer */
  await leg('M11 the SQL TRIGGER refuses what the JS layer never sees (allowance and the pre-Auswerten rule)', async () => {
    // HV3: its exam allowance is 2, so a second play is refused by the PRACTICE rule and not by exhaustion.
    const attemptId = await craftAttempt(owner, 's5.telc-deutsch-b1.hv3');
    const recordings = (await port.readPracticePlayback(owner.id, attemptId)).items;
    await assert.rejects(
      asOwner(owner.id, (client) => client.query(
        `INSERT INTO practice_playback
           (owner_id,attempt_id,exam_id,media_id,media_version,state,plays_used,max_plays,position_ms,duration_ms,playback_id)
         VALUES ($1,$2,$3,$4,$5,'playing',1,9,0,$6,$7)`,
        [owner.id, attemptId, EXAM, recordings[1].media_id, recordings[1].media_version, recordings[1].duration_ms, randomUUID()])),
      /invalid_playback_identity/, 'a caller cannot widen its own allowance');
    const opened = await port.mutatePracticePlayback(owner.id, attemptId, begin(recordings[0]));
    const ended = await port.mutatePracticePlayback(owner.id, attemptId, complete(recordings[0], opened));
    assert.equal(ended.state, 'completed');
    await assert.rejects(
      asOwner(owner.id, (client) => client.query(
        `UPDATE practice_playback SET state='playing', plays_used=plays_used+1, position_ms=0, playback_id=$4, revision=revision+1
          WHERE owner_id=$1 AND attempt_id=$2 AND media_id=$3`,
        [owner.id, attemptId, recordings[0].media_id, randomUUID()])),
      /practice_check_required/, 'raw SQL cannot replay before Auswerten');
    return 'invalid_playback_identity for a widened max_plays; practice_check_required for a raw replay';
  });

  await leg('M12 the same event id is applied ONCE and returns the stored state', async () => {
    const attemptId = await craftAttempt(owner, LISTENING_SET);
    const recording = (await port.readPracticePlayback(owner.id, attemptId)).items[0];
    const event = begin(recording);
    const once = await port.mutatePracticePlayback(owner.id, attemptId, event);
    const twice = await port.mutatePracticePlayback(owner.id, attemptId, event);
    assert.equal(twice.revision, once.revision);
    assert.equal(twice.plays_used, once.plays_used);
    assert.equal(twice.playback_id, once.playback_id);
    assert.equal((await db.admin.query(
      'SELECT count(*)::int AS n FROM practice_playback_event WHERE owner_id=$1 AND attempt_id=$2', [owner.id, attemptId])).rows[0].n, 1);
    return 'one row, one play, identical DTO';
  });

  /* ---------------------------------------------------------------- honest degradation and ownership */
  await leg('M13 a served set with NO authored recordings offers no audio rather than a broken player', async () => {
    const attemptId = await craftAttempt(owner, SEEDED_SET);
    const state = await port.readPracticePlayback(owner.id, attemptId);
    assert.deepEqual(state.items, [], 'the seeded telc HV sets carry items and no recordings');
    assert.equal(state.sitting.state, 'open');
    const response = await call(owner, 'POST', playbackUrl(attemptId), {
      eventId: randomUUID(), mediaId: 'telc-deutsch-b1.hv1.01.audio', mediaVersion: 'v1', expectedRevision: 0, action: 'begin',
    });
    assert.equal(response.status, 404, 'there is no such recording in this sitting');
    assert.equal(response.json.error, 'not_found');
    return 'empty playback list, begin -> 404 not_found';
  });

  await leg('M14 another account cannot reach the sitting, its playback or its bytes', async () => {
    const state = await port.readPracticePlayback(owner.id, served.attempt.attempt_id);
    const recording = state.items[0];
    assert.equal((await call(other, 'GET', playbackUrl(served.attempt.attempt_id))).status, 404);
    assert.equal((await call(other, 'POST', playbackUrl(served.attempt.attempt_id), begin(recording))).status, 404);
    assert.equal((await call(other, 'GET', mediaUrl(served.attempt.attempt_id, recording.media_id, recording.media_version))).status, 404);
    const anonymous = await api.handle({ method: 'GET', path: playbackUrl(served.attempt.attempt_id), originChecked: true, headers: {} });
    assert.equal(anonymous.status, 401);
    assert.equal((await call(owner, 'GET', mediaUrl(served.attempt.attempt_id, 's5.nope', 'v1'))).status, 404);
    return '404 to the other account, 401 unauthenticated, 404 unknown media';
  });

  await leg('M15 the WRAP rule and the playback path agree about a three-set listening part', async () => {
    // The runner decides its fourth tap from the serving path; the playback path must not invent a fourth play.
    const round = practiceRoundState({ setCount: 3, checkedSets: 3 });
    assert.equal(round.wrapped, true);
    assert.equal(round.notice, 'practiceAllSets');
    const state = await port.readPracticePlayback(owner.id, servedHv3.attempt.attempt_id);
    assert.ok(state.items.every((item) => item.max_plays === 2), 'a wrapped part still accounts per recording');
    assert.equal(state.sitting.checked, true, 'the wrap is about checked sets, and this sitting is checked');
    return 'wrap at three checked sets; per-recording allowance unchanged';
  });
} finally {
  if (db && typeof db.cleanup === 'function') {
    try { await db.cleanup(); } catch (error) { console.log(`postgres: cleanup reported ${String(error.message).split('\n')[0]}`); }
  }
  await rm(mediaRoot, { recursive: true, force: true }).catch(() => {});
  for (const key of policyKeys) {
    if (savedPolicy[key] === undefined) delete process.env[key];
    else process.env[key] = savedPolicy[key];
  }
}

/* ------------------------------------------------------------------ mutation proof */

/**
 * Each mutation is applied to a COPY of the shipped module in a temporary tree, and the SAME assertion the leg
 * makes is re-run against it: a guard no mutation can break is not a guard. The copy is a whole `server/` tree
 * so every relative import resolves exactly as it does in place — nothing is written inside the repository.
 */
const MUTATIONS = [
  ['M1 practice-playback: the AFTER-AUSWERTEN rule removed', 'server/owned-postgres/practice-playback.mjs',
    (source) => source.replace("if (body.action === 'begin' && used > 0 && attempt?.state !== 'checked') fail(409, 'practice_check_required');", '/* M1: the practice rule removed */'),
    'practicePlaybackTransition', (transition) => expectPracticeRuleHolds(transition)],
  ['M2 practice-sets: the recordings[] shape removed', 'server/practice-sets.mjs',
    (source) => source.replace('      return recording.questions;', '      return [];'),
    'normalisePracticeSet', (normalise) => expectRecordingsShapeServed(normalise)],
];

for (const [label, relative, mutate, exportName, probe] of MUTATIONS) {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'practice-media-mut-'));
  try {
    await cp(path.join(ROOT, 'server'), path.join(sandbox, 'server'),
      { recursive: true, filter: (source) => !source.includes('node_modules') });
    const target = path.join(sandbox, ...relative.split('/'));
    const source = await readFile(target, 'utf8');
    const mutated = mutate(source);
    assert.notEqual(mutated, source, `${label}: the mutation must change the module`);
    await writeFile(target, mutated);
    const module = await import(pathToFileURL(target).href);
    assert.equal(typeof module[exportName], 'function', `${label}: the mutated module must still export ${exportName}`);
    // The SAME assertion the leg makes, now against the broken guard: it must fail.
    assert.throws(() => probe(module[exportName]), `${label}: no leg fails on the mutated module`);
    console.log(`MUTATION ${label} -> the guarded leg fails (${relative})`);
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

console.log('');
console.log(`${legNames.length} legs, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 && passed() ? 0 : 1;
