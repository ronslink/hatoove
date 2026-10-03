import assert from 'node:assert/strict';
import * as mock from '../public/app/mock.js';
import { createListeningController, listeningMessage } from '../public/app/listening.js';
import { createWritingController } from '../public/app/writing.js';

let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log('PASS ' + name); };
await check('assigned telc finalisation includes explanation language without an A/B choice', async () => {
  let sent;
  const run = { id: 'assigned', writing_task: { section: 'writing', task: { task_id: 'telc.prompt', version: 'v1' } }, writing: { binding_kind: 'assigned', attempt_id: 'draft', draft_revision: 3 } };
  const session = { state: () => ({ run }), flush: async () => true, finalise: async body => { sent = body; return true; } };
  const writing = { active: { attempt: 'draft', revision: 3 }, flush: async () => true };
  assert.equal(await mock.finaliseMockWriting({ session, writing, language: 'uk' }), true);
  assert.deepEqual(sent, { explanationLanguage: 'uk', expectedWritingRevision: 3 });
});
const iso = n => new Date(n).toISOString(), copy = value => structuredClone(value);
const member = (section, id = section) => ({ section, set_id: id, version: 'v1', title: section + ' example', interaction: 'single_choice', item_count: 1, payload: { text: 'Synthetic passage.', questions: [{ n: 1, question: 'Synthetic question?', options: { a: 'A', b: 'B' } }] } });
const assignment = { section: 'writing', task: { task_id: 'telc.prompt', version: 'v1', topic: 'Assigned topic', situation: 'Synthetic writing situation', leitpunkte: ['One', 'Two', 'Three', 'Four'] } };
const assigned = { binding_kind: 'assigned', choice_group_id: null, selected_option_id: null, attempt_id: 'draft', draft_revision: 3, submission_id: null };
const groups = [
  { id: 'lv-sb', sections: ['LV', 'SB'], starts_at: iso(10000), deadline_at: iso(20000) },
  { id: 'hv', sections: ['HV'], starts_at: iso(20000), deadline_at: iso(30000) },
  { id: 'writing', sections: ['writing'], starts_at: iso(30000), deadline_at: iso(40000) },
];
const base = { id: 'run', revision: 1, state: 'active', scope: 'complete_supported_written', mode: 'timed', attempt_mode: 'mock', release_state: 'internal', review_status: 'unreviewed',
  server_now: iso(10000), deadline_at: iso(40000), members: [member('LV'), member('SB'), member('HV')], responses: [], position: { member: 0, item: 0 },
  writing_task: assignment, writing: assigned, writing_choices: [], timing: { policy: 'ordered-fixed-v1', active_group_id: 'wrong-stale-id', groups } };
