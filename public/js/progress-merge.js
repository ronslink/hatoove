/**
 * Monotonic merge for learner progress.
 *
 * Why this exists: saves are debounced and can come from more than one tab. With a
 * plain last-write-wins overwrite, a tab holding a slightly older in-memory snapshot
 * can flush *after* a tab that has already saved newer answers, silently discarding
 * them. That happened for real: a later save carried 68 fewer attempts than the one
 * before it.
 *
 * So every write merges instead of replacing, and the merge is monotonic - the result
 * never contains less evidence than either input. Used by the server (on write) and by
 * the browser (on the response), so both sides converge on the same state.
 *
 * This module is deliberately free of any browser or Node API so both can import it.
 */

const MAX_HISTORY = 4000;
const MAX_ERRORS = 400;

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

function withDefaults(s) {
  return {
    version: num(s?.version) || 1,
    createdAt: num(s?.createdAt) || Date.now(),
    updatedAt: num(s?.updatedAt),
    settings: s?.settings && typeof s.settings === 'object' ? s.settings : {},
    nodes: s?.nodes && typeof s.settings === 'object' ? s.nodes : s?.nodes || {},
    history: Array.isArray(s?.history) ? s.history : [],
    errors: Array.isArray(s?.errors) ? s.errors : [],
    srs: s?.srs && typeof s.srs === 'object' ? s.srs : {},
    days: s?.days && typeof s.days === 'object' ? s.days : {},
    planDone: s?.planDone && typeof s.planDone === 'object' ? s.planDone : {},
    counters: s?.counters && typeof s.counters === 'object' ? s.counters : {},
  };
}

/**
 * Merge two progress states. `a` and `b` are interchangeable for the data fields;
 * settings are taken from whichever state is newer.
 */
