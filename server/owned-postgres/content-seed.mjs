/**
 * The writing task family, as versioned shared content records (SAAS-MODEL-01, Step 1).
 *
 * WHY THIS FILE EXISTS
 *
 * Before this slice content was not in the database at all: ten JSON files were served as
 * static assets and the browser fetched them directly. Every attempt was bound to two
 * synthetic constants (`adapter.mjs` `TASK_VERSION = 'synthetic-writing-v1'`,
 * `RUBRIC_VERSION = 'formative-fixture-v1'`). The new master plan requires
 * *"immutable versioned shared records with rights/review status; attempt binds exact
 * task/prompt/content/rubric versions; answer keys remain server-side"*. This module is the
 * seed for the writing family — the one family with a real submission → job → assessment →
 * rubric → revision path already verified end to end.
 *
 * PROVENANCE — read this before trusting a row
 *
 * The dispatch said to seed *"`data/seed.json`'s writing prompts"*. That is not where they
 * are. `tools/content-discovery.mjs` (the C-01 inventory) records it plainly:
 *
 *   * `data/seed.json` holds the **8 reading/listening/Sprachbausteine families** (LV1..HV3,
 *     24 sets, 180 keyed answer slots). It has no writing prompt.
 *   * the **6 offline writing prompts** lived in `public/js/ai.js`
 *     (`OFFLINE_WRITING_TASKS`, surfaced by `offlineWritingTask()`), 3 `du` + 3 `Sie`, each
 *     with 4 Leitpunkte; the rubric was `WRITING_CRITERIA` (4 criteria, max sum 45). **That module was
 *     deleted with the retired client (SPA-RETIRE 4)**, so `CONTENT_SOURCE` and migration 0006 are now
 *     the only record of where this text came from. The provenance string is deliberately NOT rewritten:
 *     the database rows already carry it, and re-pointing a provenance record at whichever file happens
 *     to survive would be falsifying it.
 *
 * So the seed was taken from that source, and the prompt text below is a literal copy of it.
 * `tools/owned-api-check.mjs` used to assert the copy still matched the MODULE; with the module gone it
 * asserts the copy matches **migration 0006**, the artifact that actually seeds the database — two
 * different files, so the drift check survives the deletion rather than dying with it. Nothing here is
 * invented; the rights/review statuses say exactly what C-01 found.
 *
 * RIGHTS / REVIEW — truthful, and deliberately not flattering
 *
 * C01-DISCOVERY records that rights/review status is `unknown` for most of the corpus and that
 * only `seed.json`'s 24 sets had even been inventoried. No human review of these six prompts
 * has happened. Every seeded row therefore carries `review_status = 'unreviewed'` and
 * `rights_status = 'unknown'`. These are facts about the corpus, not placeholders: a later UI
 * must be able to show `unreviewed`, which is why the value round-trips verbatim.
 *
 * These records are IMMUTABLE. A new version is a new row; an UPDATE or DELETE is refused by a
 * trigger (`contentCatalogueSql` in `provisioning-sql.mjs`). That is what makes an attempt's
 * `task_version` a durable claim about exactly which prompt it answered.
 */

import { createHash } from 'node:crypto';

export const WRITING_FAMILY = 'writing';
export const CONTENT_VERSION = 'v1';
/** Where the seeded text actually comes from, recorded on every content row. */
export const CONTENT_SOURCE = 'public/js/ai.js#OFFLINE_WRITING_TASKS';
/** C-01's measured status. `unknown`/`unreviewed` are the honest values; do not raise them here. */
export const REVIEW_STATUS = 'unreviewed';
export const RIGHTS_STATUS = 'unknown';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** Canonical hash of one versioned task payload, so the record can be checked for drift. */
export function taskContentHash(task) {
  return sha256(JSON.stringify({
    topic: task.topic, situation: task.situation, adressat: task.adressat, leitpunkte: task.leitpunkte,
  }));
}

/** The formative writing rubric (`WRITING_CRITERIA` in public/js/ai.js), max sum 45. */
export const WRITING_RUBRIC = Object.freeze({
  rubricId: 'writing.formative',
  version: CONTENT_VERSION,
  criteria: Object.freeze([
    Object.freeze({ key: 'aufgabe', label: 'Aufgabenbewältigung (alle Leitpunkte)', max: 15 }),
    Object.freeze({ key: 'kommunikation', label: 'Kommunikative Gestaltung (Anrede, Register, Textsorte)', max: 10 }),
    Object.freeze({ key: 'richtigkeit', label: 'Formale Richtigkeit (Grammatik, Orthografie)', max: 12 }),
    Object.freeze({ key: 'ausdruck', label: 'Ausdruck / Wortschatz', max: 8 }),
  ]),
});

/**
 * The six prompts. `taskId` is the stable server-side identity (topic slug, register); the
 * version is what an attempt binds. `publicId` is the unstable client id shape
 * (`sa_off_<clock>`) and is deliberately NOT used: it changes on every call.
 */
