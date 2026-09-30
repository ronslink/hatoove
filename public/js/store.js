/**
 * State, persistence and the ability model.
 *
 * Everything the app knows about the learner lives in one plain object that is
 * mirrored into localStorage. No browser API is touched at module scope, so this
 * file can also be imported by plain Node for tests.
 *
 * Ability model: per node Elo on a 0-100 scale. A node is either
 *   skill:<PART>  e.g. skill:LV3   - one per exam part
 *   tag:<tag>     e.g. tag:konnektoren
 * Every attempt updates both, which is what lets the app say "your Part 3
 * matching is fine but your dative prepositions are costing you marks".
 */

import { NODE_WEIGHTS, canonicalTag } from './blueprint.js';
import { mergeProgress } from './progress-merge.js';

const STORAGE_KEY = 'b1prep.state.v1';
// Set before a reset is sent to the server and cleared only once the server confirmed
// the deletion. If the request could not be delivered (server restarting, tab closed
// mid-reset), the next start retries it before anything is merged - merging first would
// hand the deleted record straight back, which is the failure SEC-02 fixes.
const RESET_FLAG_KEY = 'b1prep.reset.pending.v1';
const SCALE = 18;        // logistic spread in points
const START_THETA = 50;
const PRIOR_N = 4;       // pseudo-observations pulling new nodes toward START_THETA
const MAX_HISTORY = 4000;

export function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

function freshState() {
  return {
    version: 1,
    createdAt: Date.now(),
    // Bumped on every change; the server and the browser compare this to decide
    // which copy is newer at startup.
    updatedAt: 0,
    settings: {
      examDate: '',
      dailyGoal: 20,
      ttsRate: 0.95,
      autoPlay: true,
      model: 'deepseek-chat',
    },
    nodes: {},
    history: [],
    errors: [],
    srs: {},
    days: {},
    // Tasks the learner has ticked off by hand, keyed by day then task. Most plan
    // tasks are detected automatically from the day's recorded work; this covers the
    // ones that cannot be (a self-graded review session leaves no attempt behind).
    planDone: {},
    counters: { attempts: 0, correct: 0, aiCalls: 0, aiFailures: 0, lastAiError: '' },
  };
}

let state = freshState();
let loaded = false;
let saveTimer = null;
let serverTimer = null;
// The POST currently in flight, if any. An explicit delete waits for it, otherwise a
// request that left before the reset could land after it and write the record back.
let inflight = null;
// SEC-05: the server revision this client last saw. It travels with every write, so the
// server can tell a write that left before a reset from one that came after it. It is
// deliberately not persisted in localStorage: `syncFromServer()` reads it before any
// upload, and a wrong guess is answered with 409 and resolved by a re-read, never by
// writing.
let serverRev = 0;
// Bumped whenever the whole state is replaced - a reset, an import, adopting the server's
// copy. A save response may only fold its answer back while the epoch it left under is
// still current; otherwise a save that was in flight across a reset would write the
// deleted record back into the browser cache. That is the single-tab F-2 race the SEC-02
// report wrongly claimed was closed.
let stateEpoch = 0;
let sync = { state: 'idle', lastSavedAt: 0, lastError: '', lastLoadedSource: null };

function storage() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function writeLocal() {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* quota or private mode: the server copy is still authoritative */
  }
}

/**
 * Fold any off-taxonomy tag nodes into their canonical ones.
 *
 * A model occasionally answers "Konnektoradverb" where the taxonomy says
 * "konnektoren". Stored verbatim, those became separate weakness nodes: the
 * evidence never accumulated, the drill could not generate items for them, and
 * they crowded the weak-point list with topics that could never be resolved.
 * Older saves already contain such nodes, so merge them on the way in.
 */
function migrateTags() {
  const remap = {};
  for (const id of Object.keys(state.nodes || {})) {
    if (!id.startsWith('tag:')) continue;
    const raw = id.slice(4);
    const canonical = canonicalTag(raw);
    if (canonical !== raw) remap[id] = `tag:${canonical}`;
  }

  let merged = 0;
  for (const [from, to] of Object.entries(remap)) {
    const src = state.nodes[from];
    if (!src) continue;
    const dst = state.nodes[to];
    if (!dst) {
      state.nodes[to] = { ...src };
    } else {
      const n = (dst.n || 0) + (src.n || 0);
      dst.theta = n ? ((dst.theta || START_THETA) * (dst.n || 0) + (src.theta || START_THETA) * (src.n || 0)) / n : dst.theta;
      dst.n = n;
      dst.correct = (dst.correct || 0) + (src.correct || 0);
      dst.last = Math.max(dst.last || 0, src.last || 0);
      dst.streak = dst.streak || 0;
    }
    delete state.nodes[from];
    merged += 1;
  }

  for (const e of state.errors || []) {
    if (Array.isArray(e.tags) && e.tags.length) e.tags = [...new Set(e.tags.map(canonicalTag))];
  }
  return merged;
}