export function mergeProgress(a, b) {
  if (!a) return b;
  if (!b) return a;
  const A = withDefaults(a);
  const B = withDefaults(b);
  const bIsNewer = B.updatedAt >= A.updatedAt;
  const newer = bIsNewer ? B : A;
  const older = bIsNewer ? A : B;

  const out = {
    version: Math.max(A.version, B.version) || 1,
    // The earlier creation time is the true one.
    createdAt: Math.min(A.createdAt, B.createdAt) || Date.now(),
    updatedAt: Math.max(A.updatedAt, B.updatedAt),
    settings: { ...older.settings, ...newer.settings },
  };

  // Counters only ever grow, so the maximum is the safest estimate. It can undercount
  // if two tabs counted independently, but it can never lose work.
  const counters = {};
  for (const k of ['attempts', 'correct', 'aiCalls', 'aiFailures']) {
    counters[k] = Math.max(num(A.counters[k]), num(B.counters[k]));
  }
  counters.lastAiError = newer.counters.lastAiError || older.counters.lastAiError || '';
  out.counters = counters;

  // Ability estimates: keep the one backed by more evidence.
  const nodes = {};
  const nodeIds = new Set([...Object.keys(A.nodes), ...Object.keys(B.nodes)]);
  for (const id of nodeIds) {
    const na = A.nodes[id];
    const nb = B.nodes[id];
    if (!na) { nodes[id] = nb; continue; }
    if (!nb) { nodes[id] = na; continue; }
    nodes[id] = num(nb.n) > num(na.n) ? nb : na;
  }
  out.nodes = nodes;

  // Attempt log: multiset union.
  //
  // A part's items are all recorded in the same millisecond, so five different
  // questions can produce byte-identical entries. Deduplicating by value would
  // therefore destroy real attempts (it once turned 424 into 307). Instead, group by
  // the recorded fields and keep max(countA, countB) from each group - the union of
  // two generations of the same history, never fewer than either.
  const keyOf = (h) =>
    `${h.t}|${h.partId}|${h.difficulty}|${h.correct}|${h.source || ''}|${h.itemRef || ''}`;

  const groupOf = (list) => {
    const groups = new Map();
    for (const h of list) {
      if (!h || !Number.isFinite(Number(h.t))) continue;
      const k = keyOf(h);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(h);
    }
    return groups;
  };

  const ga = groupOf(A.history);
  const gb = groupOf(B.history);
  const history = [];
  for (const key of new Set([...ga.keys(), ...gb.keys()])) {
    const la = ga.get(key) || [];
    const lb = gb.get(key) || [];
    const keep = Math.max(la.length, lb.length);
    const from = lb.length >= la.length ? lb : la;
    for (let i = 0; i < keep; i++) history.push(from[i]);
  }
  history.sort((x, y) => num(x.t) - num(y.t));
  out.history = history.length > MAX_HISTORY ? history.slice(-MAX_HISTORY) : history;

  // Error notebook: ids are unique, so a union loses nothing.
  const byId = new Map();
  for (const e of [...A.errors, ...B.errors]) {
    if (!e || !e.id) continue;
    const prev = byId.get(e.id);
    // Prefer a resolved entry over an open duplicate.
    if (!prev || (!prev.resolved && e.resolved)) byId.set(e.id, e);
  }
  out.errors = [...byId.values()].sort((x, y) => num(y.t) - num(x.t)).slice(0, MAX_ERRORS);

  // Spaced repetition: keep whichever card has been reviewed more.
  const srs = {};
  for (const id of new Set([...Object.keys(A.srs), ...Object.keys(B.srs)])) {
    const sa = A.srs[id];
    const sb = B.srs[id];
    if (!sa) { srs[id] = sb; continue; }
    if (!sb) { srs[id] = sa; continue; }
    srs[id] = num(sb.reps) > num(sa.reps) ? sb : sa;
  }
  out.srs = srs;

  // Daily activity: per-day maxima keep the heatmap and streak monotonic.
  const days = {};
  for (const k of new Set([...Object.keys(A.days), ...Object.keys(B.days)])) {
    const da = A.days[k] || {};
    const db = B.days[k] || {};
    const byPart = {};
    for (const p of new Set([...Object.keys(da.byPart || {}), ...Object.keys(db.byPart || {})])) {
      byPart[p] = Math.max(num(da.byPart?.[p]), num(db.byPart?.[p]));
    }
    days[k] = {
      attempts: Math.max(num(da.attempts), num(db.attempts)),
      correct: Math.max(num(da.correct), num(db.correct)),
      ms: Math.max(num(da.ms), num(db.ms)),
      byPart,
    };
  }
  out.days = days;

  // Ticked-off plan tasks: a union, so a tick is never lost to a merge.
  const planDone = {};
  for (const day of new Set([...Object.keys(A.planDone), ...Object.keys(B.planDone)])) {
    const da = A.planDone[day] || {};
    const db = B.planDone[day] || {};
    const merged = {};
    for (const key of new Set([...Object.keys(da), ...Object.keys(db)])) {
      // A tick wins; only an explicit false on both sides clears it.
      merged[key] = Boolean(da[key] || db[key]);
    }
    planDone[day] = merged;
  }
  out.planDone = planDone;

  return out;
}

/**
 * Rebuild `value` with every object's keys in sorted order, so two records that differ
 * only in key insertion order serialise identically. Arrays keep their order (order is
 * meaningful there) and primitives are returned untouched, so JSON.stringify below still
 * applies exactly the same value semantics as before - only key order, which carries no
 * meaning, is normalised.
 */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/**
 * True when two progress records are logically equal, regardless of key order - used to
 * skip redundant response payloads.
 *
 * This is deliberately a *canonical* comparison, not a raw `JSON.stringify(a) ===
 * JSON.stringify(b)`. `mergeProgress` emits its fields in a different order than the
 * state it is given (`counters` precedes `nodes`), so the raw comparison was false even
 * for logically identical records. That made the one question this function exists to
 * answer - "did the merge change anything?" - unanswerable, so `server.js` shipped a full
 * merged state on every POST. Comparing a stable key-ordered serialisation keeps every
 * existing call site unchanged and answers the question for every caller.
 *
 * It is a real comparison, not a constant: a changed counter, a changed or added or
 * removed key still compares unequal, and it is symmetric
 * (`progressEqual(a, b) === progressEqual(b, a)`).
 */
export function progressEqual(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
  } catch {
    return false;
  }
}
