/**
 * The pilot account-request port (migration `0041`) — the queue the public request form writes to.
 *
 * WHAT THIS IS. During the pilot the front door asks for an account rather than opening the sign-up
 * form, and a person on the team provisions each account by hand. `POST /api/auth/request-access`
 * validates and throttles a submission and then hands the four validated values to `submit` here; the
 * operator reads the same rows with `server/access.mjs` (`docker compose run`). There is no email
 * provider (the processor question P-03 is undecided), so nothing in this path sends anything: the row
 * IS the delivery, and the page says so in plain German.
 *
 * WHY THE PORT EXISTS RATHER THAN SQL IN THE ROUTE. The running server and every check build the API
 * through one composition (`createPostgresWorld`), so a write that lived in the route would be a write
 * the checks could not replace with an in-memory backend and could not inspect. `tools/owned-api-check.mjs`
 * implements the same five-method shape in memory, and the legs that need real SQL use this one.
 *
 * IT RUNS AS THE `auth` ROLE, AND ONLY THE `auth` ROLE. `account_request` is an auth-support table
 * (`tools/lib/catalogue.mjs`): the rows are people with no account yet, so they belong to no owner and
 * no learner/worker/deletion/payments role may read who asked for access. This module therefore opens
 * no pool of its own and takes the restricted pool the caller already holds.
 *
 * WHAT IT DOES NOT DO: it issues no code, it creates no account, and it never touches `"user"`. Inviting
 * somebody is the invite-gate slice's job; `decline` and `purge` here are the operator's two housekeeping
 * actions, and `status` already carries the `invited` value that slice will set.
 */

/** The statuses the table allows. Named here so the operator command and a check share one list. */
export const ACCOUNT_REQUEST_STATUSES = Object.freeze(['open', 'invited', 'declined']);

/**
 * An address the operator typed, checked only for the shape a LOOKUP needs. There is deliberately no
 * second copy of the address rule here: the route is the one place that decides what a valid address is,
 * and a copy would be a copy that drifts. This rejects the typos that could never match a row anyway and
 * lets the database decide about everything else.
 */
function requireLookupAddress(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim() || value.length > 254 || /\s/.test(value)) {
    throw new TypeError('invalid_account_request_email');
  }
  return value;
}

/**
 * @param {{pool: object}} options `pool` must connect as the restricted `auth` role.
 * @returns {{submit: Function, list: Function, decline: Function, purge: Function}}
 */
export function createPostgresAccountRequests({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') throw new TypeError('createPostgresAccountRequests requires a pg Pool');

  /**
   * Store one request. THE DUPLICATE IS NOT AN ERROR AND NOT AN UPDATE: `ON CONFLICT DO NOTHING` means
   * a second submission from the same address leaves the first row — and its `created_at`, which is what
   * the retention sweep and the operator's queue order depend on — exactly as it was. The route answers
   * the same 202 either way, so nothing about this reaches the caller.
   *
   * @returns {Promise<{stored: boolean}>} `false` when the address already had a request. The route
   *   deliberately discards this: it is here for the checks and for the operator command, not for a client.
   */
  async function submit({ name, email, language, consentVersion }) {
    const { rowCount } = await pool.query(
      `INSERT INTO account_request(name, email, language, consent_version)
       VALUES($1, $2, $3, $4)
       ON CONFLICT (email) DO NOTHING`,
      [name, email, language, consentVersion]);
    return { stored: rowCount > 0 };
  }

  /** The queue, in arrival order. `status` narrows it to one value; anything else is all of it. */
  async function list({ status = null } = {}) {
    if (status !== null && !ACCOUNT_REQUEST_STATUSES.includes(status)) throw new TypeError('invalid_account_request_status');
    const { rows } = status === null
      ? await pool.query(
        `SELECT id, email, name, language, consent_version, status, created_at, handled_at
         FROM account_request ORDER BY created_at, email`)
      : await pool.query(
        `SELECT id, email, name, language, consent_version, status, created_at, handled_at
         FROM account_request WHERE status = $1 ORDER BY created_at, email`, [status]);
    return rows.map((row) => ({ ...row }));
  }

  /**
   * Mark an open request declined.
   *
   * `found` and `declined` are BOTH returned because they are different answers and an operator needs to
   * tell them apart: "there is no request from this address" is a typo or a wrong address, while "this
   * request was already handled" means the queue moved on. Reporting one message for both would be the
   * silent-no-op failure this repository keeps finding.
   *
   * @returns {Promise<{found: boolean, declined: boolean}>}
   */
  async function decline(email) {
    requireLookupAddress(email);
    /*
     * `lower($1)` IS THE LOOKUP, not a second normalisation rule: stored addresses are folded by the
     * route, so folding the operator's typing here means `decline Anna@Example.com` finds the row without
     * this module owning a copy of the address rule (two copies of "what is an address" is exactly the
     * drift this repository keeps finding).
     */
    const { rows } = await pool.query(
      `WITH target AS (SELECT id FROM account_request WHERE email = lower($1)),
            updated AS (UPDATE account_request SET status = 'declined', handled_at = now()
                        WHERE email = lower($1) AND status = 'open' RETURNING id)
       SELECT (SELECT count(*)::int FROM target) AS found, (SELECT count(*)::int FROM updated) AS declined`, [email]);
    const row = rows[0] || { found: 0, declined: 0 };
    return { found: Number(row.found) > 0, declined: Number(row.declined) > 0 };
  }

  /**
   * Remove requests. EXACTLY ONE SELECTOR, and the two are not combinable: `--email a@b` names one
   * person's request, `--older-than 30` is the retention sweep. Accepting both would make "delete this
   * one, or everything old, whichever" a question nobody can answer after the fact from the command.
   *
   * `olderThanDays` must be a positive integer. `0` would mean "everything, including a request that
   * arrived a second ago", which is never what an operator means and is exactly the kind of typo a
   * retention sweep must not be able to make.
   *
   * @returns {Promise<{removed: number, emails: string[]}>}
   */
  async function purge({ email = null, olderThanDays = null } = {}) {
    const byEmail = typeof email === 'string' && email !== '';
    const byAge = olderThanDays !== null && olderThanDays !== undefined;
    if (byEmail === byAge) throw new TypeError('account_request_purge_needs_exactly_one_selector');
    if (byAge && (!Number.isSafeInteger(olderThanDays) || olderThanDays < 1 || olderThanDays > 3650)) {
      throw new TypeError('invalid_account_request_age');
    }
    if (byEmail) requireLookupAddress(email);
    const { rows } = byEmail
      ? await pool.query('DELETE FROM account_request WHERE email = lower($1) RETURNING email', [email])
      : await pool.query(
        'DELETE FROM account_request WHERE created_at <= now() - make_interval(days => $1) RETURNING email',
        [olderThanDays]);
    return { removed: rows.length, emails: rows.map((row) => row.email) };
  }

  return { submit, list, decline, purge };
}