export const WRITING_TASKS = Object.freeze([
  Object.freeze({
    taskId: 'writing.du.besuch-einer-freundin', version: CONTENT_VERSION, register: 'du',
    topic: 'Besuch einer Freundin',
    situation: 'Ihre Freundin Anna möchte Sie im nächsten Monat besuchen. Sie fragt, wann sie kommen kann und was Sie gemeinsam unternehmen können. Antworten Sie ihr per E-Mail.',
    adressat: 'Ihre Freundin Anna (du)',
    leitpunkte: Object.freeze([
      'Schlagen Sie einen Termin für den Besuch vor.',
      'Erklären Sie, wie Anna am besten zu Ihnen kommt.',
      'Beschreiben Sie, wo Anna übernachten kann.',
      'Schlagen Sie gemeinsame Aktivitäten vor.',
    ]),
  }),
  Object.freeze({
    taskId: 'writing.du.geburtstag-eines-freundes', version: CONTENT_VERSION, register: 'du',
    topic: 'Geburtstag eines Freundes',
    situation: 'Ihr Freund Max hat Sie zu seiner Geburtstagsfeier eingeladen. Sie möchten kommen, können aber erst später da sein. Antworten Sie auf seine Einladung.',
    adressat: 'Ihr Freund Max (du)',
    leitpunkte: Object.freeze([
      'Bedanken Sie sich für die Einladung und sagen Sie zu.',
      'Erklären Sie, warum Sie später kommen.',
      'Sagen Sie, wann Sie ungefähr ankommen.',
      'Fragen Sie, was Sie für die Feier mitbringen können.',
    ]),
  }),
  Object.freeze({
    taskId: 'writing.du.umzug-und-hilfe', version: CONTENT_VERSION, register: 'du',
    topic: 'Umzug und Hilfe',
    situation: 'Sie ziehen bald in eine neue Wohnung. Ihre Freundin Julia hat Ihnen Hilfe angeboten und möchte wissen, was noch zu tun ist. Schreiben Sie ihr eine E-Mail.',
    adressat: 'Ihre Freundin Julia (du)',
    leitpunkte: Object.freeze([
      'Bedanken Sie sich für das Hilfsangebot.',
      'Beschreiben Sie Ihre neue Wohnung.',
      'Nennen Sie den Termin und den Treffpunkt für den Umzug.',
      'Erklären Sie, wobei Julia Ihnen helfen kann.',
    ]),
  }),
  Object.freeze({
    taskId: 'writing.sie.sprachkurs', version: CONTENT_VERSION, register: 'Sie',
    topic: 'Sprachkurs',
    situation: 'Sie haben einen Deutschkurs besucht und möchten sich bei Ihrer Kursleiterin bedanken. Leider konnten Sie an den letzten zwei Terminen nicht teilnehmen.',
    adressat: 'Ihre Kursleiterin Frau Berger (Sie)',
    leitpunkte: Object.freeze([
      'Bedanken Sie sich für den Kurs.',
      'Erklären Sie, warum Sie zweimal gefehlt haben.',
      'Fragen Sie, ob Sie die Unterlagen noch bekommen können.',
      'Fragen Sie nach einem passenden Folgekurs.',
    ]),
  }),
  Object.freeze({
    taskId: 'writing.sie.termin-mit-dem-vermieter', version: CONTENT_VERSION, register: 'Sie',
    topic: 'Termin mit dem Vermieter',
    situation: 'Ihr Vermieter Herr Weber möchte sich am Freitag die defekte Heizung in Ihrer Wohnung ansehen. Zu diesem Termin können Sie nicht zu Hause sein. Schreiben Sie ihm eine E-Mail.',
    adressat: 'Ihr Vermieter Herr Weber (Sie)',
    leitpunkte: Object.freeze([
      'Bedanken Sie sich für seine Nachricht.',
      'Beschreiben Sie das Problem mit der Heizung.',
      'Erklären Sie, warum Sie am Freitag keine Zeit haben.',
      'Schlagen Sie einen neuen Termin vor.',
    ]),
  }),
  Object.freeze({
    taskId: 'writing.sie.ausflug-mit-dem-sportverein', version: CONTENT_VERSION, register: 'Sie',
    topic: 'Ausflug mit dem Sportverein',
    situation: 'Ihre Trainerin Frau Neumann organisiert einen Ausflug mit dem Sportverein. Sie möchten teilnehmen und brauchen noch einige Informationen. Schreiben Sie ihr eine E-Mail.',
    adressat: 'Ihre Trainerin Frau Neumann (Sie)',
    leitpunkte: Object.freeze([
      'Sagen Sie, dass Sie am Ausflug teilnehmen möchten.',
      'Fragen Sie nach dem Treffpunkt und der Abfahrtszeit.',
      'Fragen Sie nach den Kosten.',
      'Bieten Sie Hilfe bei der Vorbereitung an.',
    ]),
  }),
]);

/**
 * The binding every attempt gets until a task-selection route exists (SAAS-RESUME-01 /
 * DESIGN-02). It is REAL content: the canonical first writing prompt and the one rubric. The
 * dispatch forbids changing the client or adding a serving route in this slice, so the
 * datastore binds this default rather than taking a task from the caller.
 */
export const DEFAULT_TASK = WRITING_TASKS[0];
export const DEFAULT_TASK_BINDING = Object.freeze({
  taskId: DEFAULT_TASK.taskId,
  taskVersion: DEFAULT_TASK.version,
  rubricId: WRITING_RUBRIC.rubricId,
  rubricVersion: WRITING_RUBRIC.version,
});

/** Every content_version row the seed needs: one per task version plus the rubric. */
export function contentVersionRows() {
  const rows = [];
  for (const task of WRITING_TASKS) {
    rows.push({
      contentVersionId: `${task.taskId}@${task.version}`,
      kind: 'task', family: WRITING_FAMILY, sourcePath: CONTENT_SOURCE,
      reviewStatus: REVIEW_STATUS, rightsStatus: RIGHTS_STATUS, sha256: taskContentHash(task),
    });
  }
  rows.push({
    contentVersionId: `${WRITING_RUBRIC.rubricId}@${WRITING_RUBRIC.version}`,
    kind: 'rubric', family: WRITING_FAMILY, sourcePath: CONTENT_SOURCE,
    reviewStatus: REVIEW_STATUS, rightsStatus: RIGHTS_STATUS,
    sha256: sha256(JSON.stringify(WRITING_RUBRIC.criteria)),
  });
  return rows;
}
