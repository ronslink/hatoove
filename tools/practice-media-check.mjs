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
/* The SAME gate the shipped admission query interpolates, so the extracted probe runs the real predicate. */
import { importedSetGate } from '../server/owned-postgres/packages.mjs';
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

/**
 * REVIEW-PRACTICE-MEDIA F1. The practice rule must not mask the SHARED transition's structural codes: a stale
 * revision is `playback_conflict` (resync the revision, do not re-check), a spent allowance is
 * `playback_exhausted`, and a play still running is `playback_recovery_required`. Only a structurally VALID
 * `begin` from the second play onward is the practice rule's own refusal. The SQL trigger already had this
 * ordering; this probe pins the JS to it, and the mutation at the end puts the old ordering back.
 */
function expectStructuralCodesSurvive(transition = practicePlaybackTransition) {
  const recording = { media_id: 'm', media_version: 'v1', duration_ms: 1000, max_plays: 2 };
  const played = { plays_used: 1, revision: 2, state: 'completed', duration_ms: 1000, position_ms: 1000, playback_id: randomUUID() };
  const open = { attempt: { state: 'open' } };
  const body = (patch = {}) => ({ action: 'begin', expectedRevision: 2, mediaId: 'm', mediaVersion: 'v1', eventId: randomUUID(), ...patch });
  const codeFor = (row, patch) => {
    try { transition(row, recording, body(patch), new Date(), open); return null; } catch (error) { return error.code; }
  };
  assert.equal(codeFor(played, { expectedRevision: 1 }), 'playback_conflict',
    'a stale revision must stay playback_conflict, so a client resyncs instead of re-checking');
  assert.equal(codeFor({ ...played, plays_used: 2, revision: 3 }, { expectedRevision: 3 }), 'playback_exhausted',
    'a spent allowance must stay playback_exhausted');
  assert.equal(codeFor({ ...played, state: 'playing', position_ms: 0 }, {}), 'playback_recovery_required',
    'a play still running must stay playback_recovery_required');
  assert.equal(codeFor(played, {}), 'practice_check_required',
    'and a structurally valid second listen before Auswerten is still refused by the practice rule');
  return 'conflict / exhausted / recovery_required preserved; practice_check_required last';
}

/**
 * REVIEW-PRACTICE-MEDIA F8. The `0022` grammar drill keeps its twelve sentences in `prompt`, a field the
 * normaliser's PROMPT_FIELDS did not list — so every served drill item had `prompt: ''`. This probe uses the
 * drill's real item shape, and the mutation at the end takes `prompt` back out of the list.
 */
function expectDrillPromptsServed(normalise = normalisePracticeSet) {
  const sentences = Array.from({ length: 12 }, (_, index) => `Ich weiß nicht, ${index + 1} er kommt.`);
  const served = normalise({
    set_id: 'telc-deutsch-b1.sb1.grammar-wortstellung-v1', version: 'v1', family: 'SB1', section: 'SB', part: '1',
    item_count: 12,
    payload: {
      practice_kind: 'grammar-drill',
      instruction: 'Ergänze die Sätze. Dies sind einzelne Grammatikübungen, kein telc-Prüfungssatz.',
      letter: '…',
      gaps: sentences.map((prompt, index) => ({ n: 41 + index, prompt, options: { a: 'ob', b: 'dass', c: 'weil' } })),
    },
  });
  assert.equal(served.items.length, 12, 'the drill serves twelve items');
  assert.deepEqual(served.items.map((item) => item.prompt), sentences, 'every authored sentence reaches the DTO');
  assert.ok(served.items.every((item) => item.prompt.trim().length > 0), 'no drill item may serve an empty prompt');
  assert.deepEqual(served.items.map((item) => item.item_id), sentences.map((_, index) => String(41 + index)));
  return `${served.items.length} drill prompts served non-empty`;
}

/* ------------------------------------------------------------------ POOL-01: the admission rule */

