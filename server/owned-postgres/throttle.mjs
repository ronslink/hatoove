/**
 * PostgreSQL throttle port for the auth seam (PILOT-18).
 *
 * The queue's item 4 measured the gap: 12 rapid registrations all accepted, 12 rapid failed sign-ins all 401
 * and no 429. This is the counter that closes it, and it is a PORT rather than a middleware inside
 * `owned-api.mjs` for the same reason sessions are: the running server and every check build the API through
 * one composition (`createPostgresWorld`), so a limit that lived in the route would be a limit the checks
 * could not inspect and the runtime could not replace.
 *
 * WHAT IS AND IS NOT LIMITED, because a rate limit pointed at the wrong resource is a way to lock people out:
 *
 *   * `signin`   — per EMAIL. Protects one account from credential stuffing. Deliberately NOT global: one
 *                  attacker hammering one address must not stop every learner in the product from signing in.
 *   * `signup`   — GLOBAL, by necessity: every registration costs a database row and a session, and that is
 *                  the operator's resource rather than a learner's. The limit is generous, because it is a
 *                  budget guard and must never read as a per-learner cap.
 *   * `password` — per USER. The change route verifies a password, so without a limit it is a password oracle
 *                  wearing a friendlier name.
 *
 * WHY NOT PER IP ADDRESS: the client's address arrives in a header that anything in front of the app can set,
 * and trusting it without a trusted-proxy configuration would let an attacker CHOOSE their bucket and walk
 * around the limit. Keying on what the request is ABOUT (an account, a user id) needs no trust in the network
 * and cannot be spoofed. Per-IP limiting belongs with the deployment's proxy decision, not here, and saying so
 * is more useful than a spoofable control that looks like protection.
 *
 * FAIL-OPEN IS DELIBERATE. An installation without this port keeps serving: a missing rate limiter must not
 * lock every learner out of the product, and the gap is then a deployment fact rather than an outage. The
 * route capability is reported (`throttleWired`) so the checks can prove the difference instead of assuming
 * it, and the runtime always wires this port.
 */

/** The policy, in one place: the limits the product ships and the names the buckets use. */
export const THROTTLE_POLICY = Object.freeze({
  signin: Object.freeze({ limit: 10, windowSeconds: 900 }),
  signup: Object.freeze({ limit: 30, windowSeconds: 3600 }),
  password: Object.freeze({ limit: 5, windowSeconds: 900 }),
  /*
   * A reset request WRITES A ROW and produces a message for the operator, so it is both a database cost and a
   * human one. Per ADDRESS rather than global: throttling every learner because one address is being abused
   * would be the same denial of service the sign-in limit is careful to avoid.
   */
  reset: Object.freeze({ limit: 5, windowSeconds: 900 }),
  /*
   * Verification requests cost a row and a message to the operator, exactly as reset requests do, and are
   * limited per ADDRESS for the same anti-lockout reason.
   */
  verify: Object.freeze({ limit: 5, windowSeconds: 900 }),
});

/**
 * How long a spent row is kept before the opportunistic sweep removes it. Comfortably longer than any window
 * above, so a sweep can never delete a counter that is still deciding anything — and short enough that the
 * table is a picture of recent attempts rather than a history of every email anyone ever typed.
 */
const KEEP_SECONDS = 86400;

/**
 * @param {{pool: object, policy?: object, keepSeconds?: number}} options `pool` must connect as the restricted
 *   `auth` role; `policy` is injectable so a check can use small limits rather than waiting out a real window.
 */
export function createPostgresThrottle({ pool, policy = THROTTLE_POLICY, keepSeconds = KEEP_SECONDS } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('createPostgresThrottle requires a pg Pool');

  const bucketFor = (kind, key) => `${kind}:${String(key)}`;

  /**
   * Count one attempt against `kind`/`key` and say whether it is allowed.
   *
   * THE WINDOW RESET AND THE INCREMENT ARE ONE STATEMENT, so two concurrent attempts cannot both read a
   * stale count and both decide they are the first: `ON CONFLICT DO UPDATE` takes the row lock, and the
   * `CASE` decides increment-versus-reset against the row's own stored window.
   *
   * @returns {Promise<{allowed: boolean, attempts: number, limit: number, retryAfterSeconds: number}>}
   */
  async function hit(kind, key) {
    const rule = policy[kind];
    if (!rule) throw new TypeError(`unknown throttle kind "${kind}"`);
    const bucket = bucketFor(kind, key);
    /*
     * EVERY PARAMETER MUST APPEAR IN THE STATEMENT. The first version passed a placeholder `null` as `$2` that
     * the SQL never used, and PostgreSQL refused the whole statement with 42P18 "could not determine data type
     * of parameter $2" — which the API correctly redacted into a 500, so the only trace was the throttle check
     * going red. Parameters are referenced exactly once each here.
     */
    const { rows } = await pool.query(
      `INSERT INTO auth_throttle(bucket, window_started_at, attempts, updated_at)
       VALUES($1, now(), 1, now())
       ON CONFLICT (bucket) DO UPDATE SET
         attempts = CASE
           WHEN auth_throttle.window_started_at <= now() - make_interval(secs => $2) THEN 1
           ELSE auth_throttle.attempts + 1
         END,
         window_started_at = CASE
           WHEN auth_throttle.window_started_at <= now() - make_interval(secs => $2) THEN now()
           ELSE auth_throttle.window_started_at
         END,
         updated_at = now()
       RETURNING attempts, window_started_at, now() AS at`,
      [bucket, rule.windowSeconds]);
    const row = rows[0];
    const attempts = Number(row.attempts);
    const startedAt = row.window_started_at instanceof Date ? row.window_started_at : new Date(row.window_started_at);
    const at = row.at instanceof Date ? row.at : new Date(row.at);
    const windowMs = rule.windowSeconds * 1000;
    const elapsed = at.getTime() - startedAt.getTime();
    return {
      allowed: attempts <= rule.limit,
      attempts,
      limit: rule.limit,
      // Rounded UP and never below 1: telling a client "0 seconds" while still refusing it invites a hot loop.
      retryAfterSeconds: Math.max(1, Math.ceil((windowMs - elapsed) / 1000)),
    };
  }

  /**
   * Forget one bucket. Called when an attempt SUCCEEDS: a learner who mistypes twice and then gets it right
   * must not be two failures closer to being locked out for the rest of the window.
   */
  async function clear(kind, key) {
    await pool.query('DELETE FROM auth_throttle WHERE bucket = $1', [bucketFor(kind, key)]);
  }

  /**
   * Remove rows no window can still be deciding. Opportunistic, like the session sweep, and bounded by
   * `keepSeconds`: no scheduler to configure, and nothing that has to be remembered.
   * @returns {Promise<number>} rows removed
   */
  async function sweep() {
    const result = await pool.query(
      'DELETE FROM auth_throttle WHERE window_started_at <= now() - make_interval(secs => $1)', [keepSeconds]);
    return result.rowCount || 0;
  }

  return { hit, clear, sweep, policy, bucketFor };
}