function readResetFlag() {
  const s = storage();
  if (!s) return false;
  try {
    return s.getItem(RESET_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}

function writeResetFlag() {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(RESET_FLAG_KEY, '1');
  } catch {
    /* private mode or quota: the delete itself still runs */
  }
}

function clearResetFlag() {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(RESET_FLAG_KEY);
  } catch {
    /* nothing to clear */
  }
}

export function load() {
  if (loaded) return state;
  loaded = true;
  const s = storage();
  if (!s) return state;
  try {
    const raw = s.getItem(STORAGE_KEY);
    if (!raw) return state;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      state = { ...freshState(), ...parsed };
      state.settings = { ...freshState().settings, ...(parsed.settings || {}) };
      state.counters = { ...freshState().counters, ...(parsed.counters || {}) };
      migrateTags();
      invalidateAbilityCache();
    }
  } catch {
    /* corrupt state: start clean rather than crash */
  }
  return state;
}

export function getState() {
  return load();
}

/* ------------------------------------------------------- durable persistence */

export function syncStatus() {
  return { ...sync };
}

/**
 * Push the current state to the server, which keeps it in progress.json.
 * localStorage alone is not durable: it dies with site data, a different browser,
 * or a changed port.
 */
export async function flushToServer() {
  const run = sendProgress();
  inflight = run;
  try {
    return await run;
  } finally {
    if (inflight === run) inflight = null;
  }
}

/**
 * Resolve a 409: the server refused a write because a reset (or notebook clear) moved the
 * revision past it. Re-read and adopt the server's record, which is now authoritative.
 * A full reset leaves nothing to adopt, so the pre-delete copy in this browser is dropped
 * rather than re-uploaded - re-uploading it would be exactly the resurrection the
 * revision exists to prevent.
 */
async function adoptServerAfterConflict() {
  try {
    const res = await fetch('/api/progress');
    const data = await res.json();
    if (Number.isFinite(Number(data.rev))) serverRev = Number(data.rev);
    if (data.found && data.state) {
      state = { ...freshState(), ...data.state };
      state.settings = { ...freshState().settings, ...(data.state.settings || {}) };
      state.counters = { ...freshState().counters, ...(data.state.counters || {}) };
      migrateTags();
    } else {
      state = freshWithConfiguration();
    }
    stateEpoch += 1;
    invalidateAbilityCache();
    loaded = true;
    writeLocal();
    sync = { ...sync, state: 'saved', lastSavedAt: Date.now(), lastError: '' };
    return true;
  } catch (err) {
    sync = { ...sync, state: 'error', lastError: String(err.message || err) };
    return false;
  }
}

async function sendProgress() {
  if (typeof fetch !== 'function') return false;
  state.updatedAt = Date.now();
  // Captured before the request leaves: if either moves while it is in flight, the state
  // has been replaced (a reset) and the answer must not be folded back.
  const epoch = stateEpoch;
  const sentRev = serverRev;
  try {
    const res = await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, rev: sentRev }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 || data.code === 'stale_revision') {
      // Do not retry: retrying with the new revision would restore what the reset
      // deleted. Re-read and adopt instead.
      await adoptServerAfterConflict();
      return false;
    }
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    if (Number.isFinite(Number(data.rev))) serverRev = Number(data.rev);
    // The server merges every write. If it recovered anything we were missing - another
    // tab having saved meanwhile, say - fold it in. Merging rather than replacing keeps
    // any answer made while this request was in flight. But never fold over a state this
    // client has replaced since (a reset) or a reset that is still pending.
    if (data.state && epoch === stateEpoch && !readResetFlag()) {
      state = mergeProgress(state, data.state);
      invalidateAbilityCache();
      writeLocal();
    }
    sync = { ...sync, state: 'saved', lastSavedAt: Date.now(), lastError: '' };
    return true;
  } catch (err) {
    sync = { ...sync, state: 'error', lastError: String(err.message || err) };
    return false;
  }
}