function fixture(value = base) {
  let elapsed = 0, wall = 1000, saved = copy(value), seq = 0, intercept = null;
  const calls = [], receipts = new Map();
  const api = { mock: {
    read: async () => ({ ok: true, data: { ...copy(saved), server_now: iso(10000 + elapsed) } }),
    save: async (id, body) => {
      calls.push(copy(body));
      if (intercept) { const response = await intercept(id, body); if (response) return response; }
      if (receipts.has(body.eventId)) return copy(receipts.get(body.eventId));
      saved = { ...saved, revision: saved.revision + 1, responses: copy(body.responses), position: copy(body.position), server_now: iso(10000 + elapsed) };
      const response = { ok: true, data: copy(saved) }; receipts.set(body.eventId, response); return response;
    },
    chooseWriting: async (id, body) => { calls.push(copy(body)); saved = { ...saved, revision: saved.revision + 1, writing: { binding_kind: 'choice', choice_group_id: body.choiceGroupId, selected_option_id: body.optionId, attempt_id: 'choice-draft' } }; return { ok: true, data: copy(saved) }; },
    finalise: async (id, body) => { calls.push(copy(body)); saved = { ...saved, revision: saved.revision + 1, state: 'finalised' }; return { ok: true, data: copy(saved) }; },
  } };
  const session = mock.createMockSession({ api, eventId: () => 'event-' + ++seq, now: () => wall, elapsedNow: () => elapsed }); session.load(saved);
  return { session, api, calls, setElapsed: n => { elapsed = n; }, setWall: n => { wall = n; }, intercept: fn => { intercept = fn; }, get saved() { return saved; } };
}
await check('assigned draft can finish before opening its future editor and refuses a different editor', async () => {
  const f = fixture();
  assert.equal(await mock.finaliseMockWriting({ session: f.session, writing: { active: null, flush: async () => true }, language: 'de' }), true);
  assert.equal(f.calls[0].expectedWritingRevision, 3); assert.equal(f.calls[0].explanationLanguage, 'de');
  const g = fixture();
  assert.equal(await mock.finaliseMockWriting({ session: g.session, writing: { active: { attempt: 'other', revision: 3 }, flush: async () => true } }), false);
  assert.equal(g.calls.length, 0);
});
await check('assigned task resolution never fabricates A/B and scope labels remain distinct', () => {
  assert.deepEqual(mock.mockWritingTask(base), assignment.task);
  assert.equal(mock.mockWritingTask({ ...base, writing_task: null }), null);
  assert.equal(mock.mockScopeLabel(base), 'Schriftliche Probeprüfung');
  assert.equal(mock.mockScopeLabel({ scope: 'section' }), 'Abschnittsübung');
});
await check('time windows use their exact half-open boundaries and ignore stale active IDs', () => {
  assert.equal(mock.mockTiming(base, 9999).active, null);
  assert.equal(mock.mockTiming(base, 19999).active.id, 'lv-sb');
  assert.equal(mock.mockTiming(base, 20000).active.id, 'hv');
  assert.equal(mock.mockTiming(base, 30000).active.id, 'writing');
  assert.equal(mock.mockTiming(base, 40000).active, null);
  assert.equal(mock.mockSectionWritable(base, 'SB', 15000), true);
  assert.equal(mock.mockSectionWritable(base, 'LV', 25000), false);
});
await check('malformed, overlapping, missing and duplicate schedules fail closed', () => {
  for (const invalid of [null, {}, { policy: 'pause', groups }, { policy: 'ordered-fixed-v1', groups: [] },
    { policy: 'ordered-fixed-v1', groups: [null] }, { policy: 'ordered-fixed-v1', groups: [{ ...groups[0], sections: {} }] },
    { policy: 'ordered-fixed-v1', groups: [groups[0], { ...groups[1], starts_at: iso(19000) }] },
    { policy: 'ordered-fixed-v1', groups: [groups[0], { ...groups[1], sections: ['LV'] }] }]) {
    assert.equal(mock.mockSectionWritable({ ...base, timing: invalid }, 'LV', 11000), false);
  }
  assert.equal(mock.mockSectionWritable({ ...base, scope: 'section', timing: null }, 'LV', 999999), true);
});
await check('local wall clock jumps cannot pause, extend or skip the server-anchored schedule', () => {
  const f = fixture(); f.setWall(-1e12); f.setElapsed(9500);
  assert.equal(f.session.now(), 19500); assert.equal(f.session.sectionWritable('LV'), true);
  f.setWall(1e12); assert.equal(f.session.now(), 19500);
  f.setElapsed(10000); assert.equal(f.session.sectionWritable('LV'), false); assert.equal(f.session.sectionWritable('HV'), true);
});
await check('a delayed same-run reload cannot rewind the running clock', async () => {
  const f = fixture(); f.setElapsed(12000);
  f.api.mock.read = async () => ({ ok: true, data: copy(base) });
  assert.equal(await f.session.reload({ preserveClean: false }), true);
  assert.equal(f.session.now(), 22000); assert.equal(f.session.sectionWritable('HV'), true);
});
await check('only active group answers change, while a boundary preserves the unsent snapshot', async () => {
  const f = fixture();
  assert.equal(f.session.answer(base.members[2], '1', 'a'), false);
  assert.equal(f.session.answer(base.members[0], '1', 'b'), true);
  f.setElapsed(10001);
  assert.equal(f.session.answer(base.members[0], '1', null), false);
  assert.equal(await f.session.flush(), false); assert.equal(f.calls.length, 0);
  assert.equal(f.session.state().error.error, 'mock_group_inactive');
  assert.equal(await f.session.reload({ preserveClean: false }), true);
  assert.match(f.session.state().localCopy, /"answer": "b"/); assert.deepEqual(f.session.state().responses, []);
  assert.equal(f.session.answer(base.members[2], '1', 'a'), true); assert.equal(await f.session.flush(), true);
});
await check('later recovery copies do not overwrite earlier unconfirmed work', async () => {
  const f = fixture(); f.session.answer(base.members[0], '1', 'b'); f.setElapsed(10001); await f.session.reload({ preserveClean: false });
  f.session.answer(base.members[2], '1', 'a'); f.setElapsed(20001); await f.session.reload({ preserveClean: false });
  assert.match(f.session.state().localCopy, /"setId": "LV"/); assert.match(f.session.state().localCopy, /"setId": "HV"/);
  assert.equal(f.session.sectionWritable('writing'), true);
});
await check('lost save acknowledgement retries the same receipt across the boundary without restarting time', async () => {
  const f = fixture(); let lost = true;
  f.intercept(async () => lost ? { ok: false, status: 0, error: 'network' } : null);
  f.session.answer(base.members[0], '1', 'a'); assert.equal(await f.session.flush(), false);
  f.setElapsed(10001); lost = false; assert.equal(await f.session.flush(), true);
  assert.deepEqual(f.calls[0], f.calls[1]); assert.equal(f.session.sectionWritable('LV'), false);
});
await check('an obsolete boundary read cannot replace a newly loaded run', async () => {
  const f = fixture(); let release;
  f.api.mock.read = () => new Promise(resolve => { release = resolve; });
  const loading = f.session.reload(); f.session.load({ ...base, id: 'new-run' });
  release({ ok: true, data: base }); assert.equal(await loading, false); assert.equal(f.session.state().run.id, 'new-run');
});
await check('DTZ writing choice follows its SA section and assigned writing cannot be replaced', async () => {
  const dtz = { ...base, writing_task: null, writing: null, writing_choices: [{ id: 'SA1', section: 'SA', options: [{ id: 'A' }, { id: 'B' }] }],
    timing: { policy: 'ordered-fixed-v1', groups: [groups[0], groups[1], { ...groups[2], sections: ['SA'] }] } };
  const f = fixture(dtz); assert.equal(mock.mockWritingSection(dtz), 'SA'); assert.equal(await f.session.chooseWriting('SA1', 'A'), false);
  f.setElapsed(20001); assert.equal(await f.session.chooseWriting('SA1', 'B'), true); assert.equal(f.calls.length, 1);
  assert.equal(await fixture().session.chooseWriting('SA1', 'A'), false);
});

