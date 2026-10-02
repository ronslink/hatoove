#!/usr/bin/env node
/**
 * LIBRARY-SEED-04 (writing and speaking guides) — add two more documents to the guide library.
 *
 * ## Why this is a separate tool from `build-guide-migration.mjs`
 *
 * Not because the shapes differ — they do not. `writing-guide` and `speaking-guide` are the same
 * sectioned-document shape as the five in `0013`. It is separate because **0013 is already applied and
 * its bytes are recorded in the migration ledger**: regenerating it to add two documents would produce
 * a different file for an already-applied id, which `migrate` refuses as a checksum mismatch, and
 * which it SHOULD refuse. A migration that has run is history; new documents are a new migration.
 *
 * `0013` created the `guide` and `guide_section` tables. This one only inserts into them.
 *
 * ## A NOTE ON SPEAKING, recorded rather than assumed
 *
 * `AGENTS.md` puts speaking and STT OUTSIDE the pilot. `speaking-guide.json` is reference PROSE — a
 * description of what the oral exam asks for and how to approach it — and serving a reference document
 * is not the same as offering speaking practice. It is seeded as content, and **nothing here is
 * speaking practice**. Do not read the presence of this file as authority to build it.
 *
 * Usage: node tools/build-writing-speaking-migration.mjs [--check]
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitMigration, makeIdFactory, sha256, sqlText } from './lib/library-seed.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TARGET = path.join(ROOT, 'server', 'migrations', '0014-writing-speaking-guides.sql');
const EXAM_ID = 'telc-deutsch-b1';

const GUIDES = [
  {
    file: 'writing-guide.json',
    id: 'writing-guide',
    family: 'writing-guide',
    title: 'Briefe schreiben',
    sections: (j) => [
      ...j.sections.map((s, i) => ({
        kind: 'step', id: `step-${i + 1}`, title: s.title, titleEn: s.titleEn,
        summary: s.why, summaryEn: s.whyEn, payload: { points: s.points },
      })),
      ...j.phrases.map((p, i) => ({
        kind: 'phrase_group', id: `phrases-${i + 1}`, title: p.group, titleEn: p.groupEn,
        summary: p.hint, summaryEn: p.hintEn, payload: { items: p.items },
      })),
      ...j.examples.map((e, i) => ({
        kind: 'example_letter', id: `letter-${i + 1}`, title: e.type, titleEn: e.typeEn,
        summary: e.situation, summaryEn: e.situationEn,
        payload: { leitpunkte: e.leitpunkte, leitpunkteEn: e.leitpunkteEn, text: e.text },
      })),
      // The checklist is a SECTION rather than a new pair of columns on `guide`: it is listable
      // content a learner navigates to, and adding columns for one document's two arrays is how a
      // shared table accumulates a column per document.
      {
        kind: 'checklist', id: 'checklist', title: 'Checkliste', titleEn: 'Checklist',
        summary: 'Vor dem Abgeben durchgehen.', summaryEn: 'Work through this before submitting.',
        payload: { items: j.checklist, itemsEn: j.checklistEn },
      },
    ],
  },
  {
    file: 'speaking-guide.json',
    id: 'speaking-guide',
    family: 'speaking-guide',
    title: 'Mündliche Prüfung',
    sections: (j) => j.parts.map((p) => ({
      kind: 'part', id: p.id, title: p.title, titleEn: p.titleEn,
      summary: p.summary, summaryEn: p.summaryEn,
      payload: { minutes: p.minutes, approach: p.approach, phrases: p.phrases, examples: p.examples, watchOut: p.watchOut, watchOutEn: p.watchOutEn },
    })),
  },
];

const provenanceRows = [];
const guideRows = [];
const sectionRows = [];
const summary = [];

for (const guide of GUIDES) {
  const raw = readFileSync(path.join(ROOT, 'data', guide.file));
  const json = JSON.parse(raw.toString('utf8'));
  const digest = sha256(raw);
  const contentVersionId = `${EXAM_ID}.${guide.id}@v1`;
  const sections = guide.sections(json);
  const ids = makeIdFactory(`${EXAM_ID}.${guide.id}`);

  // Every value goes through sqlText, including constants -- see the note in `build-guide-migration`
  // about a migration that failed because a bare JS string lost its SQL quotes.
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
  summary.push(`${guide.id.padEnd(16)} ${String(sections.length).padStart(3)} sections  kinds: ${kinds.join(', ')}`);
}

const sql = `
    -- LIBRARY-SEED-04 — the writing and speaking reference guides, GENERATED from data/*.json.
    --
    -- DO NOT EDIT BY HAND. Run \`node tools/build-writing-speaking-migration.mjs\`; \`--check\` fails on
    -- divergence.
    --
    -- Sources: writing-guide.json, speaking-guide.json
    --
    -- THESE DOCUMENTS REUSE THE TABLES 0013 CREATED. They are the same sectioned-document shape as the
    -- five guides already in the library, so this migration only INSERTs.
    --
    -- WHY IT IS A SEPARATE MIGRATION rather than a regeneration of 0013: 0013 is APPLIED and its bytes
    -- are recorded in the ledger. Producing different bytes for an applied id is a checksum mismatch,
    -- and a migration that has run is history. New documents are a new migration.
    --
    -- SPEAKING IS REFERENCE PROSE, NOT PRACTICE. AGENTS.md puts speaking and STT outside the pilot.
    -- This seeds the GUIDE — a description of the oral exam and how to approach it — and nothing here
    -- offers speaking practice. The existence of the file is not authority to build it.

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
`;

emitMigration({
  root: ROOT,
  target: TARGET,
  sql,
  summary: [...summary, `guides added     : ${guideRows.length}`, `sections added   : ${sectionRows.length}`],
});
