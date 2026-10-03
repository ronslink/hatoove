/** Bounded database readiness; owns one dedicated, restricted PostgreSQL pool. */
export const READINESS_TIMEOUT_MS = 1500;
export const READINESS_CACHE_MS = 250;

const unavailable = () => ({ ready: false, reason: 'database_unavailable' });

export function createDatabaseReadiness({
  pool, timeoutMs = READINESS_TIMEOUT_MS, cacheMs = READINESS_CACHE_MS, now = Date.now,
} = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('readiness requires a pool');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(cacheMs) || cacheMs < 0) {
    throw new TypeError('invalid readiness bounds');
  }
  // Configure the dedicated pool before its first connection. pg bounds both queued acquisition
  // and TCP connection establishment; query_timeout also closes a stalled connection in pg 8.23.
  Object.assign(pool.options, {
    max: 1, connectionTimeoutMillis: timeoutMs, query_timeout: timeoutMs, statement_timeout: timeoutMs,
  });
  let cached = null;
  let expiresAt = 0;
  let pending = null;
  let closed = false;
  const remember = (value) => {
    cached = value;
    expiresAt = now() + cacheMs;
    return value;
  };
  const poolError = () => { remember(unavailable()); };
  pool.on('error', poolError);

  function check() {
    if (closed) return Promise.resolve(unavailable());
    // Keep this entry until acquisition/query actually settles, even after the HTTP deadline.
    // A broken driver or hung connect can therefore leave at most ONE outstanding operation.
    if (pending) return pending.response;
    if (cached && now() < expiresAt) return Promise.resolve({ ...cached });

    const state = { expired: false, client: null, timer: null, response: null, finish: null };
    state.response = new Promise((resolve) => { state.finish = resolve; });
    pending = state;
    const release = (destroy) => {
      const client = state.client;
      state.client = null;
      if (client) client.release(destroy);
    };
    const expire = () => {
      state.expired = true;
      release(true);
      state.finish(remember(unavailable()));
    };
    state.expire = expire;
    state.timer = setTimeout(expire, timeoutMs);

    // The rejection handler stays attached after timeout, including a late connection failure.
    Promise.resolve().then(async () => {
      state.client = await pool.connect();
      if (state.expired || closed) { release(true); return unavailable(); }
      try {
        await state.client.query({ text: 'SELECT 1', query_timeout: timeoutMs });
        return { ready: true, reason: 'ready' };
      } catch {
        release(true);
        return unavailable();
      } finally {
        release(state.expired || closed);
      }
    }).catch(() => unavailable()).then((value) => {
      clearTimeout(state.timer);
      if (!state.expired && !closed) state.finish(remember(value));
      if (pending === state) pending = null;
    });
    return state.response;
  }

  async function close() {
    closed = true;
    if (pending) {
      clearTimeout(pending.timer);
      pending.expire();
    }
    await pool.end();
  }

  return Object.freeze({ check, close });
}
