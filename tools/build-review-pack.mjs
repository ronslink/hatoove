#!/usr/bin/env node
/**
 * REVIEW-PACK-01 — build the per-language wholesale review pack.
 *
 * WHY THIS EXISTS. Ron is about to put the whole app in front of one named native speaker per
 * language (uk, ar, tr) plus a German reviewer for the interface copy. Before this tool the copy
 * lived in six interface catalogues, a 531 KB translation bundle and four <noscript> blocks, and a
 * reviewer had to hunt keys in five files instead of reading sentences — and could not prove the
 * review was complete, because nobody could say what "all of it" was.
 *
 * WHAT IT DOES
 *   1. Enumerates every learner-facing string from its REAL source of truth, offline, with no
 *      hand-written list: the registered interface catalogues (imported, so the pack cannot drift
 *      from them), the instructions catalogue, the two instruction fallback maps and the i18n
 *      runtime fallback (static extraction, asserted complete), the pre-JavaScript <noscript>
 *      German, and the library bundle bound to the frozen German source through the importer's
 *      own `planGuideStrings`/`planNounRows`. Prints the census per source BEFORE writing anything.
 *   2. Writes one review document per language plus a machine-readable companion with an EMPTY
 *      decision column, and a small decision template.
 *   3. Applies any human decision ledger that already exists, so the pack is the live answer to
 *      "is this string reviewed?". A string is `approved` only when a named human approved that
 *      exact text; this tool never approves anything and cannot invent a reviewer.
 *
 * HARD RULES OBSERVED HERE
 *   - nothing is machine-translated: the tool only copies text that is already in the repository;
 *   - no catalogue, bundle, migration or DB row is modified — everything is read;
 *   - nothing is ever marked approved by this tool: `approved` reaches a row only from a ledger
 *     written by `tools/apply-review-decisions.mjs` from a human's own decision file;
 *   - the packs are derived output. The default destination is `handoff/` (gitignored).
 *
 * USAGE
 *   node tools/build-review-pack.mjs
 *   node tools/build-review-pack.mjs --out D:\Hatoove\handoff\ron-agent\review-packs
 *   node tools/build-review-pack.mjs --languages de,uk,ar,tr --ledger-dir <dir>
 *   node tools/build-review-pack.mjs --census-only
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  EXPECTED_NOUNS, EXPECTED_STRINGS_PER_GUIDE, TRANSLATION_LOCALES,
  loadVerifiedBundle, planGuideStrings, planNounRows, validateBundleShape,
} from '../server/library-translations.mjs';

export const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const LOCALES = Object.freeze(['de', 'en', 'uk', 'ar', 'tr']);
/** Ron named uk, ar, tr (native speakers) and de (interface copy). en is shipped but was not named. */
export const PACK_LANGUAGES = Object.freeze(['de', 'uk', 'ar', 'tr']);
export const PACK_FORMAT = 'hatoove-review-pack/v1';
export const DECISION_FORMAT = 'hatoove-review-decisions/v1';
export const LEDGER_FORMAT = 'hatoove-review-ledger/v1';

/** The reviewed-language name shown on the document, and the direction the reviewer reads in. */
const LANGUAGE_LABEL = Object.freeze({
  de: 'German (de) — interface and guidance copy, reviewed in German',
  en: 'English (en)',
  uk: 'Ukrainian (uk)',
  ar: 'Arabic (ar) — the document is Latin-ordered; the reviewed text must be read right-to-left',
  tr: 'Turkish (tr)',
});

/* ------------------------------------------------------------------ sources: interface */

/**
 * The registered interface catalogues. Imported rather than parsed: an import cannot silently
 * disagree with what the app ships, and `registerMessages` in `core.js` already refuses a catalogue
 * whose locales disagree about their key set or their placeholders.
 */
export const CATALOGUES = Object.freeze([
  { namespace: 'shell', file: 'public/assets/i18n/shell-messages.js', exportName: 'shellMessages', area: 'App shell, menus, account, history, vocabulary search' },
  { namespace: 'practice', file: 'public/assets/i18n/practice-messages.js', exportName: 'PRACTICE_MESSAGES', area: 'Practice runner, drill, listening, writing feedback, explanations' },
  { namespace: 'public', file: 'public/assets/i18n/public-messages.js', exportName: 'publicMessages', area: 'Public front door (/, pre-auth pages)' },
  { namespace: 'auth', file: 'public/assets/i18n/auth-messages.js', exportName: 'authMessages', area: 'Sign in, registration, password, email verification' },
  { namespace: 'common', file: 'public/assets/i18n/common.js', exportName: 'commonMessages', area: 'Shared bilingual-instruction chrome' },
]);

/**
 * Learner-facing strings that are NOT reachable through a catalogue export. Each one is extracted
 * from the file that owns it and the extraction THROWS if the block cannot be found or is missing a
 * locale, so a refactor that moves one of these cannot silently drop it from the pack.
 */
export const FALLBACK_MAPS = Object.freeze([
  { id: 'core.unavailable', file: 'public/assets/i18n/core.js', constName: 'unavailable', area: 'i18n runtime', usage: 'shown when a key, its language, or its parameters do not resolve' },
  { id: 'instructions.unavailable', file: 'public/assets/i18n/instructions.js', constName: 'unavailable', area: 'Bilingual instruction', usage: 'shown when the selected language has no translation of a curated direction' },
  { id: 'instructions.originalUnavailable', file: 'public/assets/i18n/instructions.js', constName: 'originalUnavailable', area: 'Bilingual instruction', usage: 'shown when the curated direction itself is unavailable in the exam language' },
]);

/** The pre-JavaScript German and its four translations, hardcoded into every shell that has one. */
export const NOSCRIPT_FILES = Object.freeze([
  'public/index.html', 'public/signin.html', 'public/reset-password.html', 'public/verify-email.html',
]);

/** One static file the reference scan reads, and the learner surface it owns. */
const SURFACES = Object.freeze({
  'public/index.html': 'public front door /',
  'public/site.js': 'public front door /',
  'public/signin.html': '/signin',
  'public/reset-password.html': '/reset-password',
  'public/verify-email.html': '/verify-email',
  'public/auth/entry.js': '/signin, /reset-password, /verify-email (auth entry script)',
  'public/js/owned-client.js': 'public front door / (owned client)',
  'public/app/index.html': 'app shell — every #/ view',
  'public/app/app.js': 'app shell controller — every #/ view',
  'public/app/checkout.js': '#/checkout',
  'public/app/drill.js': '#/ueben (Einzelübungen)',
  'public/app/library.js': '#/nachschlagen, #/wortschatz',
  'public/app/mock-intro.js': '#/probepruefung',
  'public/app/mock.js': 'mock run — #/lauf',
  'public/app/part-index.js': '#/pruefungsteile',
  'public/app/part-runner.js': 'practice run',
  'public/app/writing.js': '#/schreiben',
  'public/app/listening.js': '#/hoeren',
  'public/app/vocab.js': '#/wortschatz',
  'public/app/explanations.js': 'saved explanations',
  'public/app/preparation.js': 'preparation switcher',
  'public/app/review-labels.js': 'review labels — every view',
  'public/app/read-aloud.js': 'read-aloud button',
  'public/app/locale-preference.js': 'language switcher',
  'public/app/sentence-check.js': 'writing sentence check',
  'public/app/guide-content.js': 'guide body renderer',
  'public/app/api.js': 'api client',
});

/** Where an instruction id is rendered. Documented map: an id that is missing here is reported. */
const INSTRUCTION_SURFACES = Object.freeze({
  'public.reading': 'public front door / — reading sample',
  'public.grammar': 'public front door / — language elements sample',
  'public.writing': 'public front door / — writing sample',
  matching_headlines: 'practice item — matching headlines',
  matching_ads: 'practice item — matching advertisements',
  single_choice: 'practice item — single choice',
  grouped_choice: 'practice item — grouped choice',
  gap_choice: 'practice item — gap choice',
  gap_bank: 'practice item — word bank',
  fixed_audio: 'listening item — fixed audio',
  'listening.playback': '#/hoeren — playback rule',
  'writing.assigned': '#/schreiben — assigned task',
  'writing.choose_one': '#/schreiben — task choice',
  'mock.timing': '#/probepruefung, mock run — timing rule',
});

/* ------------------------------------------------------------------ small readers */

const readText = (relative) => readFileSync(path.join(ROOT, relative), 'utf8');
const readJson = (relative) => JSON.parse(readText(relative));
const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex');

