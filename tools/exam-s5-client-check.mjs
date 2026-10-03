import assert from 'node:assert/strict';
import { setLocale } from '../public/assets/i18n/core.js';
// These retained copy assertions deliberately exercise the German interface.
setLocale('de');
import { mockMember } from '../public/app/mock.js';
import { createApi } from '../public/app/api.js';
import { createListeningController, createListeningSession, listeningMessage } from '../public/app/listening.js';

const descriptor = { id: 'clip-a', media_id: 'dtz.clip-a', media_version: 'v1', label: 'Nachricht 1', duration_ms: 12000, mime_type: 'audio/wav', max_plays: 1 };
const member = { interaction: 'fixed_audio', recordings: [descriptor], payload: { recordings: [{ id: 'clip-a', mediaId: 'dtz.clip-a', mediaVersion: 'v1', label: 'Nachricht 1', questions: [{ n: 1, question: 'Was ist richtig?', options: { a: 'Heute', b: 'Morgen' } }] }] } };
const rendered = mockMember(member);
assert.ok(rendered, 'fixed_audio must render questions with exact recording binding');
assert.equal(rendered.items[0].recordingId, 'clip-a');
assert.deepEqual(rendered.items[0].options, [{ id: 'a', label: 'Heute' }, { id: 'b', label: 'Morgen' }]);
assert.equal(typeof createApi().mock.media, 'function');
console.log('PASS fixed audio renderer and protected media transport exist');

let passed = 1;
const check = async (name, work) => { await work(); passed++; console.log('PASS ' + name); };
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => structuredClone(value);
const run = { id: 'run-1', release_state: 'internal', attempt_mode: 'practice' };
const ready = () => ({ media_id: descriptor.media_id, media_version: 'v1', revision: 0, state: 'ready', plays_used: 0, max_plays: 1,
  position_ms: 0, duration_ms: 12000, playback_id: null, uncertain: false, server_now: '2026-10-03T14:00:00Z' });
function fixture(initial = ready()) {
  let saved = clone(initial), serial = 0, interceptor = null;
  const calls = [], receipts = new Map();
  const api = { mock: {
    playback: async () => ({ ok: true, data: { items: [{ ...clone(saved), uncertain: saved.state === 'playing' }] } }),
    media: async () => ({ ok: true, data: new Blob(['synthetic'], { type: 'audio/wav' }) }),
    playbackEvent: async (id, body) => {
      calls.push({ id, body: clone(body) });
      if (interceptor) { const override = await interceptor(id, body); if (override) return override; }
      if (receipts.has(body.eventId)) return { ok: true, data: { playback: clone(saved) } };
      if (body.expectedRevision !== saved.revision) return { ok: false, status: 409, error: 'playback_conflict' };
      if (body.action === 'begin') saved = { ...saved, state: 'playing', position_ms: 0, plays_used: saved.plays_used + 1, playback_id: 'play-' + ++serial };
      if (body.action === 'recover') saved = { ...saved, state: saved.position_ms === saved.duration_ms ? 'completed' : 'playing', playback_id: 'play-' + ++serial };
      if (body.action === 'checkpoint') saved.position_ms = body.positionMs;
      if (body.action === 'pause') saved = { ...saved, state: 'paused', position_ms: body.positionMs };
      if (body.action === 'complete') saved = { ...saved, state: 'completed', position_ms: body.positionMs };
      saved.revision++; saved.uncertain = false;
      receipts.set(body.eventId, true);
      return { ok: true, data: { playback: clone(saved) } };
    },
  } };
  return { api, calls, receipts, get saved() { return saved; }, set saved(value) { saved = clone(value); }, intercept(value) { interceptor = value; } };
}
const sessionFor = f => createListeningSession({ api: f.api, eventId: (() => { let n = 0; return () => 'event-' + ++n; })() });

