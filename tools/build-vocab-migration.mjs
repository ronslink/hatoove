#!/usr/bin/env node
/**
 * LIBRARY-SEED-01 (vocab) — generate the vocabulary migration from the authored source.
 *
 * ## Why this is a generator, for the same reason `build-objective-migration.mjs` is one
 *
 * `data/vocab.json` holds 300 entries. Typing them into SQL by hand is how a seed drifts from the
 * source it claims to be. This reads the source and emits the migration, so the SQL is a
 * REPRODUCIBLE ARTIFACT of the authored content.
 *
 * ## What is different from the objective corpus, and why this is not a copy of that tool
 *
 * The objective corpus needed a SPLIT, because `answer`/`why` sat inline with the learner-facing
 * text. A lexicon has no answers and needs no split — so this file has no secret-side table, and
 * inventing one would be ceremony. What it does need instead is a **STABLE IDENTIFIER**: nothing
 * references a vocabulary entry yet, but exercises and adaptive selection will, and an id derived from
 * a row's POSITION breaks the moment the source is reordered. The id is therefore derived from the
 * German headword, with a numbered suffix only on a genuine collision.
 *
 * ## Provenance is ONE row, not 300
 *
 * The objective seed wrote a `content_version` row per set because each set is a separately reviewable
 * task. This is ONE authored document, so it gets ONE provenance row: 300 rows claiming the same
 * source would be 300 copies of one fact. `rights_status` is `unknown`, truthfully — the audit found
 * the `data/*.json` files carry no rights record at all, which is D1 and still open.
 *
 * Usage: node tools/build-vocab-migration.mjs [--check]
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'data', 'vocab.json');
const TARGET = path.join(ROOT, 'server', 'migrations', '0011-vocab-catalogue.sql');
const EXAM_ID = 'telc-deutsch-b1';
const CONTENT_VERSION_ID = `${EXAM_ID}.vocab@v1`;

const sqlText = (value) => (value === null || value === undefined ? 'NULL' : `'${String(value).replace(/'/g, "''")}'`);

/** A stable, readable key from the German headword: `der Verwandte` -> `der-verwandte`. */
function slug(term) {
  return String(term)
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const raw = readFileSync(SOURCE);
const source = JSON.parse(raw.toString('utf8'));
const sourceDigest = createHash('sha256').update(raw).digest('hex');

const seen = new Map();
const rows = [];
for (const [index, word] of source.words.entries()) {
  const base = `${EXAM_ID}.vocab.${slug(word.de)}`;
  // Deterministic collision handling: a duplicate headword gets -2, -3 ... in source order, so the
  // same source always produces the same ids and a genuine duplicate is visible rather than silent.
  const n = (seen.get(base) || 0) + 1;
  seen.set(base, n);
  const entryId = n === 1 ? base : `${base}-${n}`;
  rows.push(`    (${[
    sqlText(entryId), sqlText(EXAM_ID), String(index),
    sqlText(word.de), sqlText(word.en), sqlText(word.pos ?? null), sqlText(word.plural ?? null),
    sqlText(word.example ?? null), sqlText(word.exampleEn ?? null), sqlText(CONTENT_VERSION_ID),
  ].join(', ')})`);
}

const duplicates = [...seen.entries()].filter(([, n]) => n > 1);

const sql = `
    -- LIBRARY-SEED-01 — the B1 core vocabulary, GENERATED from data/vocab.json.
    --
    -- DO NOT EDIT BY HAND. Run \`node tools/build-vocab-migration.mjs\`; \`--check\` fails if this file
    -- and the source disagree.
    --
    -- Source: data/vocab.json (sha256 ${sourceDigest})
    -- ${source.words.length} entries. ONE provenance row for the whole document, not one per word.
    --
    -- THERE IS NO ANSWER-SIDE TABLE, and that is deliberate rather than an omission: unlike the
    -- objective corpus, a lexicon holds no answers to leak. A learner-facing dictionary is the whole
    -- content.
    --
    -- The identifier is derived from the GERMAN HEADWORD, not from the row's position, so reordering
    -- the source does not silently repoint every entry at a different word.

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".vocab_entry (
      entry_id           text PRIMARY KEY,
      exam_id            text NOT NULL,
      ordinal            integer NOT NULL,
      de                 text NOT NULL,
      en                 text NOT NULL,
      pos                text,
      plural             text,
      example            text,
      example_en         text,
      content_version_id text NOT NULL REFERENCES "__SCHEMA__".content_version(content_version_id),
      created_at         timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (exam_id) REFERENCES "__SCHEMA__".exam_package(exam_id)
    );

    -- The learner searches by German headword and filters by part of speech; both are indexed.
    CREATE INDEX IF NOT EXISTS vocab_entry_exam_idx ON "__SCHEMA__".vocab_entry (exam_id, ordinal);
    CREATE INDEX IF NOT EXISTS vocab_entry_pos_idx  ON "__SCHEMA__".vocab_entry (exam_id, pos);

    INSERT INTO "__SCHEMA__".content_version
      (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
    VALUES
    (${sqlText(CONTENT_VERSION_ID)}, 'lexicon', 'vocab', 'data/vocab.json', 'unreviewed', 'unknown', ${sqlText(sourceDigest)}, ${sqlText(EXAM_ID)})
    ON CONFLICT (content_version_id) DO NOTHING;

    INSERT INTO "__SCHEMA__".vocab_entry
      (entry_id, exam_id, ordinal, de, en, pos, plural, example, example_en, content_version_id)
    VALUES
${rows.join(',\n')}
    ON CONFLICT (entry_id) DO NOTHING;

    REVOKE ALL ON "__SCHEMA__".vocab_entry FROM PUBLIC;
    GRANT SELECT ON "__SCHEMA__".vocab_entry TO __LEARNER__, __WORKER__;
`;

if (process.argv.includes('--check')) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  if (current !== sql) {
    console.error('library-seed: FAILED the generated migration differs from data/vocab.json');
    console.error('  run: node tools/build-vocab-migration.mjs');
    process.exit(1);
  }
  console.log(`library-seed: OK the migration matches data/vocab.json (${rows.length} entries)`);
  process.exit(0);
}

writeFileSync(TARGET, sql);
console.log(`library-seed: wrote ${path.relative(ROOT, TARGET)}`);
console.log(`  entries          : ${rows.length}`);
console.log(`  duplicate headwords renamed deterministically: ${duplicates.length}`);
if (duplicates.length) console.log(`    ${duplicates.map(([id, n]) => `${id} x${n}`).join(', ')}`);
console.log(`  provenance rows  : 1 (${CONTENT_VERSION_ID})`);
console.log(`  source sha256    : ${sourceDigest}`);
