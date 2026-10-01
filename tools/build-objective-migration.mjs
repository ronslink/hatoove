#!/usr/bin/env node
/**
 * OBJECTIVE-SEED-01 — generate the objective-corpus migration FROM the authored source.
 *
 * ## Why this is a generator and not a hand-written migration
 *
 * The corpus is 24 authored sets holding 180 answers. Typing that into SQL by hand is how a seed
 * drifts from the source it claims to be, and the drift is invisible until a learner is marked
 * against the wrong key. This reads `data/seed.json` and emits the migration, so the SQL is a
 * REPRODUCIBLE ARTIFACT of the authored content rather than a second copy of it. Re-running with the
 * same source produces the same file; the digest of each set is recorded so a divergence is visible.
 *
 * ## The two things this tool exists to prevent
 *
 * 1. **SERVING THE ANSWERS.** In the authored source `answer`, `why` and `grammar` sit INLINE in the
 *    same arrays as the learner-facing text. Seeding those arrays as-is would ship every key to the
 *    browser in the task payload. So each set is SPLIT here: the learner gets a payload with the
 *    answers removed, and the answers land in `objective_key`, a table the learner role is not
 *    granted. The isolation is enforced by the DATABASE, not by remembering to strip a field in a
 *    route.
 *
 * 2. **CALLING A LISTENING TASK A LISTENING TASK WHEN IT IS A TRANSCRIPT.** The HV families carry
 *    `script`, the transcript of audio that does not exist yet. Serving the script would turn a
 *    Hören task into a Lesen task wearing a Hören label. The transcript goes to the key side, and the
 *    set is marked `media_required` so the serving policy can withhold it until audio exists.
 *
 * ## The families are NOT one shape, and the payload says so
 *
 * LV1 matches texts to headlines; LV3 matches situations to ads; SB1/SB2 are gap-fills (SB2 from a
 * bank); HV are true/false items. Forcing these into one synthetic multiple-choice row would destroy
 * the authored task. The payload is therefore the authored structure, per family, verbatim.
 *
 * Usage: node tools/build-objective-migration.mjs [--check]
 *   --check  fail if the committed migration differs from what the source would generate
 */

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = path.join(ROOT, 'data', 'seed.json');
const TARGET = path.join(ROOT, 'server', 'migrations', '0010-objective-catalogue.sql');
const EXAM_ID = 'telc-deutsch-b1';

/** Fields that are ANSWERS or ANSWER-ADJACENT, and must never reach a learner before marking. */
const SECRET_FIELDS = new Set(['answer', 'why', 'grammar']);
/** Fields that are the transcript of audio, not learner-facing text. */
const TRANSCRIPT_FIELDS = new Set(['script']);
/** Listening families: their content is meant to be HEARD, and no audio exists yet. */
const MEDIA_FAMILIES = new Set(['HV1', 'HV2', 'HV3']);
/** The three sections of the written exam these sets belong to. */
const SECTION_OF = (family) => family.replace(/[0-9]+$/, '');
const PART_OF = (family) => Number((family.match(/([0-9]+)$/) || [])[1] || 0);

const sqlText = (value) => `'${String(value).replace(/'/g, "''")}'`;
const sqlJson = (value) => `${sqlText(JSON.stringify(value))}::jsonb`;

/**
 * Split one authored set into the learner-facing payload and the secret key side.
 * Answers are collected by item id so the key is addressable per item (`texts[0].answer` -> `1`).
 */