await check('audio question renderer rejects missing exact media, duplicate recording and question identities', async () => {
  for (const mutate of [m => { m.recordings[0].media_version = 'v2'; }, m => { m.payload.recordings.push(clone(m.payload.recordings[0])); },
    m => { m.payload.recordings[0].questions.push(clone(m.payload.recordings[0].questions[0])); }]) {
    const m = clone(member); mutate(m); assert.equal(mockMember(m), null);
  }
});
await check('reading playback is non-consuming and unknown or mismatched metadata fails closed', async () => {
  const f = fixture(), s = sessionFor(f); assert.equal(await s.read(run.id, descriptor), true); assert.equal(f.calls.length, 0);
  assert.equal(await s.read(run.id, { ...descriptor, media_version: 'v2' }), false); assert.equal(s.state().playback, null);
});
await check('one DTZ play cannot begin again and checkpoint position cannot move backwards', async () => {
  const f = fixture(), s = sessionFor(f); await s.read(run.id, descriptor); assert.equal(await s.act('begin'), true);
  assert.equal(await s.act('begin'), false); assert.equal(await s.act('checkpoint', 4000), true);
  assert.equal(await s.act('checkpoint', 2000), false); assert.equal(await s.act('checkpoint', 12001), false);
  assert.equal(await s.act('complete', 12000), true); assert.equal(await s.act('begin'), false); assert.equal(f.saved.plays_used, 1);
});
await check('lost begin acknowledgement retries identical event and body and consumes only once', async () => {
  const f = fixture(), send = f.api.mock.playbackEvent; let lose = true;
  f.api.mock.playbackEvent = async (...args) => { const result = await send(...args); if (lose) { lose = false; return { ok: false, status: 0, error: 'network' }; } return result; };
  const s = sessionFor(f); await s.read(run.id, descriptor); assert.equal(await s.act('begin'), false); assert.equal(s.state().pending, true);
  assert.equal(await s.act('begin'), false); assert.equal(await s.retry(), true); assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.saved.plays_used, 1);
});
await check('explicit uncertain recovery rotates playback identity without a new allowance', async () => {
  const f = fixture({ ...ready(), state: 'playing', position_ms: 6200, revision: 3, plays_used: 1, playback_id: 'old' }), s = sessionFor(f);
  await s.read(run.id, descriptor); assert.equal(s.state().playback.uncertain, true); assert.equal(await s.act('checkpoint', 6500), false);
  assert.equal(await s.act('recover'), true); assert.equal(f.saved.plays_used, 1); assert.equal(f.saved.position_ms, 6200); assert.notEqual(f.saved.playback_id, 'old');
  assert.equal(await s.act('pause', 6500), true); assert.equal(f.saved.position_ms, 6500);
});
await check('a stale mutation response cannot replace another run or recording', async () => {
  const f = fixture(), s = sessionFor(f); await s.read(run.id, descriptor); let release;
  f.intercept(() => new Promise(resolve => { release = resolve; })); const pending = s.act('begin'); await tick();
  await s.read('other-run', descriptor); release({ ok: true, data: { playback: { ...ready(), revision: 1, state: 'playing', plays_used: 1, playback_id: 'old' } } });
  assert.equal(await pending, false); assert.equal(s.state().runId, 'other-run'); assert.equal(s.state().playback.plays_used, 0);
});
await check('telc second play uses its descriptor allowance while recovery keeps the current one', async () => {
  const f = fixture({ ...ready(), max_plays: 2, plays_used: 1, revision: 2, state: 'completed', position_ms: 12000, playback_id: 'old' }), s = sessionFor(f);
  await s.read(run.id, { ...descriptor, max_plays: 2 }); assert.equal(await s.act('begin'), true); assert.equal(f.saved.plays_used, 2);
  await s.act('pause', 1000); await s.act('recover'); assert.equal(f.saved.plays_used, 2);
});
await check('unchanged acknowledgement cannot authorize audio and rotated progress acknowledgement is refused', async () => {
  const f = fixture(), s = sessionFor(f); await s.read(run.id, descriptor);
  f.intercept(async () => ({ ok: true, data: { playback: ready() } }));
  assert.equal(await s.act('begin'), false); assert.equal(s.state().pending, true);
  f.intercept(null); await s.retry();
  f.intercept(async () => ({ ok: true, data: { playback: { ...f.saved, revision: f.saved.revision + 1, playback_id: 'other-document', position_ms: 4000 } } }));
  assert.equal(await s.act('checkpoint', 2000), false); assert.equal(s.state().pending, true);
});