/** `const NAME = [Object.freeze(]{ de: '…', … }` — every locale required, or the build stops. */
export function objectLiteralStrings(text, constName, where) {
  const marker = new RegExp(`const\\s+${constName}\\s*=\\s*(?:Object\\.freeze\\()?\\{`);
  const found = marker.exec(text);
  if (!found) throw new Error(`${where}: no \`const ${constName} = {…}\` block`);
  const start = text.indexOf('{', found.index + found[0].length - 1);
  let depth = 0;
  let end = -1;
  let inString = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "'") { if (text[index + 1] === "'") index += 1; else inString = false; }
      continue;
    }
    if (char === "'") { inString = true; continue; }
    if (char === '{') depth += 1;
    else if (char === '}') { depth -= 1; if (depth === 0) { end = index; break; } }
  }
  if (end < 0) throw new Error(`${where}: the \`${constName}\` block is not closed`);
  const values = {};
  for (const entry of text.slice(start, end + 1).matchAll(/([A-Za-z][A-Za-z0-9_]*)\s*:\s*'((?:[^']|'')*)'/g)) {
    values[entry[1]] = entry[2].replaceAll("''", "'");
  }
  for (const locale of LOCALES) {
    if (typeof values[locale] !== 'string' || !values[locale].trim()) {
      throw new Error(`${where}: \`${constName}\` has no non-empty ${locale} member (found ${Object.keys(values).join(', ') || 'none'})`);
    }
  }
  for (const key of Object.keys(values)) {
    if (!LOCALES.includes(key)) throw new Error(`${where}: \`${constName}\` carries an unknown member ${key}`);
  }
  return values;
}

export async function readInterfaceCatalogues() {
  const catalogues = [];
  for (const entry of CATALOGUES) {
    const module_ = await import(pathToFileURL(path.join(ROOT, entry.file)).href);
    const table = module_[entry.exportName];
    if (!table || typeof table !== 'object') throw new Error(`${entry.file} does not export ${entry.exportName}`);
    const keys = Object.keys(table.de ?? {});
    if (!keys.length) throw new Error(`${entry.file}: ${entry.exportName}.de is empty`);
    for (const locale of LOCALES) {
      const members = table[locale];
      if (!members) throw new Error(`${entry.file}: ${entry.exportName} has no ${locale} member`);
      const same = Object.keys(members).sort().join('|') === [...keys].sort().join('|');
      if (!same) throw new Error(`${entry.file}: ${entry.exportName}.${locale} disagrees with .de about the key set`);
      for (const key of keys) {
        if (typeof members[key] !== 'string' || !members[key].trim()) throw new Error(`${entry.file}: ${entry.exportName}.${locale}.${key} is empty`);
      }
    }
    catalogues.push({ ...entry, keys, table });
  }
  return catalogues;
}

export async function readInstructions() {
  const module_ = await import(pathToFileURL(path.join(ROOT, 'public/assets/i18n/instructions.js')).href);
  const table = module_.INSTRUCTIONS;
  if (!table) throw new Error('instructions.js does not export INSTRUCTIONS');
  return table;
}

/**
 * The provenance self-check that ships inside instructions.js: each curated direction carries the
 * sha256 of its own German original. Recomputing it here is an independent reading of the file.
 */
export function instructionDigestProblems(instructions) {
  const problems = [];
  for (const [id, entry] of Object.entries(instructions)) {
    if (sha256(entry.original) !== entry.sourceSha256) problems.push(`${id}: sourceSha256 does not match its own original`);
    if (entry.translations.de !== entry.original) problems.push(`${id}: the de translation is not the original`);
    for (const locale of LOCALES) {
      if (typeof entry.translations[locale] !== 'string' || !entry.translations[locale].trim()) problems.push(`${id}: ${locale} is empty`);
    }
  }
  return problems;
}

export function readFallbackMaps() {
  const maps = [];
  for (const entry of FALLBACK_MAPS) {
    const values = objectLiteralStrings(readText(entry.file), entry.constName, entry.file);
    maps.push({ ...entry, values });
  }
  return maps;
}

/**
 * The <noscript> German and its four translations. The block is one string per language, repeated
 * verbatim in every shell that ships one; the four copies must agree, and that agreement is a
 * finding when it breaks rather than something this tool smooths over.
 */
export function readNoscriptMessages() {
  const findings = [];
  const perFile = [];
  for (const file of NOSCRIPT_FILES) {
    const text = readText(file);
    const blocks = [...text.matchAll(/<noscript[^>]*>([\s\S]*?)<\/noscript>/g)].map((match) => match[1]);
    if (blocks.length !== 1) {
      findings.push({ code: 'noscript_shape', detail: `${file}: expected exactly one <noscript> block, found ${blocks.length}` });
      continue;
    }
    const stripped = blocks[0].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const parts = stripped.split(/(?<=[.!?])\s+/).filter(Boolean);
    if (parts.length !== LOCALES.length) {
      findings.push({ code: 'noscript_shape', detail: `${file}: expected ${LOCALES.length} language sentences, split ${parts.length}` });
      continue;
    }
    perFile.push({ file, values: Object.fromEntries(LOCALES.map((locale, index) => [locale, parts[index]])) });
  }
  for (const locale of LOCALES) {
    const distinct = new Set(perFile.map((entry) => entry.values[locale]));
    if (distinct.size > 1) {
      findings.push({ code: 'noscript_disagreement', detail: `${locale}: the <noscript> copies differ across ${NOSCRIPT_FILES.join(', ')}` });
    }
  }
  const values = perFile.length ? Object.fromEntries(LOCALES.map((locale) => [locale, perFile[0].values[locale]])) : null;
  return { values, files: perFile.map((entry) => entry.file), findings };
}

/* ------------------------------------------------------------------ sources: the library */

/**
 * Tokenise one generated INSERT row: `('a', 'b', 3, '{"x":1}'::jsonb),`.
 * DELIBERATE DUPLICATION, recorded as residual risk in the implementation note: the same tokenizer
 * lives in `tools/library-i18n-check.mjs`, but that module runs its whole check suite on import, so
 * it cannot be reused as a library. The duplicate is held honest by `planGuideStrings`, which
 * REFUSES the bundle unless this parse produced the frozen source the bundle was generated from.
 */
function rowValues(line) {
  const text = line.trim().replace(/^\(/, '').replace(/\)\s*,?\s*$/, '');
  const values = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && (text[index] === ' ' || text[index] === ',')) index += 1;
    if (index >= text.length) break;
    if (text[index] === "'") {
      let value = '';
      index += 1;
      while (index < text.length) {
        if (text[index] !== "'") { value += text[index]; index += 1; continue; }
        if (text[index + 1] === "'") { value += "'"; index += 2; continue; }
        index += 1;
        break;
      }
      values.push(value);
    } else {
      const start = index;
      while (index < text.length && text[index] !== ',') index += 1;
      values.push(text.slice(start, index).trim());
    }
    while (index < text.length && text[index] !== ',') index += 1;
  }
  return values;
}

function insertRows(sql, table) {
  const lines = sql.split('\n');
  const marker = new RegExp(`INSERT INTO "__SCHEMA__"\\.${table}\\b`);
  const start = lines.findIndex((line) => marker.test(line));
  if (start < 0) return [];
  let index = start + 1;
  for (; index < lines.length; index += 1) {
    if (/^\s*VALUES\s*$/i.test(lines[index])) { index += 1; break; }
  }
  const rows = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (/ON CONFLICT/i.test(line)) break;
    if (!line.trim()) continue;
    if (!line.trim().startsWith('(')) break;
    rows.push(rowValues(line));
  }
  return rows;
}

function sqlStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (inString) {
      current += char;
      if (char === "'") { if (sql[index + 1] === "'") { current += sql[index + 1]; index += 1; } else inString = false; }
      continue;
    }
    if (char === "'") { inString = true; current += char; continue; }
    if (char === '-' && sql[index + 1] === '-') { while (index < sql.length && sql[index] !== '\n') index += 1; current += '\n'; continue; }
    if (char === ';') { statements.push(current); current = ''; continue; }
    current += char;
  }
  if (current.trim()) statements.push(current);
  return statements;
}

const sqlString = (literal) => {
  const text = literal.trim();
  if (!/^'(?:[^']|'')*'$/.test(text)) throw new Error(`unsupported correction value: ${text.slice(0, 60)}`);
  return text.slice(1, -1).replaceAll("''", "'");
};