function splitSet(family, set) {
  const payload = {};
  const answers = {};
  const explanations = {};
  const transcripts = [];

  for (const [field, value] of Object.entries(set)) {
    if (TRANSCRIPT_FIELDS.has(field)) { transcripts.push(value); continue; }
    /*
     * SET-LEVEL secrets matter too. Stripping `answer`/`why` only from the entries inside arrays left
     * LV1's top-level `why` — the explanation for the whole matching task — sitting in the learner
     * payload. A split that trusts a field to be nested is not a split.
     */
    if (SECRET_FIELDS.has(field)) { explanations[`_set_${field}`] = value; continue; }
    if (!Array.isArray(value)) { payload[field] = value; continue; }
    payload[field] = value.map((entry) => {
      if (entry === null || typeof entry !== 'object') return entry;
      const kept = {};
      for (const [key, inner] of Object.entries(entry)) {
        if (SECRET_FIELDS.has(key)) continue;
        kept[key] = inner;
      }
      const id = String(entry.id ?? entry.n ?? '');
      if (entry.answer !== undefined) answers[id] = entry.answer;
      if (entry.why !== undefined) explanations[id] = entry.why;
      return kept;
    });
  }
  return { payload, answers, explanations, transcript: transcripts.join('\n\n') || null };
}

const source = JSON.parse(readFileSync(SOURCE, 'utf8'));
const sourceDigest = createHash('sha256').update(readFileSync(SOURCE)).digest('hex');

const contentRows = [];
const setRows = [];
const keyRows = [];