/**
 * POOL-01 (task-49). The admission rule inside `practiceSetForPart`, EXTRACTED FROM THE SHIPPED FILE rather
 * than copied: the probe reads the query out of `server/owned-postgres/adapter.mjs` by its own unique selection
 * list, so an edit to the rule changes what this probe runs and a mutation can be applied to the module it
 * actually ships in. A copy here would be a second query that could drift from the guard it claims to prove.
 *
 * The pattern is anchored at BOTH ends, and that matters: the file carries more than one `SELECT s.set_id`
 * (the attempt-deletion probe reads the same columns), so a `lastIndexOf` on the selection list picks up the
 * wrong literal and the probe would then run a completely different statement.
 */
const ADMISSION_RE = /`SELECT s\.set_id, s\.version, s\.title, s\.family, s\.section, s\.part, s\.item_count, s\.media_required, s\.payload[\s\S]*?COALESCE\(cr\.basis, c\.rights_status\) = ANY\(\$4::text\[\]\)`/;
function admissionSql(source) {
  const match = ADMISSION_RE.exec(source);
  assert.ok(match, 'the admission query must still be present, whole, in server/owned-postgres/adapter.mjs');
  /* The literal carries interpolations (`${importedSetGate()}`); the shipped adapter renders them at call time,
     so this probe must render them too — with the SAME function, imported from the same module. */
  const sql = match[0].slice(1, -1).replace('${importedSetGate()}', importedSetGate());
  for (const member of ['media_required = false', "s.payload->'recordings'", 'exam_media m', 'NOT EXISTS', 'exam_form_member']) {
    assert.ok(sql.includes(member), `the extracted admission query must carry ${member}`);
  }
  assert.ok(!sql.includes('${'), 'no unrendered interpolation may reach the database');
  return sql;
}
/** Run the shipped admission query as the LEARNER role and report which sets it admits for one family. */
async function admittedSets(pool, sql, { family, examId = EXAM, rights = ['generated'], review = ['approved', 'unreviewed'] } = {}) {
  const rows = (await pool.query(sql, [examId, family, review, rights])).rows;
  return rows.map((row) => row.set_id);
}
/** A synthetic media-bound set for the admission probe: `recordings[]` is the only thing that varies. */
async function craftMediaSet(db, { setId, family = 'HV1', section = 'HV', part = 1, recordings, itemCount = 2 }) {
  await db.admin.query(
    `INSERT INTO content_version (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
     VALUES ($1, 'task', 'hv', $2, 'unreviewed', 'unknown', $3, $4)`,
    [setId + '@v1', `content/pool-01/${setId}.json`, 'f'.repeat(64), EXAM]);
  await db.admin.query(
    `INSERT INTO content_rights (content_version_id, basis, decided_by, note)
     VALUES ($1, 'generated', 'tools/practice-media-check.mjs (synthetic fixture)', 'Synthetic probe content; not learner material')`,
    [setId + '@v1']);
  const items = Array.from({ length: itemCount }, (_, index) => ({ n: index + 1, statement: `Technische Aussage ${index + 1}`, answer: true }));
  await db.admin.query(
    `INSERT INTO objective_set (set_id, version, exam_id, family, section, part, title, payload, item_count, media_required, content_version_id)
     VALUES ($1, 'v1', $2, $3, $4, $5, $6, $7::jsonb, $8, true, $9)`,
    [setId, EXAM, family, section, part, 'Interne Technikprobe (Admission)', JSON.stringify({ title: 'Interne Technikprobe (Admission)', recordings, items }), itemCount, setId + '@v1']);
  await db.admin.query(
    `INSERT INTO objective_key (set_id, version, answers, explanations, transcript)
     VALUES ($1, 'v1', $2::jsonb, $3::jsonb, NULL)`,
    [setId, JSON.stringify(Object.fromEntries(items.map((item) => [String(item.n), true]))), '{}']);
}

/* ------------------------------------------------------------------ harness */