class FakeAudio extends EventTarget {
  currentTime = 0; playbackRate = 1; paused = true; ended = false; controls = false; reject = false; plays = 0;
  play() { this.plays++; if (this.reject) return Promise.reject(new Error('autoplay')); this.paused = false; this.dispatchEvent(new Event('playing')); return Promise.resolve(); }
  pause() { const previous = this.paused; this.paused = true; if (!previous) this.dispatchEvent(new Event('pause')); }
  load() {} removeAttribute() {} setAttribute() {} remove() { this.removed = true; }
}
function controllerFor(f, options = {}) {
  const audios = [], revoked = [], host = { innerHTML: '', contains: () => false, querySelector: () => null }, urls = [];
  const c = createListeningController({ api: f.api, esc: x => String(x), createAudio: () => { const a = new FakeAudio(); audios.push(a); return a; },
    createObjectURL: () => { const url = 'blob:synthetic-' + urls.length; urls.push(url); return url; }, revokeObjectURL: x => revoked.push(x), ...options });
  c.mount(host, run, descriptor);
  return { c, host, audios, urls, revoked, async ready() { await tick(); await c.loadMedia(); audios.at(-1).dispatchEvent(new Event('canplay')); },
    async play() { await c.play(); await tick(); await tick(); } };
}
await check('preload failure and native rejected play never consume an allowance', async () => {
  const f = fixture(); f.api.mock.media = async () => ({ ok: false, status: 503, error: 'media_unavailable' });
  const v = controllerFor(f); await tick(); await v.c.loadMedia(); assert.equal(f.calls.length, 0); assert.equal(v.c.state().ready, false); v.c.dispose();
  const g = fixture(), w = controllerFor(g); await w.ready(); assert.equal(g.calls.length, 0); w.audios[0].reject = true; await w.play();
  assert.equal(g.calls.length, 0); assert.equal(w.c.state().error.error, 'play_rejected'); w.c.dispose();
});
await check('actual playing pauses for the server acknowledgement then continues the same recording', async () => {
  const f = fixture(), v = controllerFor(f); await v.ready(); const original = f.api.mock.playbackEvent; let release;
  f.api.mock.playbackEvent = (...args) => new Promise(resolve => { release = async () => resolve(await original(...args)); });
  await v.c.play(); assert.equal(v.audios[0].paused, true); assert.equal(f.saved.plays_used, 0);
  await release(); await tick(); await tick(); assert.equal(v.audios[0].paused, false); assert.equal(f.saved.plays_used, 1);
  f.api.mock.playbackEvent = original; v.audios[0].currentTime = 3; assert.equal(await v.c.flush(), true);
  assert.equal(f.saved.state, 'paused'); assert.equal(f.saved.position_ms, 3000); assert.equal(v.audios[0].paused, true); v.c.dispose();
});
await check('controller retry after lost begin does not auto-replay and saves a pause', async () => {
  const f = fixture(), send = f.api.mock.playbackEvent; let lose = true;
  f.api.mock.playbackEvent = async (...args) => { const result = await send(...args); if (lose) { lose = false; return { ok: false, status: 0, error: 'network' }; } return result; };
  const v = controllerFor(f); await v.ready(); await v.play(); assert.equal(v.audios[0].paused, true); assert.equal(v.c.state().pending, true);
  await v.c.retry(); assert.equal(f.saved.plays_used, 1); assert.equal(f.saved.state, 'paused'); assert.equal(v.audios[0].paused, true);
  assert.deepEqual(f.calls[0], f.calls[1]); v.c.dispose();
});
await check('a new document requires explicit recovery and resumes the persisted offset', async () => {
  const f = fixture({ ...ready(), state: 'playing', position_ms: 7000, revision: 4, plays_used: 1, playback_id: 'old' }), v = controllerFor(f);
  await v.ready(); assert.match(v.host.innerHTML, /Unterbrechungsstelle ist unsicher/); assert.match(v.host.innerHTML, /data-listening-action="recover"/); assert.equal(f.calls.length, 0);
  await v.play(); assert.equal(f.calls[0].body.action, 'recover'); assert.equal(v.audios[0].currentTime, 7); assert.equal(f.saved.plays_used, 1); v.c.dispose();
});
await check('recovery at the end completes without native replay or a new debit', async () => {
  const f = fixture({ ...ready(), state: 'playing', position_ms: 12000, revision: 4, plays_used: 1, playback_id: 'old' }), v = controllerFor(f);
  await v.ready(); await v.play(); assert.equal(v.audios[0].plays, 0); assert.equal(f.saved.state, 'completed'); assert.equal(f.saved.plays_used, 1); v.c.dispose();
});
await check('route disposal fences an in-flight private media response and revokes existing blobs', async () => {
  const f = fixture(); let release; f.api.mock.media = () => new Promise(resolve => { release = resolve; });
  const v = controllerFor(f); await tick(); const pending = v.c.loadMedia(); v.c.dispose(); release({ ok: true, data: new Blob(['late']) }); await pending;
  assert.equal(v.urls.length, 0); assert.equal(v.audios.length, 0);
  const w = controllerFor(fixture()); await w.ready(); w.c.dispose(); assert.deepEqual(w.revoked, w.urls); assert.equal(w.audios[0].removed, true);
});
await check('save/session freeze immediately stops native audio and prevents a late start', async () => {
  const f = fixture(), v = controllerFor(f); await v.ready(); await v.play(); assert.equal(v.audios[0].paused, false);
  v.c.freeze(true); assert.equal(v.audios[0].paused, true); assert.equal(await v.c.play(), false); assert.match(v.host.innerHTML, /Wiedergabe gesperrt/); v.c.dispose();
});
await check('late begin from a disposed route cannot pause the newly playing run', async () => {
  const f = fixture(), v = controllerFor(f); await v.ready(); let release;
  const original = f.api.mock.playbackEvent;
  f.api.mock.playbackEvent = (id, body) => id === run.id ? new Promise(resolve => { release = resolve; }) : original(id, body);
  await v.c.play();
  v.c.mount(v.host, { ...run, id: 'run-2' }, descriptor); await tick(); await v.c.loadMedia(); v.audios[1].dispatchEvent(new Event('canplay')); await v.play();
  assert.equal(v.audios[1].paused, false);
  release({ ok: true, data: { playback: { ...ready(), revision: 1, state: 'playing', plays_used: 1, playback_id: 'old' } } }); await tick(); await tick();
  assert.equal(v.audios[1].paused, false); assert.equal(v.c.state().runId, 'run-2'); v.c.dispose();
});
await check('navigation while begin is pending waits for its receipt and pauses without resuming audio', async () => {
  const f = fixture(), v = controllerFor(f); await v.ready(); const original = f.api.mock.playbackEvent; let release;
  f.api.mock.playbackEvent = (id, body) => body.action === 'begin' ? new Promise(resolve => { release = async () => resolve(await original(id, body)); }) : original(id, body);
  await v.c.play(); const navigating = v.c.flush(); await release(); assert.equal(await navigating, true);
  assert.equal(f.saved.state, 'paused'); assert.equal(v.audios[0].plays, 1); assert.equal(v.audios[0].paused, true); v.c.dispose();
});
await check('pending checkpoint retains an enabled immediate pause and serialises its durable save', async () => {
  let clock=0,release;const f=fixture(),v=controllerFor(f,{now:()=>clock});await v.ready();await v.play();
  const original=f.api.mock.playbackEvent;
  f.api.mock.playbackEvent=(id,body)=>body.action==='checkpoint'?new Promise(resolve=>{release=async()=>resolve(await original(id,body));}):original(id,body);
  try {
    v.audios[0].currentTime=3;clock=3000;await new Promise(resolve=>setTimeout(resolve,600));
    assert.equal(typeof release,'function');assert.equal(v.audios[0].paused,false);
    assert.match(v.host.innerHTML,/data-listening-action="pause">/);assert.doesNotMatch(v.host.innerHTML,/data-listening-action="pause" disabled/);
    const paused=v.c.flush();assert.equal(v.audios[0].paused,true,'native audio stops before server response');
    await release();assert.equal(await paused,true);assert.equal(f.saved.state,'paused');assert.equal(f.saved.position_ms,3000);
  } finally {if(release)await release();v.c.dispose();}
});
await check('terminal playback refusals stop audio but release navigation and finalisation without losing receipts', async () => {
  for (const error of ['mock_expired', 'mock_finalised', 'preparation_archived', 'mock_rights_blocked', 'mock_content_unavailable']) {
    const f = fixture(), v = controllerFor(f); await v.ready(); await v.play();
    f.intercept(() => ({ ok: false, status: 409, error })); v.c.freeze(true);
    assert.equal(await v.c.flush(), true, error); assert.equal(v.audios[0].paused, true);
    assert.equal(v.c.state().pending, true); assert.equal(v.c.state().playback.plays_used, 1);
    assert.equal(v.c.needsFlush, false); const calls=f.calls.length;
    assert.equal(await v.c.flush(), true); assert.equal(f.calls.length, calls, 'terminal receipt is not retried forever');
    v.c.freeze(false); assert.doesNotMatch(v.host.innerHTML, /data-listening-action=/); v.c.dispose();
  }
});
await check('obsolete flush never borrows terminal success from a newly mounted run', async () => {
  for(const pendingFirst of [false,true]) {
    const f=fixture(),v=controllerFor(f);await v.ready();await v.play();
    if(pendingFirst){f.intercept(()=>({ok:false,status:0,error:'network'}));assert.equal(await v.c.flush(),false);}
    let release;f.intercept(()=>new Promise(resolve=>{release=resolve;}));
    const old=v.c.flush();await tick();v.c.dispose();
    f.api.mock.playback=async()=>({ok:false,status:409,error:'mock_expired'});
    v.c.mount(v.host,{...run,id:'new-expired-run'},descriptor);await tick();
    release({ok:false,status:409,error:'mock_expired'});
    assert.equal(await old,false);assert.equal(v.c.state().runId,'new-expired-run');v.c.dispose();
  }
});
await check('unknown or retryable pause failures still block navigation with the exact pending receipt', async () => {
  for (const failure of [{status:0,error:'network'},{status:409,error:'playback_conflict'},{status:0,error:'mock_expired'}]) {
    const f=fixture(),v=controllerFor(f);await v.ready();await v.play();
    f.intercept(()=>({ok:false,...failure}));assert.equal(await v.c.flush(),false);assert.equal(v.c.needsFlush,true);
    assert.equal(await v.c.flush(),false);assert.deepEqual(f.calls[1],f.calls[2]);v.c.dispose();
  }
});

