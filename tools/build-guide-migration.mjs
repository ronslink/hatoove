#!/usr/bin/env node
/**
 * LIBRARY-SEED-03 (reference guides) — generate the guide-library migration.
 *
 * ## The shape problem, and why this is not another lexicon table
 *
 * Five authored documents: `grammar-guide` (14 topics, each with rule/pattern/table/traps),
 * `core-grammar` and `core-phrases` (tiers of items), `gender-rules` (six gender rules, FORTY
 * exceptions, fourteen double-gender nouns and a watch-out list) and `cases-guide` (eight declension
 * tables with headers and rows, plus triggers and examples).
 *
 * They share no columns beyond a title. Shredding them into relational columns would destroy the
 * authored structure — the same mistake as flattening the objective families into one multiple-choice
 * row. But dumping each file into a single `payload` column would make a guide unlistable and
 * unsearchable without sending 64 KB to the browser to find out what is inside it.
 *
 * So: **two tables and a `kind` discriminator.**
 *   guide          the document envelope: title, intro, the watch-out list, provenance
 *   guide_section  one row per section, with `kind`, a title, a summary and the authored payload
 *
 * The payload is the authored structure VERBATIM, per section. `kind` is what lets six genuinely
 * different section types live in one table without a column per type.
 *
 * ## No secret side
 *
 * A reference guide holds no answers. The `why` and `note` fields are pedagogy meant to be read, which
 * is the opposite of the objective corpus where `why` had to be withheld until after marking.
 *
 * Usage: node tools/build-guide-migration.mjs [--check]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitMigration, makeIdFactory, sha256, sqlText } from './lib/library-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'server', 'migrations', '0013-guide-library.sql');
const EXAM_ID = 'telc-deutsch-b1';

/**
 * One entry per authored document. `sections` maps the document's own structure onto the uniform
 * section shape, keeping every field that is not lifted into a column inside `payload`.
 */
const GUIDES = [
  {
    file: 'grammar-guide.json',
    id: 'grammar-guide',
    family: 'grammar',
    title: 'Grammatik',
    sections: (j) => j.topics.map((t) => ({
      kind: 'topic', id: t.id, title: t.title, titleEn: t.titleEn, summary: t.why, summaryEn: t.whyEn,
      payload: { rule: t.rule, ruleEn: t.ruleEn, pattern: t.pattern, patternEn: t.patternEn, examples: t.examples, table: t.table, traps: t.traps, trapsEn: t.trapsEn },
    })),
  },
  {
    file: 'core-grammar.json',
    id: 'core-grammar',
    family: 'core-grammar',
    title: 'Kerngrammatik',
    sections: (j) => j.tiers.map((t) => ({
      kind: 'tier', id: t.id, title: t.title, summary: t.why, payload: { items: t.items },
    })),
  },
  {
    file: 'core-phrases.json',
    id: 'core-phrases',
    family: 'core-phrases',
    title: 'Redemittel',
    sections: (j) => j.tiers.map((t) => ({
      kind: 'tier', id: t.id, title: t.title, summary: t.why, payload: { items: t.items },
    })),
  },
  {
    file: 'gender-rules.json',
    id: 'gender-rules',
    family: 'gender',
    title: 'Genus: Regeln',
    // Three different section types in one document, which is exactly why `kind` exists.
    sections: (j) => [
      ...j.rules.map((r, i) => ({
        kind: 'gender_rule', id: `rule-${i + 1}-${r.gender}`, title: r.title, titleEn: r.titleEn,
        summary: r.note, summaryEn: r.noteEn,
        payload: { gender: r.gender, kind: r.kind, items: r.items, examples: r.examples },
      })),
      ...j.exceptions.map((e) => ({
        kind: 'exception', id: `exception-${e.de}`, title: e.de, summary: e.why, summaryEn: e.whyEn,
        payload: { en: e.en, plural: e.plural, looks: e.looks },
      })),
      ...j.doubleGender.map((d) => ({
        kind: 'double_gender', id: `double-${d.de}`, title: d.de, summary: d.why, summaryEn: d.whyEn,
        payload: { en: d.en, other: d.other, otherEn: d.otherEn },
      })),
    ],
  },
  {
    file: 'cases-guide.json',
    id: 'cases-guide',
    family: 'cases',
    title: 'Fälle und Artikel',
    sections: (j) => [
      ...j.tables.map((t) => ({
        kind: 'table', id: t.id, title: t.title, titleEn: t.titleEn, summary: t.why, summaryEn: t.whyEn,
        payload: { headers: t.headers, headersEn: t.headersEn, rows: t.rows, note: t.note, noteEn: t.noteEn },
      })),
      ...j.triggers.map((t, i) => ({
        kind: 'trigger', id: `trigger-${i + 1}-${t.case}`, title: t.kind, titleEn: t.kindEn,
        summary: t.example, summaryEn: t.en,
        payload: { case: t.case, items: t.items },
      })),
      ...j.examples.map((e, i) => ({
        kind: 'example', id: `example-${i + 1}`, title: e.de, summary: e.note,
        payload: { en: e.en },
      })),
    ],
  },
];

const guideRows = [];
const sectionRows = [];
const provenanceRows = [];
const summary = [];