/**
 * WHY THIS IS A SECOND BLOCK, and why it is not redundant with the one above: the rule POOL-01 added lives in
 * a SQL string, not in an exported function, so a mutation of it can only be judged by RUNNING the mutated
 * query. Both halves are removed SEPARATELY — dropping the playability clause and dropping the
 * complete-resolution clause are different defects, and a single mutation that removed both would hide a rule
 * whose second half had stopped working.
 *
 * `admissionMutations` is called from INSIDE the F4 leg, while the fixture's pools are still open; the
 * `s5.tech.hv1.*` rows it judges are the ones that leg created.
 */
const ADMISSION_MUTATIONS = [
  {
    label: 'P1 adapter: the playability half removed (a media set is admitted with NO recordings)',
    mutate: (sql) => sql.replace(`              AND (
                s.media_required = false
                OR EXISTS (
                  SELECT 1 FROM jsonb_array_elements(s.payload->'recordings') AS rec
                   WHERE EXISTS (SELECT 1 FROM exam_media m
                                  WHERE m.exam_id = s.exam_id
                                    AND m.media_id = rec->>'mediaId'
                                    AND m.version = rec->>'mediaVersion')
                )
              )\n`, '              AND true\n'),
    refused: ['s5.tech.hv1.none', 's5.tech.hv1.half'],
    admitted: ['s5.tech.hv1.full'],
  },
  {
    label: 'P2 adapter: the complete-resolution half removed (a partially bound set is admitted)',
    mutate: (sql) => sql.replace(`              AND NOT EXISTS (
                SELECT 1 FROM jsonb_array_elements(
                  CASE WHEN jsonb_typeof(s.payload->'recordings') = 'array' THEN s.payload->'recordings' ELSE '[]'::jsonb END) AS rec
                 WHERE NOT EXISTS (SELECT 1 FROM exam_media m
                                    WHERE m.exam_id = s.exam_id
                                      AND m.media_id = rec->>'mediaId'
                                      AND m.version = rec->>'mediaVersion')
              )\n`, ''),
    refused: ['s5.tech.hv1.half', 's5.tech.hv1.mixed'],
    admitted: ['s5.tech.hv1.full'],
  },
];/** The shipped admission query, read once from the real file: the F4 leg and its two mutations share it. */
const SHIPPED_ADMISSION = admissionSql(
  (await readFile(path.join(ROOT, 'server', 'owned-postgres', 'adapter.mjs'), 'utf8')).replaceAll('\r\n', '\n'));