await check('unexpected native pause saves progress and native rate/backward seek are corrected', async () => {
  const f = fixture(), v = controllerFor(f); await v.ready(); await v.play(); const a = v.audios[0]; a.currentTime = 4; a.dispatchEvent(new Event('timeupdate'));
  a.currentTime = 1; a.dispatchEvent(new Event('seeking')); assert.equal(a.currentTime, 4);
  a.playbackRate = 2; a.dispatchEvent(new Event('ratechange')); assert.equal(a.playbackRate, 1);
  a.pause(); await tick(); assert.equal(f.saved.state, 'paused'); assert.equal(f.saved.position_ms, 4000); v.c.dispose();
});
await check('German recovery states distinguish missing acknowledgement, rights and expiry', async () => {
  assert.match(listeningMessage({ error: { status: 0, error: 'network' }, pending: true }), /denselben Vorgang/);
  assert.match(listeningMessage({ error: { error: 'media_integrity' } }), /nicht verfügbar/);
  assert.match(listeningMessage({ error: { error: 'mock_expired' } }), /nicht mehr abgespielt/);
});

const prepA = { id: '11111111-1111-4111-8111-111111111111', state: 'active' }, prepB = { id: '22222222-2222-4222-8222-222222222222', state: 'active' };
const json = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
await check('protected blob transport carries account context and no-store without exposing media paths to views', async () => {
  const calls = [], api = createApi({ fetchImpl: async (path, init) => {
    calls.push({ path, init }); return path.includes('get-session') ? json({ user: { id: 'account-a' } })
      : { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/wav', 'content-length': '4' }), blob: async () => new Blob(['WAVE']) };
  } });
  await api.session(); api.preparations.select(prepA); const result = await api.mock.media('run', 'media.a', 'v2'); assert.equal(result.ok, true);
  const request = calls[1]; assert.equal(request.path, '/api/v1/mock-runs/run/media/media.a/v2'); assert.equal(request.init.cache, 'no-store'); assert.equal(request.init.credentials, 'same-origin'); assert.equal(request.init.headers['X-Hatoove-Account'], 'account-a');
});
await check('media bytes completing after preparation switch are refused', async () => {
  let release; const api = createApi({ fetchImpl: async path => path.includes('get-session') ? json({ user: { id: 'account-a' } })
    : { ok: true, status: 200, headers: new Headers({ 'content-type': 'audio/wav' }), blob: () => new Promise(resolve => { release = resolve; }) } });
  await api.session(); api.preparations.select(prepA); const pending = api.mock.media('run', 'media', 'v1'); await tick(); api.preparations.select(prepB); release(new Blob(['WAVE']));
  assert.equal((await pending).error, 'stale_preparation');
});
await check('media session refusal invalidates the account and later fetches stop', async () => {
  let count = 0, invalid = null; const api = createApi({ onSessionInvalid: reason => { invalid = reason; }, fetchImpl: async path => { count++; return path.includes('get-session') ? json({ user: { id: 'account-a' } }) : json({ error: 'account_changed' }, 409); } });
  await api.session(); const result = await api.mock.media('run', 'media', 'v1'); assert.equal(result.error, 'account_changed'); assert.equal(invalid, 'account_changed');
  await api.mock.media('run', 'media', 'v1'); assert.equal(count, 2);
});
console.log(`${passed} passed; synthetic client/transport evidence only, not browser or physical-device acceptance.`);
