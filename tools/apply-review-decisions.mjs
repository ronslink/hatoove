#!/usr/bin/env node
/**
 * REVIEW-PACK-01 — turn a reviewer's own decisions into a record the program can read.
 *
 * WHAT THIS DOES, AND WHAT IT REFUSES TO DO
 *   It reads the decision column a human filled in (a pack CSV or a decision JSON), validates every
 *   decision against a freshly enumerated pack, and writes:
 *
 *     <language>-ledger.json      who decided what, against which exact text, and when
 *     <language>-corrections.csv  the edits the program must make, with the file and address of each
 *
 *   It REFUSES to invent anything:
 *     - no reviewer name  -> nothing is applied at all. There is no way to approve a string without
 *       naming the human who approved it, and no code path here derives a decision from the text;
 *     - a blank decision column stays blank: untouched strings simply stay unreviewed;
 *     - `fix` without replacement text, `reject`/`not-applicable` without a reason, an id that is not
 *       in the pack, and an approval of a string that has no text yet are all errors, not warnings.
 *     - **the text the reviewer judged must still be the text the pack shows.** A decision is about a
 *       string the human READ. If the source moved after the pack was generated, applying the decision
 *       would silently re-attribute that human's judgement to text they never saw, so the whole file is
 *       refused and the reviewer is asked to re-generate and re-read. The CSV carries that text in its
 *       `current` column; a decision file must carry it as `text_at_review`.
 *
 *   It does NOT edit `public/assets/i18n/**` or the translation bundle. Landing a decision is a
 *   separate, owned change (the German/interface catalogues are one lease's files; the bundle is
 *   another's), and this tool prints exactly what that change is rather than making it quietly.
 *
 * USAGE
 *   node tools/apply-review-decisions.mjs --csv uk-rows.csv --reviewer "Oksana K."
 *   node tools/apply-review-decisions.mjs --json uk-decisions.json
 *   node tools/apply-review-decisions.mjs --csv uk-rows.csv --reviewer "Oksana K." --dry-run
 *   node tools/apply-review-decisions.mjs --csv uk-rows.csv --reviewer "Oksana K." --ledger-dir <dir>
 *
 * The CSV spelling of a decision is `ok` / `fix` / `reject` / `na`. The JSON spelling is
 * `approved` / `fix` / `reject` / `not-applicable`. Both are accepted in either place.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEDGER_FORMAT, LOCALES, census, enumerateRows, ledgerPath, packCsvRows, referenceScan,
} from './build-review-pack.mjs';

const DECISIONS = Object.freeze(['approved', 'fix', 'reject', 'not-applicable']);
const SHORT_FORMS = Object.freeze({
  ok: 'approved', approved: 'approved', yes: 'approved',
  fix: 'fix', change: 'fix', correction: 'fix',
  reject: 'reject', no: 'reject',
  na: 'not-applicable', 'n/a': 'not-applicable', 'not-applicable': 'not-applicable', notapplicable: 'not-applicable',
});
const ACTION_FOR = Object.freeze({ fix: 'replace', reject: 'remove', 'not-applicable': 'mark-no-translation-owed' });
const ACTIONS_HEADER = Object.freeze([
  'id', 'language', 'action', 'source_file', 'source_locator', 'text_at_review', 'correction', 'note',
  'decided_by', 'decided_at',
]);

const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function parseArgs(argv) {
  const options = { dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--csv') options.csv = argv[++index];
    else if (token === '--json') options.json = argv[++index];
    else if (token === '--reviewer') options.reviewer = argv[++index];
    else if (token === '--date') options.date = argv[++index];
    else if (token === '--language') options.language = argv[++index];
    else if (token === '--ledger-dir') options.ledgerDir = argv[++index];
    else if (token === '--dry-run') options.dryRun = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`unknown argument ${token}`);
  }
  return options;
}

/** Read the human's decisions out of either shape, without inventing or defaulting any of them. */
function readDecisions(options) {
  if (options.csv && options.json) throw new Error('pass --csv or --json, not both');
  if (!options.csv && !options.json) throw new Error('pass --csv <pack rows.csv> or --json <decisions.json>');
  if (options.csv) {
    const { rows, malformed } = packCsvRows(readFileSync(options.csv, 'utf8'));
    const languages = new Set(rows.map((row) => row.language).filter(Boolean));
    if (languages.size > 1) throw new Error(`${options.csv} mixes languages: ${[...languages].join(', ')}`);
    const decisions = [];
    for (const row of rows) {
      const raw = String(row.decision ?? '').trim();
      if (!raw) continue;
      /* `current` is the text the pack PRINTED, so it is what the reviewer judged. It is carried through
         and compared below: a decision about text that has since moved is not a decision about this text. */
      decisions.push({
        id: row.id, raw, correction: String(row.correction ?? '').trim(), note: String(row.note ?? '').trim(),
        quoted: String(row.current ?? ''), quotedFrom: 'the pack row\'s current column',
      });
    }
    return {
      file: options.csv, language: [...languages][0] ?? null, reviewer: options.reviewer ?? null,
      reviewedAt: options.date ?? null, decisions, malformed,
    };
  }
  const parsed = JSON.parse(readFileSync(options.json, 'utf8'));
  if (!parsed || typeof parsed !== 'object') throw new Error(`${options.json} is not a JSON object`);
  const entries = Array.isArray(parsed.decisions) ? parsed.decisions : [];
  const decisions = entries.map((entry) => ({
    id: entry?.id, raw: String(entry?.decision ?? '').trim(),
    correction: String(entry?.correction ?? '').trim(), note: String(entry?.note ?? '').trim(),
    quoted: entry?.text_at_review === undefined || entry?.text_at_review === null ? null : String(entry.text_at_review),
    quotedFrom: 'text_at_review',
  })).filter((entry) => entry.raw);
  return {
    file: options.json, language: options.language ?? parsed.language ?? null,
    reviewer: options.reviewer ?? parsed.reviewer ?? null,
    reviewedAt: options.date ?? parsed.reviewed_at ?? null, decisions,
  };
}

const isIsoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node tools/apply-review-decisions.mjs (--csv <rows.csv> | --json <decisions.json>) --reviewer "<name>" [--date YYYY-MM-DD] [--ledger-dir <dir>] [--dry-run]');
    return;
  }
  const input = readDecisions(options);
  /*
   * A row whose column count does not match the header is refused before anything else: a
   * spreadsheet that added or lost a column must not look like "the reviewer decided nothing",
   * because that would silently discard a human's work.
   */
  if (input.malformed?.length) {
    console.error(`apply-review-decisions: ${input.malformed.length} row(s) in ${path.basename(input.file)} do not match the ${input.malformed[0].expected}-column header, nothing written`);
    for (const row of input.malformed.slice(0, 5)) console.error(`  ${row.id}: ${row.cells} column(s), expected ${row.expected}`);
    console.error('  re-export the CSV with the original header and column count, then run this again');
    process.exit(1);
  }
  const language = options.language ?? input.language;
  if (!language) throw new Error('cannot tell which language this is: pass --language <de|uk|ar|tr> or use a pack file that carries a language column');
  if (!LOCALES.includes(language)) throw new Error(`unknown language ${language}`);
  const reviewer = String(input.reviewer ?? '').trim();
  const problems = [];
  /*
   * THE ONE RULE THAT MATTERS. Without a named human there is no decision to record, so the tool
   * stops before it writes anything rather than writing an anonymous approval.
   */
  if (!reviewer) problems.push('no reviewer: pass --reviewer "<the human who made these decisions>" (a script may not approve anything)');
  const reviewedAt = String(input.reviewedAt ?? '').trim() || new Date().toISOString().slice(0, 10);
  if (!isIsoDate(reviewedAt)) problems.push(`--date/reviewed_at must be YYYY-MM-DD, got ${JSON.stringify(reviewedAt)}`);
  if (!input.decisions.length) {
    console.log(`nothing to apply: ${path.basename(input.file)} carries no filled decision column. Nothing was written, and no string changed status.`);
    return;
  }

  const data = await census();
  const scan = referenceScan(data.catalogues);
  const byId = new Map(enumerateRows(data, language, scan).map((row) => [row.id, row]));

  const seen = new Set();
  const accepted = [];
  for (const entry of input.decisions) {
    const id = String(entry.id ?? '').trim();
    const decision = SHORT_FORMS[String(entry.raw).toLowerCase()];
    if (!id) { problems.push('a decision has no id'); continue; }
    if (seen.has(id)) { problems.push(`${id}: decided twice`); continue; }
    seen.add(id);
    if (!decision) { problems.push(`${id}: ${JSON.stringify(entry.raw)} is not one of ok|fix|reject|na (or approved|fix|reject|not-applicable)`); continue; }
    const row = byId.get(id);
    if (!row) { problems.push(`${id}: no such string in the ${language} pack (stale file, or the id was mistyped)`); continue; }
    if (decision === 'fix' && !entry.correction) { problems.push(`${id}: "fix" needs the replacement text in the correction column`); continue; }
    if (decision === 'reject' && !entry.note) { problems.push(`${id}: "reject" needs a reason in the note column`); continue; }
    if (decision === 'not-applicable' && !entry.note) { problems.push(`${id}: "na" needs a reason in the note column`); continue; }
    if (decision === 'approved' && !String(row.current ?? '').trim()) {
      problems.push(`${id}: there is no text to approve (this row is ${row.status}; a missing translation has to be written first)`);
      continue;
    }
    /*
     * THE SECOND RULE THAT MATTERS, and the one that keeps an approval honest over time.
     *
     * The reviewer judged the text the pack PRINTED. `row.current` here is the text the sources carry
     * NOW. If they differ, the source moved after the pack was generated: writing the decision would
     * record a human's judgement against text they never read, and the pack would then show `approved`
     * for that new text. Refused for every decision kind, not only for approvals — a `fix` correction
     * is equally about the sentence the reviewer saw.
     */
    if (entry.quoted === null || entry.quoted === undefined) {
      problems.push(`${id}: this decision carries no ${entry.quotedFrom}, so there is no way to tell which text was judged; ${entry.quotedFrom === 'text_at_review' ? 'add text_at_review (the row\'s current column) to the entry' : 're-export the pack CSV'}`);
      continue;
    }
    if (String(entry.quoted) !== String(row.current ?? '')) {
      problems.push(`${id}: the text changed since this pack was generated (the reviewer judged a different sentence); re-generate the pack with \`node tools/build-review-pack.mjs\` and re-review — nothing written`);
      continue;
    }
    accepted.push({ id, decision, correction: entry.correction, note: entry.note, row });
  }

  if (problems.length) {
    console.error(`apply-review-decisions: ${problems.length} problem(s), nothing written`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }

  const entries = accepted.map((entry) => ({
    id: entry.id,
    decision: entry.decision,
    decided_by: reviewer,
    decided_at: reviewedAt,
    note: entry.note,
    correction: entry.decision === 'fix' ? entry.correction : '',
    text_at_review: entry.row.current,
    source_file: entry.row.source_file,
    source_locator: entry.row.source_locator,
    section: entry.row.section,
    where: entry.row.where,
  }));
  const ledgerDir = path.resolve(options.ledgerDir ?? path.dirname(path.resolve(input.file)));
  const target = ledgerPath(ledgerDir, language);
  const existing = existsSync(target) ? JSON.parse(readFileSync(target, 'utf8')) : null;
  const merged = new Map((existing?.entries ?? []).map((entry) => [entry.id, entry]));
  for (const entry of entries) merged.set(entry.id, entry);
  const ledger = {
    format: LEDGER_FORMAT,
    language,
    note: 'Written by tools/apply-review-decisions.mjs from a human decision file. An entry exists only because a named reviewer wrote that decision; nothing here was derived from the text.',
    entries: [...merged.values()].sort((left, right) => left.id.localeCompare(right.id, 'en')),
  };
  const actions = entries.filter((entry) => entry.decision !== 'approved');
  const actionLines = [ACTIONS_HEADER.join(',')];
  for (const entry of actions) {
    actionLines.push([
      entry.id, language, ACTION_FOR[entry.decision], entry.source_file, entry.source_locator,
      entry.text_at_review, entry.correction, entry.note, entry.decided_by, entry.decided_at,
    ].map(csvCell).join(','));
  }

  const tally = DECISIONS.map((decision) => `${entries.filter((entry) => entry.decision === decision).length} ${decision}`).join(', ');
  console.log(`reviewer: ${reviewer}   language: ${language}   decided ${reviewedAt}`);
  console.log(`accepted ${entries.length} decision(s): ${tally}`);
  console.log(`ledger:      ${target}`);
  console.log(`actions:     ${path.join(ledgerDir, `${language}-corrections.csv`)} (${actions.length} edit(s) the program still owes)`);
  if (options.dryRun) {
    console.log('dry run: nothing written.');
    return;
  }
  mkdirSync(ledgerDir, { recursive: true });
  writeFileSync(target, `${JSON.stringify(ledger, null, 2)}\n`);
  writeFileSync(path.join(ledgerDir, `${language}-corrections.csv`), `${actionLines.join('\n')}\n`);
  console.log('');
  console.log('What has NOT happened: no catalogue and no bundle byte was changed, and no database row moved.');
  console.log(`${actions.length} edit(s) are listed in ${language}-corrections.csv with the file and address of each string.`);
  console.log('Landing them is a separate, owned change: the interface catalogues (public/assets/i18n/**) and the');
  console.log('translation bundle (content/library-translations/**) each have an owner, and the library side also has');
  console.log('to reach the database through the importer so a learner is served the corrected text.');
  console.log(`Re-run \`node tools/build-review-pack.mjs\` afterwards: the pack then shows \`approved\` plus the reviewer's name.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`apply-review-decisions: ${error.message}`); process.exit(1); });
}