const sqlSplit = (text, separator) => {
  const parts = [];
  let current = '';
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      current += char;
      if (char === "'") { if (text[index + 1] === "'") { current += text[index + 1]; index += 1; } else inString = false; }
      continue;
    }
    if (char === "'") { inString = true; current += char; continue; }
    const match = separator.exec(text.slice(index));
    if (match && match.index === 0) { parts.push(current); current = ''; index += match[0].length - 1; continue; }
    current += char;
  }
  parts.push(current);
  return parts;
};

const sqlPairs = (text, separator, what) => sqlSplit(text.trim(), separator).map((clause) => {
  const match = /^([a-z_]+)\s*=\s*('(?:[^']|'')*')(?:::[a-z_]+)?$/i.exec(clause.trim());
  if (!match) throw new Error(`unsupported correction ${what}: ${clause.trim().slice(0, 60)}`);
  return [match[1], sqlString(match[2])];
});

function sqlIndexOfKeyword(text, keyword) {
  let inString = false;
  const pattern = new RegExp(`^\\s+${keyword}\\b`, 'i');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "'") { if (text[index + 1] === "'") index += 1; else inString = false; }
      continue;
    }
    if (char === "'") { inString = true; continue; }
    if (/\s/.test(char) && pattern.test(text.slice(index))) return index;
  }
  return -1;
}

/**
 * Apply the corrections that later migrations make, so the offline source is the state a MIGRATED
 * database holds rather than the state the seed files wrote. A statement that targets a modelled
 * table and cannot be understood THROWS: a silently skipped correction would produce a pack whose
 * German source is one migration out of date, which is exactly the false-green this avoids.
 */
export function applyCorrections(sql, table, rows) {
  const applied = [];
  for (const statement of sqlStatements(sql)) {
    const match = new RegExp(`^\\s*UPDATE\\s+"__SCHEMA__"\\.${table}\\b([\\s\\S]*)$`, 'i').exec(statement);
    if (!match) continue;
    const whereIndex = sqlIndexOfKeyword(match[1], 'WHERE');
    if (whereIndex < 0) throw new Error(`${table}: correction statement has no WHERE`);
    const assignments = sqlPairs(match[1].slice(0, whereIndex).replace(/^\s*SET\s+/i, ''), /^\s*,\s*/, 'assignment');
    const conditions = sqlPairs(match[1].slice(whereIndex).replace(/^\s+WHERE\s+/i, ''), /^\s+AND\s+/i, 'condition');
    let matched = 0;
    for (const row of rows) {
      if (!conditions.every(([column, value]) => row[column] === value)) continue;
      for (const [column, value] of assignments) {
        if (!(column in row)) continue;
        row[column] = column === 'payload' ? JSON.parse(value) : value;
      }
      matched += 1;
    }
    if (matched !== 1) throw new Error(`${table}: correction matched ${matched} frozen rows, expected 1`);
    applied.push(`${table} ${conditions[0][1]}`);
  }
  return applied;
}

const SEED_MIGRATIONS = Object.freeze(['0012-noun-lexicon-catalogue.sql', '0013-guide-library.sql', '0014-writing-speaking-guides.sql']);

/** The frozen German/English source the bundle must agree with, offline, at the migrated state. */
export async function readFrozenSource() {
  const sql = Object.fromEntries(SEED_MIGRATIONS.map((file) => [file, readText(`server/migrations/${file}`)]));
  const entries = insertRows(sql[SEED_MIGRATIONS[0]], 'noun_entry').map((value) => ({
    entry_id: value[0], de: value[3], en: value[4], example: value[10], example_en: value[11], content_version_id: value[12],
  }));
  const sections = [];
  const guides = [];
  for (const file of SEED_MIGRATIONS.slice(1)) {
    for (const value of insertRows(sql[file], 'guide')) guides.push({ guide_id: value[0], content_version_id: value[9] });
    for (const value of insertRows(sql[file], 'guide_section')) {
      sections.push({
        guide_id: value[0], section_id: value[1], title: value[4], title_en: value[5],
        summary: value[6], summary_en: value[7], payload: JSON.parse(value[8]),
      });
    }
  }
  const model = [
    { table: 'noun_entry', rows: entries },
    { table: 'guide_section', rows: sections },
    { table: 'guide', rows: guides },
  ];
  const directory = path.join(ROOT, 'server/migrations');
  const later = readdirSync(directory)
    .filter((file) => /^\d{4}-.*\.sql$/.test(file) && file > '0014-').sort();
  const corrections = [];
  for (const file of later) {
    const text = readText(`server/migrations/${file}`);
    const applied = model.flatMap(({ table, rows }) => applyCorrections(text, table, rows));
    if (applied.length) corrections.push(`${file}: ${applied.join(', ')}`);
  }
  const versions = new Map(guides.map((row) => [row.guide_id, row.content_version_id]));
  return { entries, sections, guides, versions, corrections, model };
}

export const fieldParts = (fieldPath) => fieldPath.replace(/\[(\d+)\]/g, '.$1').split('.');

