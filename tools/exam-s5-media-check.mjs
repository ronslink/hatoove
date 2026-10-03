#!/usr/bin/env node
/** Offline private transport/state checks. No database, server, network, provider or real audio. */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOwnedApi, Fault } from '../server/owned-api.mjs';
import { mediaResponse, validatePlaybackEvent } from '../server/media-route.mjs';
import { playbackDto, playbackTransition, recoveryPosition } from '../server/owned-postgres/playback.mjs';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
const fails = (fn, code) => assert.throws(fn, e => e.code === code);
const runId = randomUUID(), eventId = randomUUID(), playbackId = randomUUID();
const media = { media_id: 'signal', media_version: 'v1', mime_type: 'audio/wav', sha256: 'a'.repeat(64), max_plays: 1, duration_ms: 2000 };
const bytes = Buffer.from('0123456789');
const begin = { eventId, mediaId: 'signal', mediaVersion: 'v1', expectedRevision: 0, action: 'begin' };
const now = new Date('2026-10-03T14:00:00Z');
const playing = { revision: 1, state: 'playing', plays_used: 1, position_ms: 100, duration_ms: 2000,
  playback_id: playbackId, updated_at: new Date(now.getTime() - 900) };

await check('binary GET and HEAD have exact private lengths/types/checksum without paths', () => {
  const get = mediaResponse(bytes, media);
  assert.equal(get.status, 200); assert.deepEqual(get.body, bytes);
  assert.equal(get.headers['content-length'], '10'); assert.equal(get.headers['content-type'], 'audio/wav');
  assert.equal(get.headers.etag, '"sha256-' + 'a'.repeat(64) + '"');
  assert.equal(get.headers['cache-control'], 'private, no-store');
  const head = mediaResponse(bytes, media, { method: 'HEAD' });
  assert.deepEqual(head.headers, get.headers); assert.equal(head.body.length, 0);
});
await check('closed/open/suffix ranges have exact inclusive bounds', () => {
  for (const [range, content, from, to] of [['bytes=2-5', '2345', 2, 5], ['bytes=8-', '89', 8, 9], ['bytes=-3', '789', 7, 9], ['bytes=-100', '0123456789', 0, 9], ['bytes=9-100', '9', 9, 9]]) {
    const result = mediaResponse(bytes, media, { range });
    assert.equal(result.status, 206); assert.equal(result.body.toString(), content);
    assert.equal(result.headers['content-range'], `bytes ${from}-${to}/10`);
    assert.equal(result.headers['content-length'], String(content.length));
    assert.equal(mediaResponse(bytes, media, { range, method: 'HEAD' }).body.length, 0);
  }
});
await check('invalid/multiple/oversized numeric ranges fail closed with 416', () => {
  for (const range of ['bytes=10-', 'bytes=3-2', 'bytes=-0', 'bytes=-', 'bytes=1-2,4-5', 'items=1-2', 'bytes= 1-2', 'bytes=0-99999999999999999999']) {
    const result = mediaResponse(bytes, media, { range });
    assert.equal(result.status, 416, range); assert.equal(result.body.length, 0);
    assert.equal(result.headers['content-range'], 'bytes */10');
  }
});
await check('strict playback payload rejects authority fields, malformed types and action extras', () => {
  assert.deepEqual(validatePlaybackEvent(begin), begin);
  for (const patch of [{ owner: 'another' }, { maxPlays: 99 }, { durationMs: 1 }, { mediaId: 123 }, { mediaVersion: 'latest' },
    { expectedRevision: -1 }, { expectedRevision: 1.5 }, { action: 'restart' }, { playbackId }, { positionMs: 1 }])
    fails(() => validatePlaybackEvent({ ...begin, ...patch }), 'invalid_playback_request');
  for (const action of ['checkpoint', 'pause', 'complete']) {
    fails(() => validatePlaybackEvent({ ...begin, action, playbackId }), 'invalid_playback_request');
    assert.equal(validatePlaybackEvent({ ...begin, action, playbackId, positionMs: 100 }).positionMs, 100);
  }
  fails(() => validatePlaybackEvent({ ...begin, action: 'recover', playbackId, positionMs: 0 }), 'invalid_playback_request');
});
await check('reading ready/playing/paused never consumes; only playing return advances conservatively', () => {
  const ready = playbackDto(null, media, now); assert.equal(ready.revision, 0); assert.equal(ready.playback_id, null); assert.equal(ready.plays_used, 0);
  assert.equal(playbackDto(playing, media, now).position_ms, 1000);
  assert.equal(playbackDto(playing, media, now).uncertain, true);
  assert.equal(recoveryPosition({ ...playing, state: 'paused' }, now), 100);
  assert.equal(recoveryPosition(playing, new Date(now.getTime() + 99999)), 2000);
  assert.equal(recoveryPosition(playing, new Date(now.getTime() - 99999)), 100);
  assert.equal(playbackDto(playing, media, now, false).position_ms, 100);
});
await check('begin consumes exactly one allowance; DTZ exhaustion and telc second play are separate', () => {
  assert.equal(playbackTransition(null, media, begin, now).plays_used, 1);
  fails(() => playbackTransition(playing, media, { ...begin, expectedRevision: 1 }, now), 'playback_recovery_required');
  const completed = { ...playing, state: 'completed', position_ms: 2000 };
  fails(() => playbackTransition(completed, media, { ...begin, expectedRevision: 1 }, now), 'playback_exhausted');
  const second = playbackTransition(completed, { ...media, max_plays: 2 }, { ...begin, expectedRevision: 1 }, now);
  assert.equal(second.plays_used, 2); assert.equal(second.position_ms, 0); assert.notEqual(second.playback_id, playbackId);
});
await check('recovery rotates device token, preserves allowance, and completes at the authoritative end', () => {
  const body = { ...begin, action: 'recover', expectedRevision: 1, playbackId };
  const recovery = playbackTransition(playing, media, body, now);
  assert.equal(recovery.position_ms, 1000); assert.equal(recovery.plays_used, 1); assert.notEqual(recovery.playback_id, playbackId);
  assert.equal(playbackTransition(playing, media, body, new Date(now.getTime() + 1000)).state, 'completed');
  assert.equal(playbackTransition({ ...playing, state: 'paused' }, media, body, now).position_ms, 100);
  fails(() => playbackTransition(playing, media, { ...body, playbackId: randomUUID() }, now), 'playback_conflict');
  fails(() => playbackTransition(playing, media, { ...body, expectedRevision: 0 }, now), 'playback_conflict');
});
await check('progress requires current UUID/revision and monotonic bounded position', () => {
  const event = { ...begin, action: 'checkpoint', expectedRevision: 1, playbackId, positionMs: 900 };
  assert.equal(playbackTransition(playing, media, event, now).position_ms, 900);
  // A real pause during a network/audio stall saves the acknowledged position, not guessed elapsed audio.
  assert.equal(playbackTransition(playing, media, { ...event, action: 'pause', positionMs: 200 }, now).position_ms, 200);
  for (const positionMs of [99, 2001]) fails(() => playbackTransition(playing, media, { ...event, positionMs }, now), 'invalid_playback_position');
  fails(() => playbackTransition(playing, media, { ...event, action: 'complete' }, now), 'invalid_playback_position');
  assert.equal(playbackTransition(playing, media, { ...event, action: 'complete', positionMs: 2000 }, now).state, 'completed');
  fails(() => playbackTransition({ ...playing, state: 'paused' }, media, event, now), 'playback_recovery_required');
});