const legNames = [];
const failures = [];
const notes = [];
/** Set by the F4 leg once the rows the two admission mutations judge actually exist. */
let mutationPrereqs = false;
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
  await leg('F1 pure: the practice rule keeps the shared STRUCTURAL codes (conflict / exhausted / recovery_required)', expectStructuralCodesSurvive);
  await leg('F8 pure: the grammar drill\'s twelve authored prompts reach the DTO', expectDrillPromptsServed);

  /* ---------------------------------------------------------------- the served sitting and its audio */
  /*
   * FIX-F1 — THE SITTING IS CRAFTED, and this file is the one place where that is the honest choice. The runner
   * no longer serves a listening set: there is no practice playback transport yet, so serving one put live
   * answer controls beside a player that could not play and recorded the blind guesses as `item_evidence`. The
   * subject of THIS check is the PLAYBACK path (`practice-playback.mjs`, its allowance, its byte route), which
   * is unchanged and still owed its transport; the serving DECISION has its own legs in
   * `practice-selection-check` (P8f/P9/P14). So the sitting is opened here the way the serving path used to open
   * it — same table, same columns, `mode` defaulting to `part` — and everything downstream is untouched.
   */
  const openMediaSitting = async (setId) => {
    const setRow = (await db.admin.query(
      `SELECT s.set_id, s.version, s.title, s.family, s.section, s.part, s.item_count, s.media_required, s.payload
         FROM objective_set s WHERE s.set_id = $1`, [setId])).rows[0];
    assert.ok(setRow, `${setId} must exist in the fixture`);
    assert.equal(setRow.media_required, true, `${setId} is a listening set`);
    const set = normalisePracticeSet({ ...setRow, items: undefined }, setRow.payload?.playback ?? null);
    const attemptId = randomUUID();
    await db.admin.query(
      `INSERT INTO practice_attempt
         (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [attemptId, owner.id, EXAM, owner.preparationId, setRow.set_id, setRow.version, setRow.family,
        setRow.section, set.item_count]);
    return { set, attempt: { attempt_id: attemptId, state: 'open' } };
  };
  const served = await openMediaSitting(LISTENING_SET);
  const servedHv3 = await openMediaSitting('s5.telc-deutsch-b1.hv3');
  let hv1State = null;

  await leg('M3 the PLAYBACK path hands over the authored set WITH its audio and the exam allowance', async () => {
    assert.ok(served, 'the sitting exists');
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
    /*
     * FIX-F1: the practice CHECK refuses a listening sitting (there is no honest answer to inaudible audio), so
     * the "after Auswerten" state is produced directly here. The subject of this leg is the REPLAY rule, which
     * reads `state = 'checked'`; that state is unreachable through the shipped path until the practice playback
     * transport lands, and asserting the refusal instead is `practice-selection-check` P14's job.
     */
    await db.admin.query(
      `UPDATE practice_attempt
          SET state = 'checked', answered_count = item_count, correct_count = item_count, checked_at = now()
        WHERE attempt_id = $1`, [servedHv3.attempt.attempt_id]);
    const checked = (await db.admin.query(
      'SELECT state FROM practice_attempt WHERE attempt_id = $1', [servedHv3.attempt.attempt_id])).rows[0];
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

  /* ---------------------------------------------------------------- F8 and F3, from the SEEDED corpus */
  await leg('F8 DB: the drill row the migrations seed serves twelve NON-EMPTY prompts', async () => {
    const { normalisePracticeSet } = await import('../server/practice-sets.mjs');
    const row = (await db.admin.query(
      `SELECT s.set_id, s.version, s.family, s.section, s.part, s.title, s.payload, s.item_count, s.media_required
         FROM objective_set s WHERE s.set_id = 'telc-deutsch-b1.sb1.grammar-wortstellung-v1' AND s.version = 'v1'`)).rows[0];
    assert.ok(row, 'the seeded corpus must contain the recovered grammar drill');
    const authored = row.payload.gaps ?? [];
    assert.equal(authored.length, 12, 'the drill is twelve gaps');
    assert.equal(authored.filter((gap) => typeof gap.prompt === 'string' && gap.prompt.trim()).length, 12,
      'and all twelve sentences are authored in `prompt` — the field PROMPT_FIELDS used to omit');
    const served = normalisePracticeSet(row);
    assert.equal(served.items.length, 12);
    assert.ok(served.items.every((item) => item.prompt.trim().length > 0),
      'every served drill item must carry its sentence, not an empty prompt');
    // NOTE: the drill's `practice_kind`/`instruction` disclosure is task-20's change to MATERIAL_MEMBERS; this
    // branch predates it and the Lead resolves that one line at integration. F8 here is the `prompt` field.
    return `${served.items.length} seeded drill prompts served non-empty`;
  });

  /* ------------------------------------------------------------------ POOL-01: the admission rule */

  const ADMISSION = SHIPPED_ADMISSION;
  const s5Media = (await db.admin.query(
    `SELECT media_id, version FROM exam_media WHERE exam_id = $1 ORDER BY media_id LIMIT 2`, [EXAM])).rows;
  assert.equal(s5Media.length, 2, 'the fixture must import at least two media rows for the probe');

  await leg('F4 DB: the shipped admission rule serves a listening set only when EVERY recording resolves', async () => {
    /*
     * THE THREE SHAPES THE RULE MUST TELL APART, all built as synthetic `media_required` sets in the fixture:
     *
     *   s5.tech.hv1.none   no `recordings[]` at all                          -> REFUSED (FIX-F1's protection)
     *   s5.tech.hv1.half   one binding with NO `exam_media` row at all       -> REFUSED (the playability half)
     *   s5.tech.hv1.mixed  one binding that resolves AND one that does not   -> REFUSED (every recording must)
     *   s5.tech.hv1.full   every binding resolves                            -> ADMITTED
     *
     * The binding that resolves is a real imported row; the binding that does not is the same id with a version
     * that was never imported, so NOTHING has to be deleted to build the partial state (and `exam_media` is
     * immutable on purpose — the trigger refuses a delete, which is its own proof that history is not rewritten).
     * The rule is the SHIPPED query (`SHIPPED_ADMISSION`), run as the learner role, so this is the serving
     * decision itself and not a paraphrase of it.
     */
    await craftMediaSet(db, { setId: 's5.tech.hv1.none', recordings: [] });
    await craftMediaSet(db, { setId: 's5.tech.hv1.half', recordings: [
      { id: 'probe-a', mediaId: s5Media[0].media_id, mediaVersion: 'v9999', label: 'Signal A (never imported)' },
    ] });
    await craftMediaSet(db, { setId: 's5.tech.hv1.mixed', recordings: [
      { id: 'probe-a', mediaId: s5Media[0].media_id, mediaVersion: s5Media[0].version, label: 'Signal A' },
      { id: 'probe-b', mediaId: s5Media[1].media_id, mediaVersion: 'v9999', label: 'Signal B (never imported)' },
    ] });
    await craftMediaSet(db, { setId: 's5.tech.hv1.full', recordings: [
      { id: 'probe-a', mediaId: s5Media[0].media_id, mediaVersion: s5Media[0].version, label: 'Signal A' },
      { id: 'probe-b', mediaId: s5Media[1].media_id, mediaVersion: s5Media[1].version, label: 'Signal B' },
    ] });

    const admitted = await admittedSets(db.learner, ADMISSION, { family: 'HV1' });
    assert.ok(admitted.includes('s5.tech.hv1.full'), 'a set whose every recording resolves must be admitted');
    assert.ok(admitted.includes('s5.telc-deutsch-b1.hv1'), 'and the fixture set whose whole binding resolves keeps being admitted');
    assert.ok(!admitted.includes('s5.tech.hv1.none'), 'a media set with NO recordings[] binding must be refused');
    assert.ok(!admitted.includes('s5.tech.hv1.half'), 'a media set whose only recording has no exam_media row must be refused');
    assert.ok(!admitted.includes('s5.tech.hv1.mixed'), 'ONE unplayable recording in the binding refuses the whole set');
    /* The two admission mutations are judged after the legs, while these rows and the pool are still alive. */
    mutationPrereqs = true;
    return `${admitted.length} admitted of 5 HV1 candidates; the recordingless, unbound and partially bound sets are refused`;
  });

  await leg('F4b the refused half still protects the MARKING path: a sitting on a recordingless set is refused', async () => {
    /*
     * FIX-F1's backstop, exercised for the shape POOL-01 creates. The set is media-bound with NO resolvable
     * recording, so it is never SERVED — and if a sitting exists anyway (a stale client, an attempt opened
     * before this rule), `POST /practice/check` must still refuse to mark a guess about audio nobody heard.
     */
    const attemptId = await craftAttempt(owner, 's5.tech.hv1.none');
    const before = (await db.admin.query('SELECT count(*)::int AS n FROM item_evidence WHERE owner_id = $1', [owner.id])).rows[0].n;
    const response = await call(owner, 'POST', '/api/v1/practice/check', {
      preparationId: owner.preparationId, attemptId, answers: [{ item_id: '1', answer: true }],
    });
    assert.equal(response.status, 409, `expected the marking refusal, got ${response.status} ${response.body}`);
    assert.equal(response.json.error, 'media_unavailable', 'and the refusal names audio that cannot be played');
    const after = (await db.admin.query('SELECT count(*)::int AS n FROM item_evidence WHERE owner_id = $1', [owner.id])).rows[0].n;
    assert.equal(after, before, 'not one guess was recorded');
  });

  await leg('F3 DB: a set with recordings but NO blueprint playback rule answers practice_playback_unavailable', async () => {    /*
     * The PARTIAL-IMPORT state the reviewer could not build. It cannot be expressed as a listening PACKAGE (the
     * validator refuses a `fixed_audio` part without `playback`), so it is constructed the way a partial import
     * leaves it: a served set that HAS `recordings` whose blueprint part carries no playback rule. The SQL then
     * returns `max_plays = NULL` — the value `Number(null) === 0` used to swallow.
     */
    const head = (await db.admin.query(
      'SELECT release_version FROM exam_release_head WHERE exam_id=$1', [EXAM])).rows[0].release_version;
    const release = (await db.admin.query(
      'SELECT * FROM exam_release WHERE exam_id=$1 AND version=$2', [EXAM, head])).rows[0];
    const blueprint = (await db.admin.query(
      'SELECT payload FROM exam_blueprint WHERE exam_id=$1 AND version=$2', [EXAM, release.blueprint_version])).rows[0];
    const stripped = JSON.parse(JSON.stringify(blueprint.payload));
    let removed = 0;
    for (const section of stripped.sections ?? []) {
      for (const part of section.parts ?? []) {
        if (part.mediaRequired === true && part.family === 'HV2') { delete part.playback; removed += 1; }
      }
    }
    assert.equal(removed, 1, 'the fixture blueprint must carry exactly one HV2 listening part to strip');
    /*
     * `exam_blueprint` is immutable (the trigger says "create a new version instead"), so the partial state is
     * built the way one is built: a NEW blueprint version without the rule, a NEW release pointing at it, and
     * the release head moved for the length of this leg. That is exactly what an import that lands sets before
     * the blueprint rule leaves behind.
     */
    const PARTIAL = 'v9998';
    await db.admin.query('INSERT INTO exam_blueprint (exam_id, version, payload, sha256) VALUES ($1,$2,$3::jsonb,$4)',
      [EXAM, PARTIAL, JSON.stringify(stripped), 'b'.repeat(64)]);
    await db.admin.query(
      `INSERT INTO exam_release (exam_id, version, blueprint_version, state, manifest, sha256, publisher)
       SELECT exam_id, $3, $4, state, manifest, sha256, publisher FROM exam_release WHERE exam_id=$1 AND version=$2`,
      [EXAM, head, PARTIAL, PARTIAL]);
    await db.admin.query(
      `INSERT INTO exam_release_form (exam_id, release_version, form_id, form_version)
       SELECT exam_id, $3, form_id, form_version FROM exam_release_form WHERE exam_id=$1 AND release_version=$2`,
      [EXAM, head, PARTIAL]);
    await db.admin.query('UPDATE exam_release_head SET release_version=$2 WHERE exam_id=$1', [EXAM, PARTIAL]);
    const attemptId = await craftAttempt(owner, 's5.telc-deutsch-b1.hv2');
    try {
      await assert.rejects(port.readPracticePlayback(owner.id, attemptId),
        (error) => error.status === 409 && error.code === 'practice_playback_unavailable',
        'a missing playback rule must be practice_playback_unavailable, never a max_plays of 0');
      // The two halves of the reviewer's reasoning, now MEASURED rather than reasoned.
      const sandbox = await mkdtemp(path.join(tmpdir(), 'practice-media-guard-'));
      try {
        await cp(path.join(ROOT, 'server'), path.join(sandbox, 'server'), { recursive: true, filter: (source) => !source.includes('node_modules') });
        const target = path.join(sandbox, 'server', 'owned-postgres', 'practice-playback.mjs');
        const source = (await readFile(target, 'utf8')).replaceAll('\r\n', '\n');
        const mutated = source.replace(
          "    const maxPlays = allowance === undefined || allowance === null ? null : allowance.max_plays;\n"
          + "    if (maxPlays === null || maxPlays === undefined || !Number.isInteger(Number(maxPlays)) || Number(maxPlays) < 1) {\n"
          + "      fail(409, 'practice_playback_unavailable');\n    }",
          // The OLD guard, with the binding kept so the mutation reproduces the DEFECT (max_plays 0 passing
          // through) instead of a ReferenceError.
          "    const maxPlays = allowance ? allowance.max_plays : null;\n"
          + "    if (!allowance || !Number.isInteger(Number(allowance.max_plays))) fail(409, 'practice_playback_unavailable');");
        assert.notEqual(mutated, source, 'the F3 mutation must apply');
        await writeFile(target, mutated);
        const legacyAdapter = await import(pathToFileURL(path.join(sandbox, 'server', 'owned-postgres', 'adapter.mjs')).href);
        const legacyPort = legacyAdapter.createPostgresDatastore({ pool: db.learner, mediaRoot });
        const legacyState = await legacyPort.readPracticePlayback(owner.id, attemptId);
        assert.equal(legacyState.items.length, 1, 'the OLD guard serves an item whose max_plays is 0');
        assert.equal(legacyState.items[0].max_plays, 0, 'Number(null) === 0 — that is the defect');
        await assert.rejects(legacyPort.mutatePracticePlayback(owner.id, attemptId, begin(legacyState.items[0])),
          (error) => error.code !== 'practice_playback_unavailable',
          'and the learner is then told a code that has nothing to do with the real problem');
        // ...and the trigger's half: a row with max_plays 0 is a structural violation, not an answer.
        const media = await mediaRow(legacyState.items[0].media_id, legacyState.items[0].media_version);
        await assert.rejects(asOwner(owner.id, (client) => client.query(
          `INSERT INTO practice_playback
             (owner_id,attempt_id,exam_id,media_id,media_version,state,plays_used,max_plays,position_ms,duration_ms,playback_id)
           VALUES ($1,$2,$3,$4,$5,'playing',1,0,0,$6,$7)`,
          [owner.id, attemptId, EXAM, media.media_id ?? legacyState.items[0].media_id, legacyState.items[0].media_version,
            media.duration_ms, randomUUID()])),
          /invalid_playback_identity/, 'the trigger refuses max_plays 0 as invalid_playback_identity');
      } finally { await rm(sandbox, { recursive: true, force: true }).catch(() => {}); }
      return 'new guard: practice_playback_unavailable; old guard: max_plays 0 and a code that misleads';
    } finally {
      // The head points back at the real release; the extra partial version/release rows are inert and the
      // whole fixture schema is dropped by the harness teardown.
      await db.admin.query('UPDATE exam_release_head SET release_version=$2 WHERE exam_id=$1', [EXAM, head]);
    }
  });

  /*
   * POOL-01's two admission mutations, judged by RUNNING the mutated query. They run HERE because they need
   * the open fixture: the rows they judge were created by the F4 leg above, and the teardown below closes the
   * learner pool. `mutationPrereqs` is false when that leg never reached its last assertion, so a fixture
   * failure produces one honest FAIL instead of a second, misleading one.
   */
  if (mutationPrereqs) await admissionMutations(db.learner);
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
  /* F1: put the practice rule BACK in front of the shared transition — the ordering that masked three codes. */
  ['M3 practice-playback: the practice rule moved back BEFORE the shared transition (F1)', 'server/owned-postgres/practice-playback.mjs',
    (source) => source.replace(
      "  const next = playbackTransition(row, recording, body, now);\n"
      + "  if (body.action === 'begin' && used > 0 && attempt?.state !== 'checked') fail(409, 'practice_check_required');\n"
      + '  return next;',
      "  if (body.action === 'begin' && used > 0 && attempt?.state !== 'checked') fail(409, 'practice_check_required');\n"
      + '  return playbackTransition(row, recording, body, now);'),
    'practicePlaybackTransition', (transition) => expectStructuralCodesSurvive(transition)],
  /* F8: take `prompt` back out of the field list — the drill's twelve sentences then serve empty. */
  ['M4 practice-sets: `prompt` dropped from PROMPT_FIELDS (F8)', 'server/practice-sets.mjs',
    (source) => source.replace(
      "const PROMPT_FIELDS = Object.freeze(['prompt', 'question', 'statement', 'text']);",
      "const PROMPT_FIELDS = Object.freeze(['question', 'statement', 'text']);"),
    'normalisePracticeSet', (normalise) => expectDrillPromptsServed(normalise)],
];

for (const [label, relative, mutate, exportName, probe] of MUTATIONS) {
  const sandbox = await mkdtemp(path.join(tmpdir(), 'practice-media-mut-'));
  try {
    await cp(path.join(ROOT, 'server'), path.join(sandbox, 'server'),
      { recursive: true, filter: (source) => !source.includes('node_modules') });
    const target = path.join(sandbox, ...relative.split('/'));
    /*
     * REVIEW merged-tree M2. M3 is the only multi-line mutation pattern in this file and it joins its lines
     * with LF, while a Windows working tree is CRLF (`core.autocrlf=true`, and `.gitattributes` pins LF only
     * for `server/migrations/*.sql`). The pattern therefore matched nothing and the guard aborted BEFORE the
     * tally, printing a stack trace where a reader expects "N legs, M failed" — green on CI, red on every
     * Windows tree, which is the worst combination. The read is normalised here (the same idiom the F3 block
     * already uses) and an unapplicable mutation is recorded as a named failure instead of throwing.
     */
    const source = (await readFile(target, 'utf8')).replaceAll('\r\n', '\n');
    const mutated = mutate(source);
    if (mutated === source) {
      failures.push(`${label}: the mutation must change the module (${relative})`);
      console.log(`MUTATION ${label} -> the pattern no longer matches the module`);
      continue;
    }
    await writeFile(target, mutated);
    const module = await import(pathToFileURL(target).href);
    if (typeof module[exportName] !== 'function') {
      failures.push(`${label}: the mutated module must still export ${exportName}`);
      continue;
    }
    // The SAME assertion the leg makes, now against the broken guard: it must fail.
    try {
      probe(module[exportName]);
      failures.push(`${label}: no leg fails on the mutated module`);
    } catch {
      console.log(`MUTATION ${label} -> the guarded leg fails (${relative})`);
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true }).catch(() => {});
  }
}

