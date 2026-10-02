#!/usr/bin/env node
/**
 * LIBRARY-SEED-02 (nouns) — generate the noun-lexicon migration from the authored source.
 *
 * `data/noun-lexicon.json` holds 240 nouns. Unlike the vocabulary list these carry **gender**, the
 * **plural** form, the **rule** that decides the gender (in German and English) and a **theme**. That
 * is the content Ron named as "Nomen & Genus", and none of it was reachable: there was no route.
 *
 * A sibling table rather than a column on `vocab_entry`: these are the same KIND of thing (a lexicon
 * entry) but not the same SHAPE, and forcing 240 nouns into a table with five nullable columns they
 * alone use would make every future query about either corpus carry a condition about which one it is
 * looking at. Two shapes, two tables, one generator pattern.
 *
 * No secret side: a lexicon holds no answers. See `build-vocab-migration.mjs` for the same reasoning.
 *
 * Usage: node tools/build-noun-migration.mjs [--check]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitMigration, makeIdFactory, sha256, sqlText } from './lib/library-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'data', 'noun-lexicon.json');
const TARGET = path.join(ROOT, 'server', 'migrations', '0012-noun-lexicon-catalogue.sql');
const EXAM_ID = 'telc-deutsch-b1';
const CONTENT_VERSION_ID = `${EXAM_ID}.nouns@v1`;

const raw = readFileSync(SOURCE);
const source = JSON.parse(raw.toString('utf8'));
const sourceDigest = sha256(raw);

const ids = makeIdFactory(`${EXAM_ID}.noun`);
const rows = source.nouns.map((noun, index) => `    (${[
  sqlText(ids.idFor(noun.de)), sqlText(EXAM_ID), String(index),
  sqlText(noun.de), sqlText(noun.en), sqlText(noun.gender ?? null), sqlText(noun.plural ?? null),
  sqlText(noun.rule ?? null), sqlText(noun.ruleEn ?? null), sqlText(noun.theme ?? null),
  sqlText(noun.example ?? null), sqlText(noun.exampleEn ?? null), sqlText(CONTENT_VERSION_ID),
].join(', ')})`);

const genders = [...new Set(source.nouns.map((n) => n.gender).filter(Boolean))].sort();
const themes = [...new Set(source.nouns.map((n) => n.theme).filter(Boolean))].sort();

const sql = `
    -- LIBRARY-SEED-02 — the B1 noun lexicon with gender, plural, rule and theme, GENERATED from
    -- data/noun-lexicon.json.
    --
    -- DO NOT EDIT BY HAND. Run \`node tools/build-noun-migration.mjs\`; \`--check\` fails on divergence.
    --
    -- Source: data/noun-lexicon.json (sha256 ${sourceDigest})
    -- ${source.nouns.length} nouns. ONE provenance row for the whole document, as for the vocabulary.
    --
    -- A SIBLING TABLE, not a column on \`vocab_entry\`: same kind of thing, different shape. Putting
    -- 240 nouns into a table with five columns only they use would make every query about either
    -- corpus carry a condition about which one it is reading.
    --
    -- NO SECRET SIDE. A lexicon holds no answers, so there is no key table and no split.

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".noun_entry (
      entry_id           text PRIMARY KEY,
      exam_id            text NOT NULL,
      ordinal            integer NOT NULL,
      de                 text NOT NULL,
      en                 text NOT NULL,
      gender             text,
      plural             text,
      rule               text,
      rule_en            text,
      theme              text,
      example            text,
      example_en         text,
      content_version_id text NOT NULL REFERENCES "__SCHEMA__".content_version(content_version_id),
      created_at         timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (exam_id) REFERENCES "__SCHEMA__".exam_package(exam_id)
    );

    -- A learner browses by THEME ("Personen") or drills by GENDER, so both are indexed.
    CREATE INDEX IF NOT EXISTS noun_entry_theme_idx  ON "__SCHEMA__".noun_entry (exam_id, theme);
    CREATE INDEX IF NOT EXISTS noun_entry_gender_idx ON "__SCHEMA__".noun_entry (exam_id, gender);

    INSERT INTO "__SCHEMA__".content_version
      (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
    VALUES
    (${sqlText(CONTENT_VERSION_ID)}, 'lexicon', 'nouns', 'data/noun-lexicon.json', 'unreviewed', 'unknown', ${sqlText(sourceDigest)}, ${sqlText(EXAM_ID)})
    ON CONFLICT (content_version_id) DO NOTHING;

    INSERT INTO "__SCHEMA__".noun_entry
      (entry_id, exam_id, ordinal, de, en, gender, plural, rule, rule_en, theme, example, example_en, content_version_id)
    VALUES
${rows.join(',\n')}
    ON CONFLICT (entry_id) DO NOTHING;

    REVOKE ALL ON "__SCHEMA__".noun_entry FROM PUBLIC;
    GRANT SELECT ON "__SCHEMA__".noun_entry TO __LEARNER__, __WORKER__;
`;

emitMigration({
  root: ROOT,
  target: TARGET,
  sql,
  summary: [
    `nouns            : ${rows.length}`,
    `genders          : ${genders.join(', ')}`,
    `themes           : ${themes.join(', ')}`,
    `id collisions    : ${ids.collisions.length}`,
    `provenance rows  : 1 (${CONTENT_VERSION_ID})`,
    `source sha256    : ${sourceDigest}`,
  ],
});