/**
 * Delete the stored progress on the server, on purpose.
 *
 * This is the only path that removes data. Ordinary saves keep merging, because the
 * merge protects a learner whose partial write would otherwise erase a week of study.
 * @param {'all'|'errors'} scope 'all' deletes the record, 'errors' only the notebook.
 */
async function deleteServerProgress(scope = 'all') {
  if (typeof fetch !== 'function') return false;
  // Let a save that is already on its way finish first: the DELETE must be the last
  // write, or the merge it started from would put the record back.
  if (inflight) await inflight.catch(() => {});
  const query = scope === 'all' ? '' : `?scope=${encodeURIComponent(scope)}`;
  try {
    const res = await fetch(`/api/progress${query}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // The delete moved the revision, so this client now knows the post-delete value: its
    // next ordinary save carries it and is accepted, and a write that left before the
    // delete still carries the old one and is refused.
    if (Number.isFinite(Number(data.rev))) serverRev = Number(data.rev);
    sync = { ...sync, state: 'saved', lastSavedAt: Date.now(), lastError: '' };
    return true;
  } catch (err) {
    sync = { ...sync, state: 'error', lastError: String(err.message || err) };
    return false;
  }
}

function queueServerSave(delay = 1200) {
  if (typeof fetch !== 'function') return;
  if (serverTimer) clearTimeout(serverTimer);
  sync = { ...sync, state: 'pending' };
  serverTimer = setTimeout(() => {
    serverTimer = null;
    flushToServer();
  }, delay);
}

/**
 * On startup, decide whose copy wins. The newer `updatedAt` wins, which also makes
 * the one-time migration work: an existing browser-only learner has no server copy,
 * so their local state is uploaded rather than discarded.
 */
export async function syncFromServer({ timeoutMs = 5000 } = {}) {
  if (typeof fetch !== 'function') return { adopted: false, reachable: false };
  load();
  // A reset that never reached the server is applied now, before anything is merged.
  if (readResetFlag()) {
    const cleared = await deleteServerProgress('all');
    if (cleared) clearResetFlag();
    return { adopted: false, uploaded: false, reachable: cleared, resetApplied: cleared };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('/api/progress', { signal: controller.signal });
    const data = await res.json();
    if (Number.isFinite(Number(data.rev))) serverRev = Number(data.rev);
    if (!data.found || !data.state) {
      const hasLocal = (state.counters?.attempts || 0) > 0 || Object.keys(state.nodes || {}).length > 0;
      // SEC-05: a revision that has advanced with nothing stored means the record was
      // deleted on purpose. (`rev > 0` together with no record can only follow a delete.)
      // Uploading the local copy would resurrect it, so the browser copy is dropped
      // instead. Only a server that has never held a record (rev 0) may be seeded from a
      // browser-only learner - that is the one-time migration path.
      if (hasLocal && (Number(data.rev) || 0) > 0) {
        state = freshWithConfiguration();
        stateEpoch += 1;
        invalidateAbilityCache();
        loaded = true;
        writeLocal();
        sync = { ...sync, state: 'idle', lastError: '' };
        return { adopted: false, uploaded: false, reachable: true, empty: true, discardedLocal: true };
      }
      if (hasLocal) {
        const ok = await flushToServer();
        return { adopted: false, uploaded: ok, reachable: true, empty: true };
      }
      sync = { ...sync, state: 'idle' };
      return { adopted: false, uploaded: false, reachable: true, empty: true };
    }

    const serverTime = Number(data.state.updatedAt) || 0;
    const localTime = Number(state.updatedAt) || 0;
    if (serverTime > localTime) {
      state = { ...freshState(), ...data.state };
      state.settings = { ...freshState().settings, ...(data.state.settings || {}) };
      state.counters = { ...freshState().counters, ...(data.state.counters || {}) };
      const folded = migrateTags();
      stateEpoch += 1;
      invalidateAbilityCache();
      loaded = true;
      writeLocal();
      // Persist the consolidation so it is not redone on every load.
      if (folded > 0) await flushToServer();
      sync = { ...sync, state: 'saved', lastSavedAt: serverTime, lastError: '', lastLoadedSource: data.source };
      return { adopted: true, reachable: true, serverTime, localTime, source: data.source };
    }

    // Local is at least as new: make sure the server catches up.
    const ok = await flushToServer();
    return { adopted: false, uploaded: ok, reachable: true, serverTime, localTime };
  } catch (err) {
    sync = { ...sync, state: 'offline', lastError: String(err.message || err) };
    return { adopted: false, reachable: false, error: sync.lastError };
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort save when the tab is hidden or closed. */
export function flushNow() {
  if (serverTimer) {
    clearTimeout(serverTimer);
    serverTimer = null;
  }
  writeLocal();
  return flushToServer();
}

export function save() {
  state.updatedAt = Date.now();
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeLocal();
  }, 250);
  queueServerSave();
}

export function saveNow() {
  state.updatedAt = Date.now();
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeLocal();
  queueServerSave();
}

/**
 * Settings that are configuration rather than learner evidence, and therefore survive a
 * reset: the exam date plus the preferences chosen on the Einstellungen page.
 * `writingTaskIndex` is deliberately absent - it is a rotation counter that follows the
 * recorded attempts, so a reset has to return it to the start.
 */
const CONFIG_SETTINGS = ['examDate', 'dailyGoal', 'ttsRate', 'voiceName', 'autoPlay', 'aiDrills', 'model'];

/** A fresh record that keeps the settings which are configuration, not learner evidence. */
function freshWithConfiguration(from = state) {
  const configuration = {};
  for (const key of CONFIG_SETTINGS) {
    if (from?.settings && from.settings[key] !== undefined) configuration[key] = from.settings[key];
  }
  const next = freshState();
  next.settings = { ...next.settings, ...configuration };
  return next;
}

export async function resetAll() {
  // A reset must actually reset. Saves merge on purpose (see mergeProgress), so
  // "empty the state and save it" deleted nothing: the merge returned the full record
  // to both the server and this browser (audit finding F-2). So cancel the pending
  // saves and delete the server record through DELETE /api/progress instead of posting.
  //
  // SEC-05 closes the race that fix left open: the DELETE now records a revision on the
  // server, so a save that was already on the wire when the reset ran is refused (409)
  // and this client re-reads and adopts the empty record instead of resurrecting it.
  //
  // Configuration is not learner progress and keeps working: the exam date and the
  // Einstellungen preferences in CONFIG_SETTINGS, the provider key and exam date in
  // .env, and the theme in localStorage. The rotation counter is progress and is
  // cleared. Copies outside progress.json (finding F-5) are not touched - see SEC-02.md.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (serverTimer) {
    clearTimeout(serverTimer);
    serverTimer = null;
  }
  // A save may already be on the wire. Bumping the epoch before anything else means its
  // response cannot fold the record back into the state the reset is about to clear
  // (SEC-05: the single-tab race SEC-02's report claimed was closed).
  stateEpoch += 1;
  state = freshWithConfiguration();
  invalidateAbilityCache();
  loaded = true;
  writeLocal();
  writeResetFlag();
  const deleted = await deleteServerProgress('all');
  if (deleted) {
    clearResetFlag();
    // Re-assert the empty state after awaiting the in-flight save and the delete, so a
    // late write cannot leave the browser cache holding the deleted record.
    writeLocal();
  }
  return state;
}

export function exportJSON() {
  return JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
}

export function importJSON(text) {
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || typeof parsed.nodes !== 'object') {
    throw new Error('Das sieht nicht nach einer B1-Prep-Datei aus.');
  }
  // Replacing the state wholesale: a save already in flight must not fold over the import.
  stateEpoch += 1;
  state = { ...freshState(), ...parsed };
  state.settings = { ...freshState().settings, ...(parsed.settings || {}) };
  migrateTags();
  invalidateAbilityCache();
  saveNow();
  return state;
}

/* ------------------------------------------------------------ ability model */

function expectedScore(theta, difficulty) {
  return 1 / (1 + Math.pow(10, (difficulty - theta) / SCALE));
}

export function nodeOf(id) {
  return state.nodes[id] || null;
}

export function thetaOf(id) {
  const n = state.nodes[id];
  return n ? n.theta : START_THETA;
}

/* --------------------------------------- ability estimate from the raw evidence */

// The live Elo update is cheap and gives recency, but it is path-dependent: a lucky
// start inflates the estimate, and the update is asymmetric enough that it never
// settles back. Measured against the recorded attempts it had drifted badly - it put
// HV1 at 84 when 70% correct implies 65, and SB2 at 43 when 45% correct implies 57.
// So the estimate used for the forecast and for prioritising is the maximum-likelihood
// value over the attempts actually recorded, which is what the data supports.
let mleCache = new Map();
let mleCacheStamp = -1;
// Bumped whenever the state changes. Keying this cache on history.length was wrong:
// replacing the history with a different set of the same length returned stale
// estimates, which the calibration tests caught.
let stateStamp = 0;

function invalidateAbilityCache() {
  stateStamp += 1;
}

function rowsForNode(nodeId) {
  const history = state.history;
  if (nodeId.startsWith('skill:')) {
    const partId = nodeId.slice('skill:'.length);
    return history.filter((e) => e.partId === partId);
  }
  if (nodeId.startsWith('tag:')) {
    const tag = nodeId.slice('tag:'.length);
    return history.filter((e) => Array.isArray(e.tags) && e.tags.includes(tag));
  }
  return [];
}

function logLikelihood(rows, theta) {
  let ll = 0;
  for (const r of rows) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, expectedScore(theta, r.difficulty)));
    ll += r.correct ? Math.log(p) : Math.log(1 - p);
  }
  return ll;
}

/**
 * Ability that best explains a node's recorded attempts.
 * Returns null when there is nothing to go on, so callers fall back to the prior.
 */
export function mleAbility(nodeId) {
  load();
  if (mleCacheStamp !== stateStamp) {
    mleCache = new Map();
    mleCacheStamp = stateStamp;
  }
  if (mleCache.has(nodeId)) return mleCache.get(nodeId);

  const rows = rowsForNode(nodeId);
  let result = null;
  if (rows.length) {
    // Coarse sweep, then refine around the best value. Monotone enough that this
    // cannot settle in a local optimum.
    let best = START_THETA;
    let bestLL = -Infinity;
    for (let t = 1; t <= 99; t += 2) {
      const ll = logLikelihood(rows, t);
      if (ll > bestLL) {
        bestLL = ll;
        best = t;
      }
    }
    for (let t = Math.max(1, best - 2); t <= Math.min(99, best + 2); t += 0.25) {
      const ll = logLikelihood(rows, t);
      if (ll > bestLL) {
        bestLL = ll;
        best = t;
      }
    }
    result = { theta: best, n: rows.length };
  }
  mleCache.set(nodeId, result);
  return result;
}

/** Shrunk toward the prior, so a handful of answers does not read as mastery. */
export function masteryOf(id) {
  const mle = mleAbility(id);
  const node = state.nodes[id];
  const n = mle ? mle.n : node?.n || 0;
  const theta = mle ? mle.theta : node?.theta ?? START_THETA;
  return (theta * n + START_THETA * PRIOR_N) / (n + PRIOR_N);
}

export function confidenceOf(id) {
  const mle = mleAbility(id);
  const n = mle ? mle.n : (state.nodes[id]?.n || 0);
  if (!n) return 0;
  return n / (n + PRIOR_N);
}

function touchNode(id, difficulty, correct, kBase) {
  let n = state.nodes[id];
  if (!n) {
    n = state.nodes[id] = { theta: START_THETA, n: 0, correct: 0, last: 0, streak: 0, kBase };
  }
  const expected = expectedScore(n.theta, difficulty);
  const k = Math.max(5, (kBase || 30) / (1 + n.n / 12));
  n.theta = clamp(n.theta + k * ((correct ? 1 : 0) - expected), 1, 99);
  n.n += 1;
  if (correct) n.correct += 1;
  n.streak = correct ? (n.streak || 0) + 1 : 0;
  n.last = Date.now();
  return expected;
}

/**
 * Record one graded attempt.
 * @param {object} a
 * @param {string} a.partId      e.g. 'LV3'
 * @param {string[]} a.tags      weakness taxonomy tags
 * @param {number} a.difficulty  0-100 estimated item difficulty
 * @param {boolean} a.correct
 * @param {object} [a.detail]    stored in the error notebook when wrong
 */
export function recordAttempt(a) {
  load();
  const partId = a.partId || null;
  // Canonicalise here: every attempt from every view funnels through this function,
  // so this is the one place that guarantees the taxonomy stays intact.
  const tags = [...new Set((Array.isArray(a.tags) ? a.tags : []).filter(Boolean).map(canonicalTag))];
  const difficulty = Number.isFinite(a.difficulty) ? clamp(a.difficulty, 1, 99) : 55;

  if (partId) touchNode(`skill:${partId}`, difficulty, a.correct, 34);
  for (const t of tags) touchNode(`tag:${t}`, difficulty, a.correct, 26);

  state.counters.attempts += 1;
  if (a.correct) state.counters.correct += 1;

  const entry = {
    t: Date.now(),
    partId,
    tags,
    difficulty,
    correct: Boolean(a.correct),
    source: a.source || 'drill',
    ms: a.ms || 0,
    // Which item this was. A part's items are all logged in the same millisecond, so
    // without this they are indistinguishable and a merge cannot tell them apart.
    itemRef: a.itemRef || null,
  };
  state.history.push(entry);
  if (state.history.length > MAX_HISTORY) state.history.splice(0, state.history.length - MAX_HISTORY);
  invalidateAbilityCache();

  const day = dayKey();
  const d = state.days[day] || (state.days[day] = { attempts: 0, correct: 0, byPart: {}, ms: 0 });
  d.attempts += 1;
  if (a.correct) d.correct += 1;
  d.ms += a.ms || 0;
  if (partId) d.byPart[partId] = (d.byPart[partId] || 0) + 1;

  if (!a.correct && a.detail) addError({ ...a.detail, partId, tags, difficulty });
  save();
  return entry;
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------- prioritising */

function daysSince(ts) {
  if (!ts) return 30;
  return (Date.now() - ts) / 86400000;
}

/**
 * How much should the engine want to work on this node right now?
 * Big gap + little evidence + stale + exam-important => high.
 */
export function nodePriority(id) {
  const weight = NODE_WEIGHTS[id] ?? 1;
  const n = state.nodes[id];
  const mle = mleAbility(id);
  if ((!n || n.n === 0) && !mle) return 46 * weight;    // unexplored: worth a look, not top
  const attempts = mle ? mle.n : n.n;
  // Use the evidence-based ability, not the drifted Elo value, or the engine keeps
  // chasing topics it has already learned and neglects the ones that are actually weak.
  const gap = 100 - masteryOf(id);
  const uncertainty = 1 + 20 / (attempts + 4);          // few observations => noisy
  const stale = 1 + Math.min(0.45, daysSince(n?.last) / 25);
  const streakRelief = (n?.streak || 0) >= 4 ? 0.8 : 1; // back off once it is clearly learned
  return gap * uncertainty * stale * streakRelief * weight;
}

export function weakNodes({ limit = 8, prefix = null, minAttempts = 1 } = {}) {
  load();
  return Object.keys(state.nodes)
    .filter((id) => (prefix ? id.startsWith(prefix) : true))
    .filter((id) => (state.nodes[id].n || 0) >= minAttempts)
    .map((id) => ({ id, priority: nodePriority(id), ...state.nodes[id], mastery: masteryOf(id), confidence: confidenceOf(id) }))
    .sort((a, b) => b.priority - a.priority)
    .slice(0, limit);
}

export function weakestTags({ limit = 5 } = {}) {
  return weakNodes({ limit, prefix: 'tag:', minAttempts: 2 });
}

export function strongestTags({ limit = 5 } = {}) {
  load();
  return Object.keys(state.nodes)
    .filter((id) => id.startsWith('tag:') && state.nodes[id].n >= 3)
    .map((id) => ({ id, tag: id.slice(4), mastery: masteryOf(id), n: state.nodes[id].n }))
    .sort((a, b) => b.mastery - a.mastery)
    .slice(0, limit);
}

/** Tags never or barely practised, so the app does not tunnel-vision. */
export function unexploredTags(allTags, limit = 4) {
  load();
  return allTags
    .filter((t) => !state.nodes[`tag:${t}`] || state.nodes[`tag:${t}`].n < 2)
    .slice(0, limit);
}

/* ----------------------------------------------------------- error notebook */

export function addError(e) {
  const item = {
    id: `e${Date.now()}${Math.floor(Math.random() * 1000)}`,
    t: Date.now(),
    partId: e.partId || null,
    tags: [...new Set((e.tags || []).map(canonicalTag))],
    difficulty: e.difficulty || 55,
    prompt: String(e.prompt || '').slice(0, 1200),
    yourAnswer: String(e.yourAnswer ?? '').slice(0, 600),
    correctAnswer: String(e.correctAnswer ?? '').slice(0, 600),
    explanation: String(e.explanation || '').slice(0, 1200),
    reviewed: 0,
    resolved: false,
    source: e.source || 'drill',
  };
  // do not stack the exact same mistake repeatedly
  const dupe = state.errors.find((x) => !x.resolved && x.prompt === item.prompt && x.correctAnswer === item.correctAnswer);
  if (dupe) {
    dupe.t = item.t;
    return dupe;
  }
  state.errors.unshift(item);
  if (state.errors.length > 400) state.errors.length = 400;
  return item;
}

export function listErrors({ includeResolved = false } = {}) {
  load();
  return includeResolved ? state.errors.slice() : state.errors.filter((e) => !e.resolved);
}

export function resolveError(id) {
  const e = state.errors.find((x) => x.id === id);
  if (e) {
    e.resolved = true;
    e.reviewed = (e.reviewed || 0) + 1;
    save();
  }
  return e;
}

/**
 * Empty the error notebook for real: in this browser and in the server record.
 * Emptying only the local copy was undone by the merge on the next save, because the
 * notebook is unioned by id (audit finding F-2). The rest of the progress is kept.
 */
export async function clearErrors() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (serverTimer) {
    clearTimeout(serverTimer);
    serverTimer = null;
  }
  // Same guard as resetAll: a save still in flight carrying the notebook entries must not
  // fold them back after the notebook has been emptied.
  stateEpoch += 1;
  state.errors = [];
  invalidateAbilityCache();
  writeLocal();
  if (await deleteServerProgress('errors')) writeLocal();
}

/* ------------------------------------------------------- spaced repetition */

const SRS_STEPS = [0, 1, 3, 7, 16, 35]; // days

export function srsCard(id) {
  return state.srs[id] || null;
}

export function srsGrade(id, correct) {
  load();
  const c = state.srs[id] || (state.srs[id] = { box: 0, due: 0, reps: 0, lapses: 0 });
  c.reps += 1;
  if (correct) {
    c.box = Math.min(SRS_STEPS.length - 1, c.box + 1);
  } else {
    c.lapses += 1;
    c.box = Math.max(0, c.box - 2);
  }
  c.due = Date.now() + SRS_STEPS[c.box] * 86400000;
  save();
  return c;
}

export function srsDue(ids, limit = 50) {
  load();
  const now = Date.now();
  const out = [];
  for (const id of ids) {
    const c = state.srs[id];
    if (!c) {
      out.push({ id, card: null, overdue: Infinity });
    } else if (c.due <= now) {
      out.push({ id, card: c, overdue: now - c.due });
    }
  }
  out.sort((a, b) => b.overdue - a.overdue);
  return out.slice(0, limit);
}

/* ---------------------------------------------------------------- activity */

export function todayStats() {
  load();
  return state.days[dayKey()] || { attempts: 0, correct: 0, byPart: {}, ms: 0 };
}

/** Everything recorded on a given local day, used to detect finished plan tasks. */
export function attemptsOn(day = dayKey()) {
  load();
  return state.history.filter((e) => dayKey(e.t) === day);
}

/** Ticked-off plan tasks for a day, as a plain map of taskKey -> true. */
export function planDoneOn(day = dayKey()) {
  load();
  return state.planDone[day] || {};
}

export function setTaskDone(day, taskKey, done = true) {
  load();
  const bucket = state.planDone[day] || (state.planDone[day] = {});
  if (done) bucket[taskKey] = true;
  else delete bucket[taskKey];
  save();
  return bucket;
}

export function recentDays(n = 14) {
  load();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const key = dayKey(Date.now() - i * 86400000);
    out.push({ key, ...(state.days[key] || { attempts: 0, correct: 0, byPart: {}, ms: 0 }) });
  }
  return out;
}

export function streak() {
  load();
  let n = 0;
  for (let i = 0; i < 400; i++) {
    const key = dayKey(Date.now() - i * 86400000);
    const d = state.days[key];
    if (d && d.attempts > 0) n += 1;
    else if (i > 0) break;
  }
  return n;
}

export function accuracy(partId = null, lastN = 200) {
  load();
  const h = partId ? state.history.filter((x) => x.partId === partId) : state.history;
  const slice = h.slice(-lastN);
  if (!slice.length) return null;
  return slice.filter((x) => x.correct).length / slice.length;
}

export function noteAi(success, error) {
  load();
  if (success) state.counters.aiCalls += 1;
  else {
    state.counters.aiFailures += 1;
    state.counters.lastAiError = String(error || '').slice(0, 300);
  }
  save();
}
