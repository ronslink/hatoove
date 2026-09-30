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
  if (typeof fetch !== 'function') return false;
  state.updatedAt = Date.now();
  try {
    const res = await fetch('/api/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ state }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    // The server merges every write. If it recovered anything we were missing - another
    // tab having saved meanwhile, say - fold it in. Merging rather than replacing keeps
    // any answer made while this request was in flight.
    if (data.state) {
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('/api/progress', { signal: controller.signal });
    const data = await res.json();
    if (!data.found || !data.state) {
      const hasLocal = (state.counters?.attempts || 0) > 0 || Object.keys(state.nodes || {}).length > 0;
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

export function resetAll() {
  state = freshState();
  invalidateAbilityCache();
  saveNow();
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

export function clearErrors() {
  state.errors = [];
  saveNow();
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