let session = { userId: 'owner-a' }, calls = 0, duringRead = null;
const sessions = { getSession: async () => session, signUp() {}, signIn() {}, signOut() {} };
const datastore = Object.fromEntries(['create', 'read', 'save', 'submit', 'result', 'retry', 'remove'].map(name => [name, () => {}]));
datastore.readMockMedia = async owner => { calls++; assert.equal(owner, 'owner-a'); if (duringRead) duringRead(); return { bytes, media }; };
datastore.readMockPlayback = async owner => { assert.equal(owner, 'owner-a'); return [playbackDto(null, media, now)]; };
datastore.mutateMockPlayback = async (owner, id, body) => { assert.equal(owner, 'owner-a'); assert.equal(id, runId); assert.deepEqual(body, begin); return playbackDto(null, media, now); };
const api = createOwnedApi({ datastore, sessions });
const mediaPath = `/api/v1/mock-runs/${runId}/media/signal/v1`;
const request = (path, patch = {}) => api.handle({ method: 'GET', path, headers: { 'x-hatoove-account': 'owner-a' }, ...patch });
await check('binary route requires session and account generation before datastore access', async () => {
  session = null; assert.equal((await request(mediaPath)).status, 401); assert.equal(calls, 0);
  session = { userId: 'owner-b' }; assert.equal((await request(mediaPath)).status, 409); assert.equal(calls, 0);
  session = { userId: 'owner-a' }; const result = await request(mediaPath);
  assert.equal(result.status, 200); assert.deepEqual(result.body, bytes); assert.equal(calls, 1);
});
await check('session revocation/account switch during integrity work fences late private bytes', async () => {
  duringRead = () => { session = null; }; assert.equal((await request(mediaPath)).status, 401);
  session = { userId: 'owner-a' }; duringRead = () => { session = { userId: 'owner-b' }; };
  assert.equal((await request(mediaPath)).status, 409);
  session = { userId: 'owner-a' }; duringRead = null;
});
await check('API ranges/HEAD preserve binary framing and deny query/unknown identities', async () => {
  assert.equal((await request(mediaPath, { method: 'HEAD' })).body.length, 0);
  const range = await request(mediaPath, { headers: { 'x-hatoove-account': 'owner-a', range: 'bytes=2-4' } });
  assert.equal(range.status, 206); assert.equal(range.body.toString(), '234');
  assert.equal((await request(mediaPath + '?owner=another')).status, 422);
  assert.equal((await request(mediaPath.replace(/v1$/, 'latest'))).status, 404);
});
await check('playback uses protected mutation envelope and redacts unexpected private failures', async () => {
  const path = `/api/v1/mock-runs/${runId}/playback`;
  const get = await request(path); assert.equal(JSON.parse(get.body).items[0].state, 'ready');
  const post = { method: 'POST', body: JSON.stringify(begin), headers: { 'content-type': 'application/json', 'x-hatoove-account': 'owner-a' } };
  assert.equal((await request(path, post)).status, 403);
  assert.equal((await request(path, { ...post, originChecked: true })).status, 200);
  datastore.readMockMedia = async () => { throw new Error('private filesystem path/provider detail'); };
  const failed = await request(mediaPath); assert.equal(failed.status, 500); assert.deepEqual(JSON.parse(failed.body), { error: 'internal_error' });
  datastore.readMockMedia = async () => { throw new Fault(409, 'media_integrity'); };
  assert.deepEqual(JSON.parse((await request(mediaPath)).body), { error: 'media_integrity' });
});
console.log(`EXAM-S5 media: ${passed} checks passed.`);
