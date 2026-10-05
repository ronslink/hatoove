/**
 * PILOT-FEEDBACK-01 — the closed vocabularies, in ONE place that both sides can import.
 *
 * WHY THIS FILE EXISTS, rather than the constants living in `owned-postgres/feedback.mjs`: that module imports
 * `Fault` from `../owned-api.mjs`, and the API needs these lists to validate the request. Importing the lists
 * from there would make `owned-api.mjs` and `feedback.mjs` circular — which happens to work in ES modules while
 * every access stays inside a function body, and breaks the moment somebody reads one at module scope. A file
 * with no imports of its own removes the question.
 *
 * THE ROUTE LIST HAS THREE COPIES BY NECESSITY — the migration's `route` CHECK must exist in SQL, the shell's
 * `VIEW_TITLES` must exist in the browser, and the API must validate before the insert. `FEEDBACK_ROUTES` is the
 * only JavaScript one, and `pilot-feedback-migration-check` leg 1b compares it against BOTH of the others: a
 * route the CHECK rejects loses the report at 23514, and a route the API rejects loses it at 422.
 */

/** The client's real view ids (`public/app/app.js` VIEW_TITLES), plus `other` for a view neither list names. */
export const FEEDBACK_ROUTES = Object.freeze([
  'heute', 'ueben', 'wortschatz', 'fehler', 'pruefungsteile', 'hoeren', 'schreiben', 'probepruefung',
  'nachschlagen', 'einstellungen', 'verlauf', 'checkout', 'lesen', 'sprachbausteine', 'abschnitt',
  'satzbau', 'mehr', 'other',
]);

/** What the learner says went wrong. `idea` and `other` are why one form serves both reports and general notes. */
export const FEEDBACK_CATEGORIES = Object.freeze([
  'content_error', 'audio', 'translation', 'bug', 'idea', 'other',
]);