export function readField(section, fieldPath) {
  let cursor = section;
  for (const part of fieldParts(fieldPath)) {
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * The record of guide paths that `0043` left German-only, read out of the README fenced block that
 * `tools/library-render-check.mjs` also reads. It is the third source of truth in play, and a path
 * that disagrees with the bundle or with the German source is reported, not reconciled.
 */
export function readPendingRecord() {
  const readme = readText('content/library-translations/README.md');
  const block = /<!-- library-translation-pending:start -->[\s\S]*?```json\r?\n([\s\S]*?)\r?\n```/.exec(readme);
  if (!block) throw new Error('content/library-translations/README.md has no library-translation-pending block');
  const record = JSON.parse(block[1]);
  if (record.locales.join(',') !== TRANSLATION_LOCALES.join(',')) {
    throw new Error(`the pending record covers ${record.locales.join(',')}, expected ${TRANSLATION_LOCALES.join(',')}`);
  }
  return record;
}

/* ------------------------------------------------------------------ the census */

/** Everything the pack is built from, counted, before a single row is generated. */
export async function census() {
  const findings = [];
  const catalogues = await readInterfaceCatalogues();
  const instructions = await readInstructions();
  const fallbacks = readFallbackMaps();
  const noscript = readNoscriptMessages();
  findings.push(...noscript.findings);
  findings.push(...instructionDigestProblems(instructions).map((detail) => ({ code: 'instruction_provenance', detail })));

  const { bundle, digest } = await loadVerifiedBundle();
  const { guideStrings, nouns } = validateBundleShape(bundle);
  const source = await readFrozenSource();
  const guidePlan = planGuideStrings(bundle, source.sections, source.versions);
  const nounPlan = planNounRows(bundle, source.entries);
  const record = readPendingRecord();

  // The pending record against the two other sources: a rendered path must exist in the German
  // source and must NOT be served a translation; a removed path must be gone from the source.
  const pendingRows = [];
  for (const entry of record.pending) {
    const section = source.sections.find((row) => row.section_id === entry.section_id);
    if (!section) { findings.push({ code: 'pending_record_section_missing', detail: `${entry.section_id} names no guide_section` }); continue; }
    for (const fieldPath of entry.rendered) {
      const german = readField(section, fieldPath);
      const path_ = `${entry.guide_id}/${entry.section_id}.${fieldPath}`;
      if (typeof german !== 'string' || !german.trim()) {
        findings.push({ code: 'pending_record_no_german', detail: `${path_}: the source has no German string at ${fieldPath}` });
        continue;
      }
      if (Object.hasOwn(bundle.guides[entry.guide_id] ?? {}, path_)) {
        findings.push({ code: 'pending_record_but_translated', detail: `${path_} is recorded as pending but the bundle carries a translation` });
        continue;
      }
      pendingRows.push({ guide_id: entry.guide_id, section_id: entry.section_id, field_path: fieldPath, path: path_, german });
    }
    for (const fieldPath of entry.removed) {
      const path_ = `${entry.guide_id}/${entry.section_id}.${fieldPath}`;
      const german = readField(section, fieldPath);
      if (typeof german === 'string' && german.trim()) {
        findings.push({ code: 'pending_record_removed_still_in_source', detail: `${path_} is recorded as removed but the source still carries German` });
      }
    }
  }

  return {
    findings, catalogues, instructions, fallbacks, noscript, bundle, digest,
    source, guidePlan, nounPlan, record, pendingRows,
    counts: {
      guideStrings, nouns,
      catalogueKeys: catalogues.reduce((total, entry) => total + entry.keys.length, 0),
      instructions: Object.keys(instructions).length,
      fallbacks: fallbacks.length,
      noscriptStrings: noscript.values ? 1 : 0,
      frozenNounEntries: source.entries.length,
      frozenGuideSections: source.sections.length,
      frozenGuides: source.guides.length,
      boundGuideStrings: guidePlan.rows.length,
      boundNounRows: nounPlan.rows.length,
    },
  };
}

/* ------------------------------------------------------------------ the reference scan */

/**
 * Where each interface key is rendered, from a scan of the shipped files. This is the "place it
 * appears" column, and it says how it was found:
 *
 *   - `exact` bindings: the key appears in a `uiText("…")`, `data-i18n="ns.key"`, `pt/pl/pa("…")`
 *     or `data-practice-key="…"` position, so the file really does render it;
 *   - `literal` mentions: the key name appears in the file as a quoted literal (a state machine
 *     assigning `boundaryMessage = 'boundaryAudio'`, say) but no binding pattern matched, so the
 *     file refers to it without proving where it lands;
 *   - neither: reported as `not located by the static reference scan`, with the catalogue's own
 *     area, and counted in the census. Those keys are the candidate dead-copy list; a key nothing
 *     in the shipped client mentions is either unused or rendered by a mechanism no static scan can
 *     follow, and both are worth a human's attention.
 */
export function referenceScan(catalogues = []) {
  const exact = new Map();
  const literal = new Map();
  const byKeyName = new Map();
  for (const catalogue of catalogues) {
    for (const key of catalogue.keys) {
      if (!byKeyName.has(key)) byKeyName.set(key, new Set());
      byKeyName.get(key).add(catalogue.namespace);
    }
  }
  const add = (map, qualified, surface) => {
    if (!map.has(qualified)) map.set(qualified, new Set());
    map.get(qualified).add(surface);
  };
  for (const file of Object.keys(SURFACES)) {
    if (!existsSync(path.join(ROOT, file))) continue;
    const text = readText(file);
    const surface = SURFACES[file];
    const patterns = [
      [/uiText\(\s*["']([A-Za-z0-9_.]+)["']/g, 'shell'],
      [/messageMarkup\(\s*["']([A-Za-z0-9_.]+)["']/g, 'shell'],
      [/["'](m\d{3})["']/g, 'shell'],
      [/data-i18n="([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)"/g, null],
      [/data-i18n=\\"([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)\\"/g, null],
      [/data-i18n-(?:aria-label|title|placeholder|alt)="([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)"/g, null],
      [/data-i18n-(?:aria-label|title|placeholder|alt)=\\"([A-Za-z0-9_]+\.[A-Za-z0-9_.]+)\\"/g, null],
      [/\b(?:pt|pl)\(\s*["']([A-Za-z0-9_]+)["']/g, 'practice'],
      [/\bpa\(\s*["'][a-z-]+["']\s*,\s*["']([A-Za-z0-9_]+)["']/g, 'practice'],
      [/\bbindPracticeText\([^,]+,\s*["']([A-Za-z0-9_]+)["']/g, 'practice'],
      [/data-practice-(?:key|aria-label|title|placeholder)="([A-Za-z0-9_]+)"/g, 'practice'],
    ];
    for (const [pattern, namespace] of patterns) {
      for (const match of text.matchAll(pattern)) {
        const qualified = match[1].includes('.') ? match[1] : `${namespace}.${match[1]}`;
        add(exact, qualified, surface);
      }
    }
    // A quoted literal that names a real key: a reference, not proof of where it lands.
    for (const match of text.matchAll(/["'`]([A-Za-z][A-Za-z0-9_]*)["'`]/g)) {
      for (const namespace of byKeyName.get(match[1]) ?? []) add(literal, `${namespace}.${match[1]}`, surface);
    }
  }
  const findings = [];
  void findings;
  return { exact, literal, findings, locate(qualified) {
    const exactSurfaces = exact.get(qualified);
    if (exactSurfaces) return [...exactSurfaces].sort().join(' · ');
    const literals = literal.get(qualified);
    if (literals) return `referenced in ${[...literals].sort().join(' · ')} (no binding pattern matched, so the exact screen is not proven)`;
    return null;
  } };
}

/* ------------------------------------------------------------------ rows */

const SECTION_ORDER = Object.freeze([
  'interface/shell', 'interface/practice', 'interface/public', 'interface/auth', 'interface/common',
  'interface/instructions', 'interface/fallbacks', 'interface/html',
  'library/guides', 'library/nouns',
]);

const NO_SOURCE_NOTE = '(no German source text: this is a translator-authored rule label bound to the headword)';

function interfaceRows(data, language, scan) {
  const rows = [];
  for (const catalogue of data.catalogues) {
    for (const key of catalogue.keys) {
      const qualified = `${catalogue.namespace}.${key}`;
      rows.push({
        id: `ui/${qualified}`,
        language,
        section: `interface/${catalogue.namespace}`,
        where: scan.locate(qualified) ?? `not located by the static reference scan (${catalogue.area})`,
        kind: 'interface',
        needs_translation: language === 'de' ? 'no' : 'yes',
        source_kind: 'catalogue-source',
        source_de: catalogue.table.de[key],
        source_note: '',
        source_file: catalogue.file,
        source_locator: `${catalogue.namespace}.${language}.${key}`,
        current: language === 'de' ? catalogue.table.de[key] : catalogue.table[language][key],
        status: 'machine_unreviewed',
      });
    }
  }
  for (const [id, entry] of Object.entries(data.instructions)) {
    rows.push({
      id: `ui/instructions.${id}`,
      language,
      section: 'interface/instructions',
      where: INSTRUCTION_SURFACES[id] ?? `not located by the static reference scan (examLanguage=${entry.examLanguage})`,
      kind: entry.examLanguage === language ? 'exam-language' : 'interface',
      needs_translation: language === 'de' ? 'no' : 'yes',
      source_kind: 'instruction-original',
      source_de: entry.original,
      source_note: `examLanguage=${entry.examLanguage}, version ${entry.version}, sha256 ${entry.sourceSha256.slice(0, 12)}…`,
      source_file: 'public/assets/i18n/instructions.js',
      source_locator: language === 'de' ? `INSTRUCTIONS["${id}"].original` : `INSTRUCTIONS["${id}"].translations.${language}`,
      current: language === 'de' ? entry.original : entry.translations[language],
      status: 'machine_unreviewed',
    });
  }
  for (const map of data.fallbacks) {
    rows.push({
      id: `ui/${map.id}`,
      language,
      section: 'interface/fallbacks',
      where: `${map.area} — ${map.usage}`,
      kind: 'interface',
      needs_translation: language === 'de' ? 'no' : 'yes',
      source_kind: 'fallback-map',
      source_de: map.values.de,
      source_note: `declared in ${map.file} as \`${map.constName}\`; not reachable through a catalogue export`,
      source_file: map.file,
      source_locator: `const ${map.constName}.${language}`,
      current: map.values[language],
      status: 'machine_unreviewed',
    });
  }
  if (data.noscript.values) {
    rows.push({
      id: 'ui/html.noscript',
      language,
      section: 'interface/html',
      where: `<noscript> pre-JavaScript note on ${data.noscript.files.map((file) => file.replace('public/', '/')).join(', ')}`,
      kind: 'interface',
      needs_translation: language === 'de' ? 'no' : 'yes',
      source_kind: 'html-inline',
      source_de: data.noscript.values.de,
      source_note: 'one sentence per language, hardcoded in every shell that ships a <noscript> block',
      source_file: data.noscript.files.join(' '),
      source_locator: `<noscript> sentence #${LOCALES.indexOf(language) + 1} of ${LOCALES.length} (de, en, uk, ar, tr)`,
      current: data.noscript.values[language],
      status: 'machine_unreviewed',
    });
  }
  return rows;
}

function guideRows(data, language) {
  const rows = [];
  /*
   * The bundle carries uk/ar/tr only, so the German pack is built from the German side of the same
   * binding: one row per path, deduplicated across the three locales the plan repeats it for. Both
   * packs therefore carry the same 722 guide paths, which is what makes "the German is there and the
   * translation is missing" checkable rather than asserted.
   */
  const seen = new Set();
  for (const row of data.guidePlan.rows) {
    if (language === 'de') {
      if (seen.has(row.path)) continue;
      seen.add(row.path);
      rows.push(guideRow(row, language, row.german, 'machine_unreviewed'));
      continue;
    }
    if (row.locale !== language) continue;
    rows.push(guideRow(row, language, row.text, 'machine_unreviewed'));
  }
  for (const row of data.pendingRows) {
    rows.push({
      id: `lib/guide/${row.path}`,
      language,
      section: `library/guides/${row.guide_id}`,
      where: `#/nachschlagen › ${row.guide_id} › ${row.section_id} › ${row.field_path}`,
      kind: 'guidance',
      needs_translation: language === 'de' ? 'no' : 'yes',
      source_kind: 'frozen-german',
      source_de: row.german,
      source_note: 'recorded in content/library-translations/README.md as German-only until a human re-translates it (0043 changed the German)',
      source_file: 'content/library-translations/hatoove-library-translations-uk-ar-tr.json',
      source_locator: `guides["${row.guide_id}"]["${row.path}"].${language} (MISSING: a new translation goes through the importer, not an edit here)`,
      current: language === 'de' ? row.german : '',
      status: language === 'de' ? 'machine_unreviewed' : 'pending',
    });
  }
  return rows;
}

function guideRow(row, language, current, status) {
  return {
    id: `lib/guide/${row.path}`,
    language,
    section: `library/guides/${row.guide_id}`,
    where: `#/nachschlagen › ${row.guide_id} › ${row.section_id} › ${row.field_path}`,
    kind: 'guidance',
    needs_translation: language === 'de' ? 'no' : 'yes',
    source_kind: 'frozen-german',
    source_de: row.german,
    source_note: `guide_section ${row.section_id}, source ${row.source_content_version}`,
    source_file: language === 'de'
      ? 'server/migrations (seed 0013/0014; a German correction ships as a new forward migration, see 0043)'
      : 'content/library-translations/hatoove-library-translations-uk-ar-tr.json',
    source_locator: language === 'de'
      ? `guide_section["${row.section_id}"].${row.field_path}`
      : `guides["${row.guide_id}"]["${row.path}"].${language}`,
    current,
    status,
  };
}

function nounRows(data, language) {
  const rows = [];
  const BUNDLE_FILE = 'content/library-translations/hatoove-library-translations-uk-ar-tr.json';
  for (const [entryId, members] of Object.entries(data.bundle.nouns)) {
    const base = {
      language,
      section: 'library/nouns',
      where: `#/wortschatz › Nomen & Genus › ${members.de}`,
      source_note: `noun_entry ${entryId}`,
    };
    if (language === 'de') {
      rows.push({
        ...base,
        id: `lib/noun/${entryId}/german-headword`,
        kind: 'exam-language',
        needs_translation: 'no',
        source_kind: 'frozen-german',
        source_de: members.de,
        source_file: 'server/migrations/0012-noun-lexicon-catalogue.sql',
        source_locator: `noun_entry["${entryId}"].de`,
        current: members.de,
        status: 'not-applicable',
        source_note: `${base.source_note} — German headword, exam/reference language, never translated`,
      });
      rows.push({
        ...base,
        id: `lib/noun/${entryId}/german-example`,
        kind: 'exam-language',
        needs_translation: 'no',
        source_kind: 'frozen-german',
        source_de: members.example_de,
        source_file: 'server/migrations/0012-noun-lexicon-catalogue.sql',
        source_locator: `noun_entry["${entryId}"].example`,
        current: members.example_de,
        status: 'not-applicable',
        source_note: `${base.source_note} — German example sentence, exam/reference language, never translated`,
      });
      continue;
    }
    const locale = members[language];
    for (const [field, id, source, sourceField] of [
      ['meaning', 'meaning', members.de, 'de'],
      ['example', 'example', members.example_de, 'example'],
    ]) {
      rows.push({
        ...base,
        id: `lib/noun/${entryId}/${id}`,
        kind: 'guidance',
        needs_translation: 'yes',
        source_kind: 'frozen-german',
        source_de: source,
        source_file: BUNDLE_FILE,
        source_locator: `nouns["${entryId}"].${language}.${field} (German source: ${sourceField})`,
        current: locale[field],
        status: 'machine_unreviewed',
      });
    }
    rows.push({
      ...base,
      id: `lib/noun/${entryId}/rule`,
      kind: 'guidance',
      needs_translation: 'yes',
      source_kind: 'translator-label',
      source_de: '',
      source_note: `${base.source_note} — ${NO_SOURCE_NOTE}`,
      source_file: BUNDLE_FILE,
      source_locator: `nouns["${entryId}"].${language}.rule`,
      current: locale.rule,
      status: 'machine_unreviewed',
    });
  }
  return rows;
}

/** The pack's own order: interface first, then the library, so a reviewer reads the app as it reads. */
const sectionRank = (section) => {
  const index = SECTION_ORDER.findIndex((known) => section === known || section.startsWith(`${known}/`));
  return index < 0 ? SECTION_ORDER.length : index;
};

/** Every row of one language's pack, in the pack's own order. */
export function enumerateRows(data, language, scan) {
  if (!LOCALES.includes(language)) throw new Error(`unknown language ${language}`);
  const rows = [...interfaceRows(data, language, scan), ...guideRows(data, language), ...nounRows(data, language)];
  rows.sort((left, right) => {
    const section = sectionRank(left.section) - sectionRank(right.section);
    return section !== 0 ? section : left.id.localeCompare(right.id, 'en');
  });
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Error(`${language}: duplicate row id ${row.id}`);
    seen.add(row.id);
    row.decision = '';
    row.correction = '';
    row.note = '';
    row.reviewer = '';
  }
  return rows;
}

/* ------------------------------------------------------------------ the ledger */

export function ledgerPath(ledgerDir, language) {
  return path.join(ledgerDir, `${language}-ledger.json`);
}

/**
 * Apply a human decision ledger to freshly enumerated rows. This is the only way `approved` can
 * reach a row: the entry must name a reviewer, and it must have been decided against the same text
 * the pack carries now. A stale approval is dropped back to `machine_unreviewed` and reported.
 */
export function applyLedger(rows, language, ledger, findings) {
  if (!ledger) return { applied: 0, stale: 0, unknown: 0 };
  if (ledger.format !== LEDGER_FORMAT) throw new Error(`${language}-ledger.json: unexpected format ${JSON.stringify(ledger.format)}`);
  if (ledger.language !== language) throw new Error(`${language}-ledger.json: covers ${ledger.language}`);
  const byId = new Map(rows.map((row) => [row.id, row]));
  let applied = 0;
  let stale = 0;
  let unknown = 0;
  for (const entry of ledger.entries ?? []) {
    const row = byId.get(entry.id);
    if (!row) { unknown += 1; findings.push({ code: 'ledger_entry_has_no_row', detail: `${language}: ledger entry ${entry.id} has no row in this pack` }); continue; }
    if (!entry.decided_by || !String(entry.decided_by).trim()) {
      findings.push({ code: 'ledger_entry_without_reviewer', detail: `${language}: ${entry.id} carries a decision with no reviewer` });
      continue;
    }
    if (entry.text_at_review !== row.current) {
      stale += 1;
      findings.push({ code: 'stale_approval', detail: `${language}: ${entry.id} was decided against different text; the decision no longer applies` });
      continue;
    }
    row.reviewer = entry.decided_by;
    row.note = entry.note ?? '';
    if (entry.decision === 'approved') { row.status = 'approved'; row.correction = ''; }
    else if (entry.decision === 'fix') { row.status = 'pending'; row.correction = entry.correction ?? ''; }
    else if (entry.decision === 'reject') { row.status = 'pending'; row.correction = ''; }
    else if (entry.decision === 'not-applicable') { row.status = 'not-applicable'; row.correction = ''; }
    else { findings.push({ code: 'ledger_unknown_decision', detail: `${language}: ${entry.id} carries decision ${JSON.stringify(entry.decision)}` }); continue; }
    applied += 1;
  }
  return { applied, stale, unknown };
}

/* ------------------------------------------------------------------ emit */

const escapePipes = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').replace(/\s+$/, '');
const csvCell = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const CSV_COLUMNS = Object.freeze([
  'id', 'language', 'section', 'where', 'kind', 'needs_translation', 'source_kind', 'source_de',
  'source_note', 'source_file', 'source_locator', 'current', 'status', 'decision', 'correction',
  'note', 'reviewer',
]);

export function packCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}

/**
 * Read a pack CSV back. A record whose column count does not match the header is REPORTED rather
 * than dropped: a spreadsheet that added or lost a column must not look like "the reviewer filled
 * nothing in", which is the one failure mode that would silently lose a human's work.
 */
export function packCsvRows(text) {
  const records = [];
  let cell = '';
  let record = [];
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1; } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { record.push(cell); cell = ''; continue; }
    if (char === '\n') { record.push(cell); records.push(record); record = []; cell = ''; continue; }
    if (char === '\r') continue;
    cell += char;
  }
  if (cell || record.length) { record.push(cell); records.push(record); }
  const header = records.shift() ?? [];
  const rows = [];
  const malformed = [];
  for (const line of records) {
    const blank = line.length === 1 && line[0].trim() === '';
    if (blank) continue;
    if (line.length !== header.length) {
      malformed.push({ id: line[0] || '(no id)', cells: line.length, expected: header.length });
      continue;
    }
    rows.push(Object.fromEntries(header.map((name, index) => [name, line[index]])));
  }
  return { header, rows, malformed };
}

const STATUS_LABEL = Object.freeze({
  machine_unreviewed: 'machine_unreviewed — nobody has judged it',
  pending: 'pending — a decision or a re-translation is owed',
  approved: 'approved — a named reviewer accepted this exact text',
  'not-applicable': 'not-applicable — exam-language German; no translation is owed',
});

const DECISION_HELP = `Fill the **decision** column and send the file back. Nothing here is approved
until a human writes it down.

| decision | meaning | what else is required |
|---|---|---|
| \`ok\` | the text is good as it stands | — |
| \`fix\` | the text must change | put the replacement in **correction** |
| \`reject\` | the text is wrong and should not ship | put the reason in **note** |
| \`na\` | no translation is owed here | put the reason in **note** |

Leave the column empty for "not looked at yet". Empty is a real answer: it means the string is
still unreviewed, and the pack will keep saying so.

In a decision **file** the same four values are written out: \`approved\`, \`fix\`, \`reject\`,
\`not-applicable\`. \`ok\` and \`na\` are the spreadsheet spellings of the first and the last.

Return path — either of:

1. **Spreadsheet (easiest).** Edit \`<language>-rows.csv\` and run
   \`node tools/apply-review-decisions.mjs --csv <language>-rows.csv --reviewer "<your name>"\`.
2. **Decision file.** Copy \`<language>-decisions.template.json\`, fill \`reviewer\` and one entry per
   string you actually judged, and run \`node tools/apply-review-decisions.mjs --json <file>\`.

Either way the applier writes \`<language>-ledger.json\` (who decided what, against which text) and
\`<language>-corrections.csv\` (the exact edits the program must make). It never edits the
catalogues or the translation bundle — that is a separate, owned step — and it cannot approve
anything you did not approve.`;

function reviewDocument(language, rows, data, ledgerSummary) {
  const counts = new Map();
  for (const row of rows) counts.set(row.section, (counts.get(row.section) ?? 0) + 1);
  const needs = rows.filter((row) => row.needs_translation === 'yes').length;
  const byStatus = new Map();
  for (const row of rows) byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
  const lines = [];
  lines.push(`# Hatoove review pack — ${LANGUAGE_LABEL[language]}`);
  lines.push('');
  lines.push(`Generated by \`tools/build-review-pack.mjs\` (${PACK_FORMAT}) from the repository sources at the`);
  lines.push('commit the tool was run at. This is derived output and is gitignored; the sources it reads are not.');
  lines.push('');
  lines.push(`**${rows.length} strings** in this pack.`);
  if (language === 'de') {
    lines.push('None of them owes a translation: German is the language the app is written in and the language');
    lines.push('the exam is taken in. This pack is here so one German reviewer can read the whole interface and');
    lines.push('guidance copy in one pass and say whether it is formal, clear and consistent — including the');
    lines.push('German that the other three packs show as their source.');
  } else {
    lines.push(`Of these, **${needs}** owe a translation or a wording decision for this language. The German source`);
    lines.push('is printed for every row so you can judge the translation without opening a single key.');
  }
  lines.push('');
  lines.push('## What you are being asked to do');
  lines.push('');
  lines.push('Read the German and the current text side by side and say, for each string, whether the current');
  lines.push('text says the same thing in your language — natural, formal (never informal), and correct for a');
  lines.push('language exam. You are not asked to check the German against the exam; that is the German');
  lines.push('reviewer\'s pass. Where a German word is deliberately left in German (grammar terms, example');
  lines.push('sentences, the exam\'s own language), that is by design, not an omission.');
  lines.push('');
  lines.push('## How to return your decisions');
  lines.push('');
  lines.push(DECISION_HELP);
  lines.push('');
  lines.push('## Census for this pack');
  lines.push('');
  lines.push('| section | rows |');
  lines.push('|---|---|');
  for (const section of SECTION_ORDER) if (counts.has(section)) lines.push(`| \`${section}\` | ${counts.get(section)} |`);
  lines.push(`| **total** | **${rows.length}** |`);
  lines.push('');
  lines.push('Status of this pack right now: ' + [...byStatus.entries()].map(([status, number]) => `${number} × ${STATUS_LABEL[status] ?? status}`).join('; ') + '.');
  if (ledgerSummary) {
    lines.push('');
    lines.push(`A decision ledger was applied: ${ledgerSummary.applied} row(s) carry a human decision, ${ledgerSummary.stale} approval(s) were dropped as stale because the text changed after they were made.`);
  }
  lines.push('');
  lines.push('## What is deliberately NOT in this pack');
  lines.push('');
  lines.push(...EXCLUSIONS.map((entry) => `- ${entry}`));
  lines.push('');
  lines.push('## The strings');
  lines.push('');
  lines.push('The table repeats the German source and the current text in full. The decision column is empty on');
  lines.push('purpose. The companion `<language>-rows.csv` carries the same rows with `correction` and `note`');
  lines.push('columns; use that file to record decisions.');
  lines.push('');
  let currentSection = null;
  for (const row of rows) {
    if (row.section !== currentSection) {
      currentSection = row.section;
      lines.push(`### ${currentSection} — ${counts.get(currentSection)} ${counts.get(currentSection) === 1 ? 'row' : 'rows'}`);
      lines.push('');
      lines.push('| id | where it appears | German source | current text | status | decision |');
      lines.push('|---|---|---|---|---|---|');
    }
    lines.push(`| \`${escapePipes(row.id)}\` | ${escapePipes(row.where)} | ${escapePipes(row.source_de) || '—'} | ${escapePipes(row.current) || '— (German only; translation owed)'} | ${row.status}${row.reviewer ? ` (${escapePipes(row.reviewer)})` : ''} | |`);
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

const EXCLUSIONS = Object.freeze([
  '**Exam-language content.** The exam sets, passages, items, keys and writing tasks stay in German and are not translated, so they are not rows here. The noun headwords and German example sentences that do appear in the guide and lexicon views are German reference language for the same reason; they are listed with status `not-applicable` in the German pack and appear as the German source of the translation rows elsewhere.',
  '**Held listening scripts (POOL-01 batch 1).** The new HV scripts are authored but their audio is held until the media mount and Ron\'s ruling on the recording files land. Nothing that is not in the repository can be reviewed here.',
  '**Content that is not authored yet.** A guide section that does not exist has no string; this pack lists what ships today, not what is planned.',
  '**The 15 guide fields `0043` removed** (`speaking-guide` Teil 1 had a different task shape before the correction). They no longer exist in the source, so nothing renders and nothing can be reviewed. The 18 fields that survived with changed German ARE in this pack as `pending` rows with no translation.',
  '**English.** It ships as a fifth interface language and the same builder covers it (`--languages en`), but Ron named uk, ar and tr for native review plus de for the interface copy, so en is out of this round.',
  '**Rendered pixels and audio.** This pack proves the text, not what a browser paints or what a recording sounds like. Layout, RTL mirroring and playback have their own checks and evidence.',
]);

function censusMarkdown(data, packs, scanStats) {
  const lines = [];
  lines.push('# REVIEW-PACK-01 — census, per source, before anything was generated');
  lines.push('');
  lines.push('Every count below came from reading the source itself (an import for the catalogues, a JSON parse for');
  lines.push('the bundle, the seed migrations for the frozen German, a static extraction for the fallback maps and the');
  lines.push('`<noscript>` text). None of it is a hand-written list.');
  lines.push('');
  lines.push('| source | what it is | strings |');
  lines.push('|---|---|---|');
  let catalogueTotal = 0;
  for (const catalogue of data.catalogues) {
    catalogueTotal += catalogue.keys.length;
    lines.push(`| \`${catalogue.file}\` (\`${catalogue.namespace}\`) | ${catalogue.area} | ${catalogue.keys.length} keys × 5 locales |`);
  }
  lines.push(`| \`${'public/assets/i18n/instructions.js'}\` (\`INSTRUCTIONS\`) | curated exam directions, German original + 4 translations | ${Object.keys(data.instructions).length} ids × (1 original + 4 translations) |`);
  lines.push(`| fallback maps (\`core.unavailable\`, \`instructions.unavailable\`, \`instructions.originalUnavailable\`) | learner-facing text shown when a key or a translation does not resolve | ${data.fallbacks.length} × 5 locales |`);
  lines.push(`| \`<noscript>\` blocks in ${NOSCRIPT_FILES.length} shells | pre-JavaScript German + 4 translations, identical in every copy | 1 × 5 locales |`);
  lines.push(`| \`content/library-translations/hatoove-library-translations-uk-ar-tr.json\` guides | guide strings bound to the frozen German source | ${data.counts.guideStrings} paths × (en, uk, ar, tr) |`);
  lines.push(`| \`content/library-translations/hatoove-library-translations-uk-ar-tr.json\` nouns | lexicon entries: headword, English, German example, English example, then meaning/example/rule per locale | ${data.counts.nouns} entries |`);
  lines.push(`| \`content/library-translations/README.md\` pending block | guide paths that migration 0043 left German-only | ${data.pendingRows.length} rendered, ${data.record.pending.flatMap((entry) => entry.removed).length} removed |`);
  lines.push('');
  lines.push('## Facts that pin the census');
  lines.push('');
  lines.push(`- Frozen German source parsed from ${SEED_MIGRATIONS.join(', ')}: ${data.counts.frozenGuides} guides, ${data.counts.frozenGuideSections} guide sections, ${data.counts.frozenNounEntries} noun entries.`);
  lines.push(`- Corrections from later migrations applied to that source: ${data.source.corrections.length ? data.source.corrections.join('; ') : 'none'}.`);
  lines.push(`- The importer bound all ${data.counts.boundGuideStrings} guide strings (${data.counts.guideStrings} paths × 3 locales) and all ${data.counts.boundNounRows} noun rows (${data.counts.nouns} × 3 × 3): every path names a real section and field, every \`en\` member equals the source's own English field, and no German fragment was altered.`);
  lines.push(`- Bundle sha256 ${data.digest.slice(0, 16)}…, status \`machine-unreviewed\`, languages ${TRANSLATION_LOCALES.join(', ')}.`);
  lines.push(`- Catalogue key sets agree across all five locales in every catalogue, and every catalogue string\'s placeholder set agrees with its German original.`);
  lines.push(`- Every one of the ${Object.keys(data.instructions).length} curated instructions carries a \`sourceSha256\` that matches its own German original when recomputed here.`);
  lines.push('');
  lines.push('## Packs generated');
  lines.push('');
  lines.push('| pack | rows | owing a decision | csv bytes | md bytes |');
  lines.push('|---|---|---|---|---|');
  for (const pack of packs) {
    lines.push(`| \`${pack.language}\` | ${pack.rows.length} | ${pack.needs} | ${pack.csvBytes} | ${pack.mdBytes} |`);
  }
  lines.push('');
  lines.push('## Where the interface keys appear');
  lines.push('');
  lines.push('The `where it appears` column of each pack comes from a static scan of the shipped client. It says how');
  lines.push('each key was found, because "this file renders it" and "this file mentions it" are different claims.');
  lines.push('');
  lines.push('| how it was found | keys |');
  lines.push('|---|---|');
  lines.push(`| bound exactly (\`uiText("…")\`, \`data-i18n="ns.key"\`, \`pt/pl/pa("…")\`, \`data-practice-key="…"\`) | ${scanStats.exactlyBound} |`);
  lines.push(`| mentioned as a quoted literal, no binding pattern matched (the pack says which files) | ${scanStats.onlyMentioned} |`);
  lines.push(`| **mentioned nowhere in the shipped client** — candidate dead copy, listed below | ${scanStats.unlocated} |`);
  lines.push('');
  if (scanStats.unlocated) {
    lines.push('A key nothing mentions is not proven wrong: it may be rendered by a mechanism no static scan can');
    lines.push('follow, and the interface catalogue is also read by the German reviewer, who needs the whole set.');
    lines.push('It is still the list to look at before calling the catalogue clean. All of them:');
    lines.push('');
    lines.push('```text');
    for (const qualified of scanStats.unlocatedAll) lines.push(qualified);
    lines.push('```');
    lines.push('');
  }
  lines.push('## Findings: places where two sources disagree');
  lines.push('');
  if (!data.findings.length) {
    lines.push('None. The catalogues agree with each other, the bundle agrees with the frozen German source, the');
    lines.push('pending record agrees with both, and the instruction digests verify.');
  } else {
    for (const finding of data.findings) lines.push(`- \`${finding.code}\` — ${finding.detail}`);
  }
  lines.push('');
  lines.push('## Duplicated German inside one catalogue');
  lines.push('');
  lines.push('Reported, not treated as a defect: the same German sentence under several keys is normal shared copy.');
  lines.push('');
  for (const catalogue of data.catalogues) {
    const byText = new Map();
    for (const key of catalogue.keys) {
      const text = catalogue.table.de[key];
      if (!byText.has(text)) byText.set(text, []);
      byText.get(text).push(key);
    }
    const duplicated = [...byText.entries()].filter(([, keys]) => keys.length > 1);
    if (duplicated.length) {
      lines.push(`- \`${catalogue.namespace}\`: ${duplicated.length} German string(s) on more than one key, e.g. ${duplicated.slice(0, 3).map(([text, keys]) => `${keys.join('/')} = ${JSON.stringify(text.slice(0, 40))}`).join('; ')}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function readme(data, packs, outDir) {
  const lines = [];
  lines.push('# Hatoove — wholesale review packs for native speakers');
  lines.push('');
  lines.push('Ron asked for an easy format to review the whole app in one pass per language. These are the packs.');
  lines.push('The directory these files live in is the `--out` directory given to the command below; it is not named');
  lines.push('inside this document, so that two builds produce byte-identical output.');
  lines.push('');
  lines.push('| language | reviewer document | machine-readable rows | rows |');
  lines.push('|---|---|---|---|');
  for (const pack of packs) {
    lines.push(`| ${pack.language} | \`${pack.language}-review.md\` | \`${pack.language}-rows.csv\` | ${pack.rows.length} |`);
  }
  lines.push('');
  lines.push('Everything here is **derived** and gitignored. Regenerate with:');
  lines.push('');
  lines.push('```text');
  lines.push('node tools/build-review-pack.mjs --out <pack-dir>');
  lines.push('```');
  lines.push('');
  lines.push('Completeness is checked, not claimed:');
  lines.push('');
  lines.push('```text');
  lines.push('node tools/review-pack-check.mjs                        # builds into %TEMP% and checks that build');
  lines.push('node tools/review-pack-check.mjs --pack-dir <pack-dir>  # checks the packs that were delivered');
  lines.push('```');
  lines.push('');
  lines.push('## Reading order for a reviewer');
  lines.push('');
  lines.push('1. Read `<language>-review.md` top to bottom. The first section says what is being asked; the census');
  lines.push('   says how big the job is; then the strings are grouped exactly the way the app is grouped, so you');
  lines.push('   read a screen\'s copy together instead of hunting keys.');
  lines.push('2. Open `<language>-rows.csv` in a spreadsheet and fill `decision`, plus `correction` for `fix` and');
  lines.push('   `note` for `reject`/`na`. Leave rows you have not reached empty.');
  lines.push('3. Send the CSV (or a filled decision JSON) back. Whoever receives it runs');
  lines.push('   `node tools/apply-review-decisions.mjs --csv <file> --reviewer "<name>"`.');
  lines.push('4. On the next build the pack shows `approved` plus the reviewer\'s name for every string that was');
  lines.push('   accepted, and `pending` with the correction for every string that was not. That is the answer to');
  lines.push('   "is this string reviewed?" — and it only ever comes from a human\'s written decision.');
  lines.push('');
  lines.push('A string may only be marked `approved` by that human act. No script in this repository approves');
  lines.push('anything, and `tools/review-pack-check.mjs` fails a pack in which an approved row has no recorded');
  lines.push('reviewer, or whose approval no longer matches the text.');
  lines.push('');
  lines.push('## The census');
  lines.push('');
  lines.push('See `CENSUS.md` (and `census.json` for the machine-readable form).');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function decisionTemplate(language) {
  return `${JSON.stringify({
    format: DECISION_FORMAT,
    language,
    reviewer: '',
    reviewed_at: '',
    how_to_fill: 'Set reviewer to the name of the human who made these decisions, reviewed_at to the date (YYYY-MM-DD), and add one entry per string you judged. Leave out strings you did not reach: they stay unreviewed. decision is one of approved, fix, reject, not-applicable. fix requires correction. reject and not-applicable require note.',
    decisions: [
      { id: 'ui/shell.m047', decision: 'approved', note: '' },
      { id: 'ui/practice.drillTitle', decision: 'fix', correction: 'Einzelübungen', note: 'example: replacement text the reviewer wants' },
    ],
    example_only: 'The two entries above are an example of the shape. Delete them before sending: an id that is not in your pack is refused, and the applier records only what you write.',
  }, null, 2)}\n`;
}

function outputPaths(outDir, language) {
  return {
    md: path.join(outDir, `${language}-review.md`),
    csv: path.join(outDir, `${language}-rows.csv`),
    template: path.join(outDir, `${language}-decisions.template.json`),
  };
}

export async function build(options = {}) {
  const outDir = path.resolve(options.out ?? path.join(ROOT, 'handoff', 'ron-agent', 'review-packs'));
  const languages = options.languages ?? PACK_LANGUAGES;
  const ledgerDir = path.resolve(options.ledgerDir ?? outDir);
  const data = await census();
  const scan = referenceScan(data.catalogues);
  const qualifiedKeys = data.catalogues.flatMap((catalogue) => catalogue.keys.map((key) => `${catalogue.namespace}.${key}`));
  const unlocated = qualifiedKeys.filter((qualified) => scan.locate(qualified) === null);
  const scanStats = {
    keys: qualifiedKeys.length,
    exactlyBound: qualifiedKeys.filter((qualified) => scan.exact.has(qualified)).length,
    onlyMentioned: qualifiedKeys.filter((qualified) => !scan.exact.has(qualified) && scan.literal.has(qualified)).length,
    unlocated: unlocated.length,
    unlocatedAll: unlocated,
    unlocatedSample: unlocated.slice(0, 20),
  };
  const packs = [];
  for (const language of languages) {
    const rows = enumerateRows(data, language, scan);
    const findings = [...data.findings];
    const file = ledgerPath(ledgerDir, language);
    const ledger = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
    const ledgerSummary = ledger ? applyLedger(rows, language, ledger, findings) : null;
    const csv = packCsv(rows);
    const md = reviewDocument(language, rows, data, ledgerSummary);
    packs.push({
      language, rows, needs: rows.filter((row) => row.needs_translation === 'yes').length,
      csvBytes: Buffer.byteLength(csv), mdBytes: Buffer.byteLength(md), csv, md,
      ledgerSummary, findings,
    });
  }
  return { outDir, languages, ledgerDir, data, scan, scanStats, packs };
}

export function writePacks(built) {
  mkdirSync(built.outDir, { recursive: true });
  const written = [];
  for (const pack of built.packs) {
    const target = outputPaths(built.outDir, pack.language);
    writeFileSync(target.md, pack.md);
    writeFileSync(target.csv, pack.csv);
    if (!existsSync(target.template)) writeFileSync(target.template, decisionTemplate(pack.language));
    written.push(target.md, target.csv, target.template);
  }
  const censusText = censusMarkdown(built.data, built.packs, built.scanStats);
  writeFileSync(path.join(built.outDir, 'CENSUS.md'), censusText);
  writeFileSync(path.join(built.outDir, 'census.json'), `${JSON.stringify({
    format: PACK_FORMAT,
    counts: built.data.counts,
    catalogues: built.data.catalogues.map((entry) => ({ namespace: entry.namespace, file: entry.file, keys: entry.keys.length })),
    bundle: { digest: built.data.digest, guideStrings: built.data.counts.guideStrings, nouns: built.data.counts.nouns },
    frozenSource: {
      guides: built.data.counts.frozenGuides, sections: built.data.counts.frozenGuideSections,
      nouns: built.data.counts.frozenNounEntries, corrections: built.data.source.corrections,
    },
    pendingRecord: { rendered: built.data.pendingRows.length, removed: built.data.record.pending.flatMap((entry) => entry.removed).length },
    keyLocations: built.scanStats,
    packs: built.packs.map((pack) => ({ language: pack.language, rows: pack.rows.length, needsDecision: pack.needs, csvBytes: pack.csvBytes, mdBytes: pack.mdBytes })),
    findings: built.data.findings,
  }, null, 2)}\n`);
  writeFileSync(path.join(built.outDir, 'README.md'), readme(built.data, built.packs, built.outDir));
  const findingsText = built.data.findings.length
    ? `${built.data.findings.map((finding) => `- \`${finding.code}\` — ${finding.detail}`).join('\n')}\n`
    : 'No cross-source disagreement was found: the catalogues agree with each other, the bundle agrees with the frozen German source, the pending record agrees with both, and the instruction digests verify.\n';
  writeFileSync(path.join(built.outDir, 'FINDINGS.md'), `# Findings — where two sources disagree\n\n${findingsText}`);
  return written;
}

/* ------------------------------------------------------------------ cli */

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--out') options.out = argv[++index];
    else if (token === '--ledger-dir') options.ledgerDir = argv[++index];
    else if (token === '--languages') options.languages = String(argv[++index]).split(',').map((value) => value.trim()).filter(Boolean);
    else if (token === '--census-only') options.censusOnly = true;
    else if (token === '--help' || token === '-h') options.help = true;
    else throw new Error(`unknown argument ${token}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('usage: node tools/build-review-pack.mjs [--out <dir>] [--ledger-dir <dir>] [--languages de,uk,ar,tr] [--census-only]');
    return;
  }
  const built = await build(options);
  const { data } = built;
  console.log('CENSUS, per source of truth (read from the source, not from a list)');
  console.log(`  interface catalogues         ${data.counts.catalogueKeys} keys across ${data.catalogues.length} catalogues × ${LOCALES.length} locales`);
  for (const catalogue of data.catalogues) console.log(`      ${catalogue.namespace.padEnd(9)} ${String(catalogue.keys.length).padStart(4)}  ${catalogue.file}`);
  console.log(`  instructions catalogue       ${data.counts.instructions} ids × (1 original + ${LOCALES.length - 1} translations)  public/assets/i18n/instructions.js`);
  console.log(`  fallback maps                ${data.counts.fallbacks} maps × ${LOCALES.length} locales  (core.js, instructions.js)`);
  console.log(`  <noscript> blocks            ${data.counts.noscriptStrings} string × ${LOCALES.length} locales in ${NOSCRIPT_FILES.length} shells`);
  console.log(`  library guides (bundle)      ${data.counts.guideStrings} paths × ${TRANSLATION_LOCALES.length} locales  content/library-translations/hatoove-library-translations-uk-ar-tr.json`);
  console.log(`  library nouns (bundle)       ${data.counts.nouns} entries × (2 English + ${TRANSLATION_LOCALES.length} × 3 fields)`);
  console.log(`  guide paths owing a translation  ${data.pendingRows.length} rendered (the README pending record), ${data.record.pending.flatMap((entry) => entry.removed).length} removed from the source by 0043`);
  console.log(`  frozen German source         ${data.counts.frozenGuides} guides, ${data.counts.frozenGuideSections} sections, ${data.counts.frozenNounEntries} nouns; corrections: ${data.source.corrections.length ? data.source.corrections.join('; ') : 'none'}`);
  console.log(`  importer binding             ${data.counts.boundGuideStrings} guide strings + ${data.counts.boundNounRows} noun rows bound with 0 problems`);
  console.log(`  cross-source findings        ${data.findings.length}`);
  console.log(`  interface key locations      ${built.scanStats.exactlyBound} bound exactly, ${built.scanStats.onlyMentioned} mentioned without a binding, ${built.scanStats.unlocated} mentioned nowhere (candidate dead copy)`);
  if (built.scanStats.unlocated) console.log(`      e.g. ${built.scanStats.unlocatedSample.slice(0, 8).join(', ')}`);
  for (const finding of data.findings) console.log(`      ${finding.code}: ${finding.detail}`);
  if (options.censusOnly) return;
  const written = writePacks(built);
  console.log('');
  console.log(`WROTE ${built.outDir}`);
  for (const pack of built.packs) {
    console.log(`  ${pack.language}: ${pack.rows.length} rows (${pack.needs} owing a decision), csv ${pack.csvBytes} B, md ${pack.mdBytes} B${pack.ledgerSummary ? `, ledger applied: ${JSON.stringify(pack.ledgerSummary)}` : ''}`);
  }
  console.log(`  plus CENSUS.md, census.json, FINDINGS.md, README.md`);
  for (const file of written) console.log(`  ${path.relative(built.outDir, file)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`build-review-pack: ${error.message}`); process.exit(1); });
}