for (const family of Object.keys(source).sort()) {
  for (const [index, set] of source[family].entries()) {
    const setId = `${EXAM_ID}.${family.toLowerCase()}.${String(index + 1).padStart(2, '0')}`;
    const version = 'v1';
    const contentVersionId = `${setId}@${version}`;
    const { payload, answers, explanations, transcript } = splitSet(family, set);
    const setDigest = createHash('sha256').update(JSON.stringify(set)).digest('hex');
    // The number of SCORED items, which is exactly the number of answers extracted — not the number
    // of array entries in the payload. Counting entries inflated this to 291 across the corpus by
    // including headlines, ads and bank words, none of which is an item anybody answers.
    void payload;
    const itemCount = Object.keys(answers).length;
    const mediaRequired = MEDIA_FAMILIES.has(family);

    contentRows.push(`    (${sqlText(contentVersionId)}, 'task', ${sqlText(SECTION_OF(family).toLowerCase())}, ${sqlText(`data/seed.json#${family}[${index}]`)}, 'unreviewed', 'unknown', ${sqlText(setDigest)}, ${sqlText(EXAM_ID)})`);
    setRows.push(`    (${[
      sqlText(setId), sqlText(version), sqlText(EXAM_ID), sqlText(family),
      sqlText(SECTION_OF(family)), String(PART_OF(family)),
      sqlText(set.title || `${family} ${index + 1}`),
      sqlJson(payload), String(itemCount), mediaRequired ? 'true' : 'false',
      sqlText(contentVersionId),
    ].join(', ')})`);
    keyRows.push(`    (${[
      sqlText(setId), sqlText(version), sqlJson(answers), sqlJson(explanations),
      transcript === null ? 'NULL' : sqlText(transcript),
    ].join(', ')})`);
  }
}

const sql = `
    -- OBJECTIVE-SEED-01 — the authored objective corpus, GENERATED from data/seed.json.
    --
    -- DO NOT EDIT THIS FILE BY HAND. Run \`node tools/build-objective-migration.mjs\` after changing
    -- data/seed.json. \`--check\` fails if this file and the source disagree, so the two cannot drift
    -- quietly.
    --
    -- Source: data/seed.json (sha256 ${sourceDigest})
    --
    -- TWO TABLES, AND THE SEPARATION IS THE POINT:
    --   objective_set.payload  what the learner may see
    --   objective_key          answers, explanations and transcripts, granted to the WORKER ONLY
    -- The answers sit inline in the authored source, so a seed that copied the source wholesale would
    -- ship every key in the task payload. The split is enforced by a GRANT, not by a route
    -- remembering to delete a field.
    --
    -- HV SETS ARE MARKED media_required. Their \`script\` is the transcript of audio that does not
    -- exist yet; serving it would make a Hören task a Lesen task with a Hören label.

    CREATE TABLE IF NOT EXISTS "__SCHEMA__".objective_set (
      set_id             text NOT NULL,
      version            text NOT NULL,
      exam_id            text NOT NULL,
      family             text NOT NULL,
      section            text NOT NULL,
      part               integer NOT NULL,
      title              text NOT NULL,
      payload            jsonb NOT NULL,
      item_count         integer NOT NULL,
      media_required     boolean NOT NULL DEFAULT false,
      content_version_id text NOT NULL REFERENCES "__SCHEMA__".content_version(content_version_id),
      created_at         timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (set_id, version),
      FOREIGN KEY (exam_id) REFERENCES "__SCHEMA__".exam_package(exam_id)
    );

    -- The key side. Granted to the worker and to NOBODY else: the learner role cannot read it even if
    -- a route is written carelessly, because PostgreSQL refuses the read.
    CREATE TABLE IF NOT EXISTS "__SCHEMA__".objective_key (
      set_id       text NOT NULL,
      version      text NOT NULL,
      answers      jsonb NOT NULL,
      explanations jsonb NOT NULL,
      transcript   text,
      created_at   timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (set_id, version),
      FOREIGN KEY (set_id, version) REFERENCES "__SCHEMA__".objective_set(set_id, version)
    );

    CREATE INDEX IF NOT EXISTS objective_set_family_idx ON "__SCHEMA__".objective_set (exam_id, family);

    -- The catalogue rows the review/rights machinery already understands, one per set.
    --
    -- \`exam_id\` IS NAMED EXPLICITLY, and that is not decoration: migration 0009 added the column
    -- NOT NULL with a DEFAULT and then DROPPED the default, so that a future insert must say which
    -- exam it belongs to rather than inheriting one by accident. An insert that omits it fails with a
    -- not-null violation -- which is how this file was corrected, by applying it rather than reading it.
    INSERT INTO "__SCHEMA__".content_version
      (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
    VALUES
${contentRows.join(',\n')}
    ON CONFLICT (content_version_id) DO NOTHING;

    INSERT INTO "__SCHEMA__".objective_set
      (set_id, version, exam_id, family, section, part, title, payload, item_count, media_required, content_version_id)
    VALUES
${setRows.join(',\n')}
    ON CONFLICT (set_id, version) DO NOTHING;

    INSERT INTO "__SCHEMA__".objective_key
      (set_id, version, answers, explanations, transcript)
    VALUES
${keyRows.join(',\n')}
    ON CONFLICT (set_id, version) DO NOTHING;

    REVOKE ALL ON "__SCHEMA__".objective_key FROM PUBLIC;
    REVOKE ALL ON "__SCHEMA__".objective_key FROM __LEARNER__;
    GRANT SELECT ON "__SCHEMA__".objective_key TO __WORKER__;

    REVOKE ALL ON "__SCHEMA__".objective_set FROM PUBLIC;
    GRANT SELECT ON "__SCHEMA__".objective_set TO __LEARNER__, __WORKER__;
`;

if (process.argv.includes('--check')) {
  const current = existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : '';
  if (current !== sql) {
    console.error('objective-seed: FAILED the generated migration differs from data/seed.json');
    console.error('  run: node tools/build-objective-migration.mjs');
    process.exit(1);
  }
  console.log(`objective-seed: OK the migration matches data/seed.json (${setRows.length} sets, ${keyRows.length} keys)`);
  process.exit(0);
}

writeFileSync(TARGET, sql);
const totalAnswers = Object.values(source).reduce(
  (total, sets) => total + sets.reduce((n, set) => n + Object.values(set)
    .filter(Array.isArray)
    .reduce((m, arr) => m + arr.filter((e) => e && typeof e === 'object' && e.answer !== undefined).length, 0), 0), 0);
const totalTranscripts = Object.values(source).reduce(
  (total, sets) => total + sets.filter((s) => typeof s.script === 'string' && s.script.length).length, 0);
console.log(`objective-seed: wrote ${path.relative(ROOT, TARGET)}`);
console.log(`  sets             : ${setRows.length}`);
console.log(`  answers extracted: ${totalAnswers}`);
console.log(`  key rows         : ${keyRows.length}`);
console.log(`  media-gated      : ${totalTranscripts} set(s) carry a transcript, so HV is withheld until audio exists`);
console.log(`  source sha256    : ${sourceDigest}`);
