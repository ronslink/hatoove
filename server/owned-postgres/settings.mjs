/**
 * Account settings port (A-01 settings).
 *
 * The single-user app kept exam date, daily goal, model and theme in the browser: a
 * `localStorage` key for the theme and the rest inside the one unscoped progress blob. For a
 * SaaS user the requirement is explicit - *configure their language etc. in settings ... log
 * out and find their data still exists* - so settings have to be an **account-scoped server
 * record**, not a device key, or they vanish on the next device.
 *
 * This module is the port `server/owned-api.mjs` injects as `settings`. It implements:
 *
 *   read(owner)                        -> {revision, settings} (defaults when never saved)
 *   write(owner, expectedRevision, s)  -> {revision, settings}, or throws Fault(409,
 *                                         'settings_conflict') when the revision moved
 *
 * Semantics deliberately matched to the owned-attempts port, so the client can rely on one
 * story: the first write is `expectedRevision: 0`, every write increments the revision by one,
 * and a stale write writes nothing and is refused rather than merged.
 *
 * Scope and limits, stated plainly:
 *   - `language` selects de/en/uk/ar/tr explanations and is snapshotted at submission time.
 *     This setting is not a claim that provisional feedback has passed human language review.
 *   - Values are validated by shape (short strings, an integer in range, a known theme) and
 *     never interpreted. No field here is a security control.
 *   - It is not a general key/value store: the allowlist is fixed and closed.
 */

import { Fault, SETTINGS_FIELDS, EXPLANATION_LANGUAGES } from '../owned-api.mjs';

/*
 * EXAM-S1: `examDate` is READ-ONLY legacy. The active date lives on the preparation; the stored value is
 * returned and exported for audit, refused on write (it is not in SETTINGS_FIELDS), and never rewritten —
 * the UPDATE below does not name the column.
 */

export const SETTINGS_LIMITS = Object.freeze({
  examDate: 10,      // ISO calendar date, `YYYY-MM-DD`
  theme: 16,
  language: 16,
});

export const SETTINGS_THEMES = Object.freeze(['system', 'light', 'dark']);
/** Explanation languages supported by the learner contract. */
export const SETTINGS_LANGUAGES = EXPLANATION_LANGUAGES;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TOKEN_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

/** The defaults a learner has before they change anything. Mirrors the app's own defaults. */
export const SETTINGS_DEFAULTS = Object.freeze({
  examDate: '',
  dailyGoal: 20,
  theme: 'system',
  language: 'de',
});

const asRow = (row) => ({
  revision: Number(row.revision),
  settings: {
    examDate: row.exam_date || '',
    dailyGoal: Number(row.daily_goal),
    theme: row.theme || SETTINGS_DEFAULTS.theme,
    language: SETTINGS_LANGUAGES.includes(row.language) ? row.language : 'de',
  },
});

/**
 * Validate a settings object. Unknown keys are refused outright rather than ignored: silently
 * dropping a field a caller believes it saved is the kind of defect this programme keeps
 * finding.
 *
 * `partial` allows an update to mention only some fields; the rest keep their stored value.
 */
export function validateSettings(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Fault(422, 'invalid_settings');
  }
  // No model: see the note on SETTINGS_FIELDS in owned-api.mjs. The COLUMN stays (it is NOT NULL with a
  // default and the INSERT still names it), but it is not part of the learner's surface — neither
  // settable nor returned.
  // ONE canonical list, imported from owned-api.mjs (see the note on SETTINGS_FIELDS there). A second
  // copy here could accept a field the route refuses — or the reverse — and nothing would report it.
  const allowed = [...SETTINGS_FIELDS];
  const unknown = Object.keys(input).filter((key) => !allowed.includes(key));
  if (unknown.length) throw new Fault(422, 'invalid_settings');

  const out = {};
  if (input.dailyGoal !== undefined) {
    if (!Number.isSafeInteger(input.dailyGoal) || input.dailyGoal < 1 || input.dailyGoal > 500) {
      throw new Fault(422, 'invalid_settings');
    }
    out.dailyGoal = input.dailyGoal;
  }
  if (input.theme !== undefined) {
    if (!SETTINGS_THEMES.includes(input.theme)) throw new Fault(422, 'invalid_settings');
    out.theme = input.theme;
  }
  if (input.language !== undefined) {
    if (typeof input.language !== 'string' || input.language.length > SETTINGS_LIMITS.language) {
      throw new Fault(422, 'invalid_settings');
    }
    if (!SETTINGS_LANGUAGES.includes(input.language)) {
      throw new Fault(422, 'invalid_settings');
    }
    out.language = input.language;
  }
  if (!Object.keys(out).length) throw new Fault(422, 'invalid_settings');
  return out;
}

/**
 * @param {object} options
 * @param {object} options.pool a pool bound to the restricted learner role
 */
export function createPostgresSettings({ pool } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('createPostgresSettings requires a pg Pool');

  /** One transaction, with the verified owner bound locally, exactly like the attempts port. */
  async function settle(owner, work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
      const value = await work(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* preserve the original failure */ }
      throw error;
    } finally {
      client.release();
    }
  }

  return {
    /** Read, or the defaults when the account has never saved anything. */
    async read(owner) {
      return settle(owner, async (client) => {
        const row = (await client.query(
          'SELECT revision, exam_date, daily_goal, model, theme, language FROM learner_settings WHERE user_id = $1',
          [owner])).rows[0];
        if (!row) return { revision: 0, settings: { ...SETTINGS_DEFAULTS } };
        return asRow(row);
      });
    },

    /**
     * Write against `expectedRevision`. `0` creates the row; any other value updates it only if
     * the stored revision still matches, so a second device cannot silently overwrite the first.
     */
    async write(owner, expectedRevision, patch) {
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Fault(422, 'invalid_settings');
      patch = validateSettings(patch);
      return settle(owner, async (client) => {
        const current = (await client.query(
          'SELECT revision, exam_date, daily_goal, model, theme, language FROM learner_settings WHERE user_id = $1 FOR UPDATE',
          [owner])).rows[0];
        const base = current ? asRow(current) : { revision: 0, settings: { ...SETTINGS_DEFAULTS } };
        if (base.revision !== expectedRevision) {
          // Nothing is written. The caller gets the server's copy so it can reconcile.
          throw new Fault(409, 'settings_conflict', { current: base });
        }
        const next = { ...base.settings, ...patch };
        /*
         * `model` is absent from the column list on purpose. It is a NOT NULL column with a DEFAULT, and
         * it is no longer part of the learner's surface (see SETTINGS_FIELDS in owned-api.mjs), so the
         * DEFAULT supplies it on INSERT and the UPDATE leaves the stored value alone. Passing
         * `next.model` here would have written `undefined` the moment the field stopped being accepted —
         * a crash on the first settings save, which is exactly the kind of thing this comment exists to
         * stop someone "restoring".
         */
        // `exam_date` is not written: a new row takes the column default (''), an existing row keeps its
        // legacy value untouched (EXAM-S1).
        const row = (await client.query(
          `INSERT INTO learner_settings (user_id, daily_goal, theme, language, revision)
           VALUES ($1, $2, $3, $4, 1)
           ON CONFLICT (user_id) DO UPDATE SET
             daily_goal = EXCLUDED.daily_goal,
             theme = EXCLUDED.theme,
             language = EXCLUDED.language,
             revision = learner_settings.revision + 1
           RETURNING revision, exam_date, daily_goal, theme, language`,
          [owner, next.dailyGoal, next.theme, next.language])).rows[0];
        return asRow(row);
      });
    },
  };
}