/* ------------------------------------ POOL-01: the admission rule, mutation-proved (each half separately) */

/**
 * Both halves of the rule, judged by RUNNING the mutated query against the OPEN fixture. It must run after
 * the legs (the guard's own tables are created by F4) and before the harness closes the pools.
 */
async function admissionMutations(pool) {
  for (const mutation of ADMISSION_MUTATIONS) {
    const mutated = mutation.mutate(SHIPPED_ADMISSION);
    if (mutated === SHIPPED_ADMISSION) {
      failures.push(`${mutation.label}: the mutation no longer matches the shipped admission query`);
      console.log(`MUTATION ${mutation.label} -> the pattern no longer matches the query`);
      continue;
    }
    const admitted = await admittedSets(pool, mutated, { family: 'HV1' });
    const wrong = [];
    for (const setId of mutation.refused) if (admitted.includes(setId)) wrong.push(`${setId} must stay REFUSED`);
    for (const setId of mutation.admitted) if (!admitted.includes(setId)) wrong.push(`${setId} must stay admitted`);
    if (!wrong.length) {
      failures.push(`${mutation.label}: no leg fails on the mutated query`);
      console.log(`MUTATION ${mutation.label} -> NOTHING failed, which is the defect`);
      continue;
    }
    console.log(`MUTATION ${mutation.label} -> the guarded leg fails (${wrong.join('; ')})`);
  }
}

console.log('');
console.log(`${legNames.length} legs, ${failures.length} failed`);
for (const failure of failures) console.log(`  FAIL ${failure}`);
process.exitCode = failures.length === 0 && passed() ? 0 : 1;