class FakeAudio extends EventTarget {
  currentTime = 0; playbackRate = 1; paused = true;
  pause() { this.paused = true; } load() {} removeAttribute() {} setAttribute() {} remove() {}
}
await check('authoritative group-end audio refusal releases navigation without confirming lost progress', async () => {
  const descriptor = { media_id: 'clip', media_version: 'v1', max_plays: 1, duration_ms: 10000, label: 'Synthetic' };
  const playback = { ...descriptor, revision: 1, state: 'playing', plays_used: 1, position_ms: 1000, playback_id: 'play', uncertain: false };
  for (const status of [409, 0]) {
    const sent = [], controller = createListeningController({ esc: String, createAudio: () => new FakeAudio(), api: { mock: {
      playback: async () => ({ ok: true, data: { items: [playback] } }), playbackEvent: async (id, body) => { sent.push(body); return { ok: false, status, error: 'mock_group_inactive' }; },
    } } });
    controller.mount({ innerHTML: '', querySelector: () => null }, base, descriptor); await new Promise(resolve => setImmediate(resolve));
    assert.equal(await controller.flush(), status === 409); assert.equal(controller.state().pending, true);
    assert.equal(controller.state().playback.position_ms, 1000); assert.equal(controller.state().playback.plays_used, 1);
    if (status === 409) assert.equal(controller.needsFlush, false);
    controller.dispose();
  }
  assert.match(listeningMessage({ error: { status: 409, error: 'mock_group_inactive' } }), /nicht als gespeichert bestätigt/);
});