for (const guide of GUIDES) {
  const raw = readFileSync(path.join(ROOT, 'data', guide.file));
  const json = JSON.parse(raw.toString('utf8'));
  const digest = sha256(raw);
  const contentVersionId = `${EXAM_ID}.${guide.id}@v1`;
  const sections = guide.sections(json);
  const ids = makeIdFactory(`${EXAM_ID}.${guide.id}`);

  // EVERY output value goes through sqlText, including the constants. Writing a bare JS string
  // ('guide', 'unreviewed') into this array emits it WITHOUT SQL quotes, and PostgreSQL rejects the
  // insert with `column "guide" does not exist` -- which is how this was caught. The vocab and noun
  // generators write their constants inside the SQL template, where they are already literals; this
  // one builds rows in JavaScript, so the same constant needs the same treatment as a value.
  provenanceRows.push(`    (${[
    sqlText(contentVersionId), sqlText('guide'), sqlText(guide.family), sqlText(`data/${guide.file}`),
    sqlText('unreviewed'), sqlText('unknown'), sqlText(digest), sqlText(EXAM_ID),
  ].join(', ')})`);

  guideRows.push(`    (${[
    sqlText(guide.id), sqlText(EXAM_ID), sqlText(guide.family), sqlText(guide.title),
    sqlText(json.intro ?? null), sqlText(json.introEn ?? null),
    sqlText(JSON.stringify(json.watchOut ?? [])), sqlText(JSON.stringify(json.watchOutEn ?? [])),
    String(sections.length), sqlText(contentVersionId),
  ].join(', ')})`);

  sections.forEach((section, index) => {
    sectionRows.push(`    (${[
      sqlText(guide.id), sqlText(ids.idFor(section.id ?? section.title ?? String(index))), String(index),
      sqlText(section.kind), sqlText(section.title ?? null), sqlText(section.titleEn ?? null),
      sqlText(section.summary ?? null), sqlText(section.summaryEn ?? null),
      `${sqlText(JSON.stringify(section.payload ?? {}))}::jsonb`,
    ].join(', ')})`);
  });

  const kinds = [...new Set(sections.map((s) => s.kind))].sort();
  summary.push(`${guide.id.padEnd(14)} ${String(sections.length).padStart(3)} sections  kinds: ${kinds.join(', ')}`);
}

const sql = `
    -- LIBRARY-SEED-03 — the five authored reference guides, GENERATED from data/*.json.
    --
    -- DO NOT EDIT BY HAND. Run \`node tools/build-guide-migration.mjs\`; \`--check\` fails on divergence.
    --
    -- Sources: grammar-guide.json, core-grammar.json, core-phrases.json, gender-rules.json,
    --          cases-guide.json
    --
    -- TWO TABLES AND A KIND DISCRIMINATOR. The five documents share no columns beyond a title, and
    -- shredding them into relational columns would destroy the authored structure -- the same mistake
    -- as flattening the objective families into one multiple-choice row. Dumping each file into one
    -- payload column would be the opposite failure: a guide could not be listed or searched without
    -- sending 64 KB to the browser to find out what is inside it.
    --
    --   guide          the document envelope: title, intro, watch-out list, provenance
    --   guide_section  one row per section: kind, title, summary, and the authored payload VERBATIM
    --
    -- \`kind\` is what lets six genuinely different section types live in one table without a column
    -- per type: topic, tier, gender_rule, exception, double_gender, table, trigger, example.
    --
    -- NO SECRET SIDE. A reference guide holds no answers; its \`why\` and \`note\` fields are pedagogy
    -- meant to be read, which is the opposite of the objective corpus where \`why\` had to be withheld
    -- until after marking.

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".guide (
      guide_id           text PRIMARY KEY,
      exam_id            text NOT NULL,
      family             text NOT NULL,
      title              text NOT NULL,
      intro              text,
      intro_en           text,
      watch_out          jsonb NOT NULL DEFAULT '[]'::jsonb,
      watch_out_en       jsonb NOT NULL DEFAULT '[]'::jsonb,
      section_count      integer NOT NULL,
      content_version_id text NOT NULL REFERENCES "__SCHEMA__".content_version(content_version_id),
      created_at         timestamptz NOT NULL DEFAULT now(),
      FOREIGN KEY (exam_id) REFERENCES "__SCHEMA__".exam_package(exam_id)
    );

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".guide_section (
      guide_id  text NOT NULL REFERENCES "__SCHEMA__".guide(guide_id),
      section_id text NOT NULL,
      ordinal   integer NOT NULL,
      kind      text NOT NULL,
      title     text,
      title_en  text,
      summary   text,
      summary_en text,
      payload   jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (guide_id, section_id)
    );

    CREATE INDEX IF NOT EXISTS guide_section_kind_idx ON "__SCHEMA__".guide_section (guide_id, kind, ordinal);

    INSERT INTO "__SCHEMA__".content_version
      (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
    VALUES
${provenanceRows.join(',\n')}
    ON CONFLICT (content_version_id) DO NOTHING;

    INSERT INTO "__SCHEMA__".guide
      (guide_id, exam_id, family, title, intro, intro_en, watch_out, watch_out_en, section_count, content_version_id)
    VALUES
${guideRows.join(',\n')}
    ON CONFLICT (guide_id) DO NOTHING;

    INSERT INTO "__SCHEMA__".guide_section
      (guide_id, section_id, ordinal, kind, title, title_en, summary, summary_en, payload)
    VALUES
${sectionRows.join(',\n')}
    ON CONFLICT (guide_id, section_id) DO NOTHING;

    REVOKE ALL ON "__SCHEMA__".guide, "__SCHEMA__".guide_section FROM PUBLIC;
    GRANT SELECT ON "__SCHEMA__".guide, "__SCHEMA__".guide_section TO __LEARNER__, __WORKER__;
`;

emitMigration({
  root: ROOT,
  target: TARGET,
  sql,
  summary: [
    ...summary,
    `guides           : ${guideRows.length}`,
    `sections total   : ${sectionRows.length}`,
    `provenance rows  : ${provenanceRows.length}`,
  ],
});