// A small DOM port exercises actual controller state and callbacks; browser layout is verified separately.
class NodePort extends EventTarget {
  constructor() { super(); this.children = new Map(); this.isConnected = true; this.hidden = false; this.dataset = {}; this.value = ''; this.readOnly = false; }
  set innerHTML(value) {
    this.html = value; this.children.clear();
    for (const match of value.matchAll(/<([a-z0-9]+)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
      const node = new NodePort(); node.tag = match[1]; node.parentElement = this; node.readOnly = /\breadonly\b/.test(match[0]); this.children.set('#' + match[2], node);
    }
  }
  get innerHTML() { return this.html || ''; }
  querySelector(selector) { if (this.children.has(selector)) return this.children.get(selector); for (const child of this.children.values()) { const found = child.querySelector(selector); if (found) return found; } return null; }
  querySelectorAll() { return []; } contains() { return false; } focus() {} scrollIntoView() {} remove() {} replaceChildren() { this.children.clear(); this.html = ''; }
}
const previousWindow = globalThis.window, previousDocument = globalThis.document;
globalThis.window = new EventTarget(); globalThis.document = { activeElement: null, body: { append() {} } };
try {
  await check('writing gate freezes real editor saves while exposing an exact local recovery copy', async () => {
    let allowed = true, calls = 0;
    const controller = createWritingController({ esc: String, canEdit: () => allowed, api: {
      writing: { readAttempt: async () => ({ ok: true, data: { id: 'draft', revision: 3, text: 'Acknowledged text' } }), saveDraft: async () => { calls++; return { ok: false, status: 409, error: 'mock_group_inactive' }; } },
      rubrics: { read: async () => ({ ok: true, data: { criteria: [] } }) },
    } });
    const host = new NodePort(); assert.equal(await controller.open(host, assignment.task, { attached: true, attemptId: 'draft' }), true);
    controller.active.area.value = 'Unconfirmed learner text'; allowed = false; controller.freeze(false);
    assert.equal(controller.active.area.readOnly, true); assert.equal(await controller.flush(), false); assert.equal(calls, 0);
    assert.deepEqual(controller.localDraft, { attempt_id: 'draft', revision: 3, text: 'Unconfirmed learner text' });
    allowed = true; assert.equal(await controller.flush(), false); assert.equal(calls, 1); assert.equal(controller.active.area.value, 'Unconfirmed learner text');
    assert.equal(controller.active.error, 'mock_group_inactive'); controller.dispose();
  });
  await check('rendered assigned editor is direct, future-readonly and writable in its exact window', async () => {
    let value = { ...copy(base), server_now: iso(Date.now()), deadline_at: iso(Date.now() + 60000), timing: { policy: 'ordered-fixed-v1', groups: [{ id: 'write-now', sections: ['writing'], starts_at: iso(Date.now() - 1000), deadline_at: iso(Date.now() + 60000) }] } };
    const api = { mock: { read: async () => ({ ok: true, data: copy(value) }) }, writing: { readAttempt: async () => ({ ok: true, data: { id: 'draft', revision: 3, text: 'Saved draft' } }) }, rubrics: { read: async () => ({ ok: true, data: { criteria: [] } }) } };
    const host = new NodePort(), controller = mock.createMockController({ api, esc: String });
    assert.equal(await controller.showRun(host, value.id), true); await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.querySelector('#mock-writing-binding').textContent, 'Zugewiesene Schreibaufgabe');
    assert.equal(host.querySelector('#writing-text').readOnly, false);
    assert.ok(!host.querySelector('#mock-writing-host').innerHTML.includes('data-mock-choice-option'));
    assert.match(host.querySelector('#mock-content').innerHTML, /Schriftliche Probeprüfung/);
    const instant = Date.now(); value = { ...value, id: 'future-run', server_now: iso(instant), timing: { policy: 'ordered-fixed-v1', groups: [
      { id: 'read-now', sections: ['LV', 'SB', 'HV'], starts_at: iso(instant - 1000), deadline_at: iso(instant + 30000) },
      { id: 'write-later', sections: ['writing'], starts_at: iso(instant + 30000), deadline_at: iso(instant + 60000) },
    ] } };
    await controller.showRun(host, value.id);
    await host.onclick({ target: { closest: () => ({ dataset: { mockGroup: 'write-later' } }) } });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(host.querySelector('#writing-text').readOnly, true);
    assert.match(host.querySelector('#mock-writing-binding').textContent, /außerhalb der Schreibzeit/);
    assert.match(host.querySelector('#mock-content').innerHTML, /data-mock-group="read-now" aria-current="step"/); controller.dispose();
  });
  await check('malformed schedule renders a closed editor gate without crashing the workspace', async () => {
    const value = { ...copy(base), server_now: iso(Date.now()), timing: { policy: 'ordered-fixed-v1', groups: [null] } };
    const host = new NodePort(), controller = mock.createMockController({ esc: String, api: { mock: { read: async () => ({ ok: true, data: value }) } } });
    assert.equal(await controller.showRun(host, value.id), true);
    assert.match(host.querySelector('#mock-content').innerHTML, /Zeitplan konnte nicht geprüft werden/);
    assert.match(host.querySelector('#mock-content').innerHTML, /fieldset class="mock-options" disabled/); controller.dispose();
  });
  await check('actual boundary controller keeps unsaved answers, selects next workspace and blocks leaving until copy acknowledgment', async () => {
    const start = Date.now(), value = { ...copy(base), writing_task: null, writing: null, server_now: iso(start), deadline_at: iso(start + 60000), timing: { policy: 'ordered-fixed-v1', groups: [
      { id: 'before', sections: ['LV', 'SB'], starts_at: iso(start - 1000), deadline_at: iso(start + 70) },
      { id: 'after', sections: ['HV'], starts_at: iso(start + 70), deadline_at: iso(start + 60000) },
    ] } };
    let reads = 0;
    const api = { mock: { read: async () => { reads++; return { ok: true, data: { ...copy(value), server_now: iso(Date.now()) } }; } } };
    const host = new NodePort(), controller = mock.createMockController({ api, esc: String });
    await controller.showRun(host, value.id);
    host.onchange({ target: { matches: () => true, value: 'b' } });
    await new Promise(resolve => setTimeout(resolve, 330));
    assert.ok(reads >= 2); assert.match(host.querySelector('#mock-content').innerHTML, /HV example/);
    assert.match(host.querySelector('#mock-content').innerHTML, /"answer": "b"/);
    assert.match(host.querySelector('#mock-footer').innerHTML, /ack-copy/);
    assert.equal(await controller.flush(), false);
    await host.onclick({ target: { closest: () => ({ dataset: { mockAction: 'ack-copy' } }) } });
    assert.equal(await controller.flush(), true); controller.dispose();
  });
  await check('writing expiry keeps an unsaved text copy before reopening the acknowledged readonly draft', async () => {
    const start = Date.now(), value = { ...copy(base), server_now: iso(start), deadline_at: iso(start + 70), timing: { policy: 'ordered-fixed-v1', groups: [
      { id: 'writing-end', sections: ['writing'], starts_at: iso(start - 1000), deadline_at: iso(start + 70) },
    ] } };
    let saves = 0;
    const api = { mock: { read: async () => ({ ok: true, data: { ...copy(value), server_now: iso(Date.now()) } }) },
      writing: { readAttempt: async () => ({ ok: true, data: { id: 'draft', revision: 3, text: 'Acknowledged text' } }), saveDraft: async () => { saves++; return { ok: false, status: 409, error: 'mock_group_inactive' }; } },
      rubrics: { read: async () => ({ ok: true, data: { criteria: [] } }) },
    };
    const host = new NodePort(), controller = mock.createMockController({ api, esc: String });
    await controller.showRun(host, value.id); await new Promise(resolve => setImmediate(resolve));
    const area = host.querySelector('#writing-text'); area.value = 'Exact unconfirmed text at the boundary'; area.dispatchEvent(new Event('input'));
    await new Promise(resolve => setTimeout(resolve, 330));
    assert.equal(saves, 0); assert.equal(host.querySelector('#writing-text').value, 'Acknowledged text');
    assert.equal(host.querySelector('#writing-text').readOnly, true);
    assert.match(host.querySelector('#mock-footer').innerHTML, /Exact unconfirmed text at the boundary/);
    assert.match(host.querySelector('#mock-footer').innerHTML, /data-mock-draft-copy/);
    assert.equal(await controller.flush(), false); controller.dispose();
  });
  await check('unknown audio boundary receipt survives until authoritative retry before switching workspace', async () => {
    const start = Date.now(), recording = { id: 'r', media_id: 'clip', media_version: 'v1', max_plays: 1, duration_ms: 10000, label: 'Signal' };
    const audio = { ...member('HV', 'audio'), interaction: 'fixed_audio', recordings: [recording], payload: { recordings: [{ id: 'r', mediaId: 'clip', mediaVersion: 'v1', label: 'Signal', questions: [{ n: 1, question: 'Q', options: { a: 'A', b: 'B' } }] }] } };
    const value = { ...copy(base), writing: null, writing_task: null, writing_choices: [], members: [audio, member('LV', 'read')], server_now: iso(start), deadline_at: iso(start + 60000), timing: { policy: 'ordered-fixed-v1', groups: [
      { id: 'h', sections: ['HV'], starts_at: iso(start - 1000), deadline_at: iso(start + 80) },
      { id: 'r', sections: ['LV'], starts_at: iso(start + 80), deadline_at: iso(start + 60000) },
    ] } };
    const calls = []; let terminal = false;
    const api = { mock: {
      read: async () => ({ ok: true, data: { ...copy(value), server_now: iso(Date.now()) } }),
      playback: async () => ({ ok: true, data: { items: [{ ...recording, revision: 1, state: 'playing', plays_used: 1, position_ms: 1000, playback_id: 'pid', uncertain: false }] } }),
      playbackEvent: async (id, body) => { calls.push(copy(body)); return { ok: false, status: terminal ? 409 : 0, error: terminal ? 'mock_group_inactive' : 'network' }; },
    } };
    const controller = mock.createMockController({ api, esc: String }), host = new NodePort();
    try {
      await controller.showRun(host, 'run'); await new Promise(resolve => setTimeout(resolve, 360));
      assert.equal(calls.length, 1); assert.match(host.querySelector('#mock-content').innerHTML, /Hörstand abgleichen/);
      assert.equal(await controller.flush(), false); assert.deepEqual(calls[0], calls[1]);
      terminal = true;
      await host.onclick({ target: { closest: () => ({ dataset: { mockAction: 'reload' } }) } });
      assert.deepEqual(calls[0], calls[2]); assert.match(host.querySelector('#mock-content').innerHTML, /LV example/);
      assert.equal(await controller.flush(), true);
    } finally { controller.dispose(); }
  });
} finally { globalThis.window = previousWindow; globalThis.document = previousDocument; }
console.log(`EXAM-S5B client: ${passed} checks passed; synthetic controller/transport evidence only.`);
