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
import { validateMediaDescriptor } from '../server/media-contract.mjs';
import { packageHash } from '../server/package-contract.mjs';

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

/*
 * THE SOURCE RECORD IS PLATFORM-DEPENDENT, AND `--check` MUST NOT BE.
 *
 * A generated migration records `-- Source: <file> (sha256 <digest>)`, and the digest is taken over the
 * source bytes AS CHECKED OUT. Neither `data/seed.json` nor `content/pool-01/batch-1.json` carries an `eol`
 * attribute, so git checks them out CRLF on Windows (`core.autocrlf=true`) and LF everywhere else: the SAME
 * content has two legitimate digests, and a committed migration can only record the one its generating
 * platform produced. Measured on 5 October 2026 (POOL-01-CI-01):
 *
 *   data/seed.json                   CRLF 93,292 B -> ef26279d…   LF 91,372 B -> 40a0a066…
 *   content/pool-01/batch-1.json     CRLF 25,114 B -> 45e361a1…   LF 24,774 B -> f39498a1…
 *
 * `0010` records ef26279d… and `0047` records 45e361a1… — both the Windows forms. A literal compare
 * therefore made `--check` a Windows-only gate: on the ubuntu checkout the regenerated text carried the LF
 * digest, the comparison failed, and CI reported legs 4 and 5 red while the same tree was green on Windows.
 * The migration BYTES are not the problem: `0010` and `0047` hash identically in both checkouts and the
 * MANIFEST line matches `0047`'s bytes on both.
 *
 * So the comparison canonicalises that ONE recorded token — and only when the value it holds is the digest of
 * the source file in THIS checkout, in either byte form. A stale record, a hand-edited digest, or a source
 * that genuinely moved matches neither form and still fails; the accepted set is computed from the file on
 * disk at comparison time, never from a table of blessed values.
 *
 * EXPORTED so the check uses THIS rule rather than a second copy of it (N5): a generator and its checker
 * that each implement the rule can drift, and a drifted pair is how a gate stops meaning anything. The
 * root cause is still open and is a `.gitattributes` question, not a code one: neither JSON source carries
 * an `eol` attribute, so the digest a batch records depends on the platform that built it. Proposed, not
 * applied: `data/seed.json text eol=lf` and `content/pool-01/*.json text eol=lf`. That changes how those
 * files are CHECKED OUT (and therefore the digest this rule must accept), so the Lead decides it.
 */
export function legitimateSourceDigests(file) {
  const raw = readFileSync(file);
  const lf = Buffer.from(String(raw).replace(/\r\n/g, '\n'), 'utf8');
  const crlf = Buffer.from(String(lf).replace(/\n/g, '\r\n'), 'utf8');
  return new Set([raw, lf, crlf].map((buffer) => createHash('sha256').update(buffer).digest('hex')));
}
/*
 * The record line is INDENTED inside the generated SQL header (`    -- Source: … (sha256 …)`), so the pattern
 * allows leading and trailing blanks and nothing else: a line that is not exactly this shape is left alone and
 * therefore still fails a comparison.
 */
const SOURCE_RECORD = /^([ \t]*-- Source: .*\(sha256 )([0-9a-f]{64})(\)[ \t]*)$/m;
/** Replace the record's digest with a placeholder when it is a legitimate digest of `file`, else leave it.
 *  Exported for `tools/pool-01-check.mjs` so the builder and its checker share ONE implementation (N5). */
export function canonicalSourceRecord(text, file) {
  const allowed = legitimateSourceDigests(file);
  return text.replace(SOURCE_RECORD, (whole, head, hex, tail) => (allowed.has(hex) ? `${head}<source>${tail}` : whole));
}

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

/* ============================================================================ batch mode
 *
 * POOL-01 (task-37). A later batch of authored sets cannot be appended to `data/seed.json`: this builder
 * regenerates the WHOLE of migration `0010` from that file, and `0010` is APPLIED with a frozen MANIFEST
 * sha256 — appending there would either rewrite an applied migration or leave it silently stale. So a batch
 * gets its OWN authored source and its OWN forward migration, generated HERE, through the SAME `splitSet`
 * above: one implementation of the split rule, not two.
 *
 *   node tools/build-objective-migration.mjs --batch <file> --out <migration>            write it
 *   node tools/build-objective-migration.mjs --batch <file> --out <migration> --check    verify it
 *   `--media <descriptors.json>` repoints the audio descriptors (default: the built
 *   `content/exams/<exam>/pool-listening-media.json`; see the batch-audio section below).
 *
 * The batch source is `{ batch, exam_id, sets: [{ set_id, family, release, ...authored set }] }`. `release`
 * is `released` (imported by this migration) or `held` (authored, shape-validated, deliberately NOT
 * imported — because a set whose audio cannot play must not enter the pool). A held set proves its shape by
 * being generated here and compared, and by `tools/pool-01-check.mjs` normalising it; it contributes NO rows
 * until it is flipped to `released`, its audio exists and a new forward migration is cut.
 *
 * A RELEASED LISTENING SET ALSO BRINGS ITS AUDIO IN: see the batch-audio section, which emits the
 * `content_version`/`content_rights`/`exam_media` rows that make its recordings playable.
 *
 * Default behaviour (no `--batch`) is unchanged, and `--check` without `--batch` still verifies `0010` byte
 * for byte against `data/seed.json`.
 */
const argValue = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
};

/**
 * The rights decision recorded with every imported content row.
 *
 * WHO DECIDES. The basis for Hatoove's own content is the product owner's standing decision (D1, 2 October
 * 2026, recorded by migration `0020` and carried into batch authoring by contract A11(a)): original content
 * written for Hatoove, no third-party item bank, basis `generated`. This is a PROVENANCE record, not a review
 * or an exam-validity claim — the sets stay `unreviewed`. The note names this batch, so the ledger says which
 * content the decision covers and how it was applied.
 */
const BATCH_RIGHTS = Object.freeze({
  decidedBy: 'Ron (product owner); standing D1 basis applied by POOL-01 task-37',
  note: 'Original content authored for Hatoove (no third-party item bank, no published material reproduced); POOL-01 batch 1, task-37, 5 October 2026. Source:',
});

/* ============================================================================ batch audio (task-48)
 *
 * A RELEASED LISTENING SET NEEDS BYTES, NOT A PROMISE. The batch generator used to emit rows for the
 * authored content only, which is why the three listening sets had to stay `held`: a Hörverstehen set in the
 * pool whose audio cannot play is worse than an absent one (contract A11(b); POOL-01 lease rule 2). This leg
 * closes that: when a released batch set carries a `recordings[]` binding, the tool ALSO emits the audio's own
 * `content_version` row, its rights decision and its `exam_media` row — the exact three things
 * `tools/practice-media-check.mjs` and `server/owned-postgres/practice-playback.mjs` need before a recording
 * can be accounted and served.
 *
 * THE DESCRIPTORS ARE NOT RE-TYPED. They come from the file `tools/listening-tts-build.mjs` writes from the
 * REAL bytes (`content/exams/<exam>/pool-listening-media.json` — see `--media`), and each one is validated with
 * `validateMediaDescriptor`, the SAME rule the exam-package importer applies. That rule refuses a descriptor
 * that claims `reviewed`/`approved`: a generator cannot mint a content approval, and a listening set whose
 * audio a human has not heard stays `unreviewed` here however the descriptor is written.
 *
 * A RELEASED LISTENING SET WITH NO BINDING IS AN ERROR, not an omission. So is one whose descriptor is
 * missing: the audio has not been built, so the set must stay `held` in the source.
 */
const DEFAULT_BATCH_MEDIA = 'content/exams/' + EXAM_ID + '/pool-listening-media.json';
const MEDIA_RIGHTS = Object.freeze({
  decidedBy: 'Ron (product owner); standing D1 basis applied by POOL-01 task-48',
  note: 'Machine speech (Google Cloud Text-to-Speech) from a script authored for Hatoove; POOL-01 batch 1 listening release, task-48, 5 October 2026. Descriptor:',
});

/** The batch's authored audio descriptors, keyed `mediaId@version`. Read only when a set actually needs one. */
function readBatchMedia(mediaPath) {
  if (!existsSync(mediaPath)) {
    throw new Error(`the batch's listening audio descriptors are missing: ${path.relative(ROOT, mediaPath)}`
      + ' — build the audio first (tools/listening-tts-build.mjs --batch <source> --media-root <content/exams root>)');
  }
  const parsed = JSON.parse(readFileSync(mediaPath, 'utf8'));
  const byId = new Map();
  for (const row of parsed.media ?? []) {
    validateMediaDescriptor(row, EXAM_ID);
    byId.set(`${row.mediaId}@${row.version}`, row);
  }
  if (!byId.size) throw new Error(`no media descriptors in ${path.relative(ROOT, mediaPath)}`);
  return byId;
}

/** One batch set's rows, through the SAME split the corpus uses. */
function batchRows(batch, batchPath, indexInFamily) {
  const family = batch.family;
  if (typeof family !== 'string' || !/^[A-Z]{2}[0-9]$/.test(family)) throw new Error(`invalid family: ${String(family)}`);
  const setId = batch.set_id;
  if (typeof setId !== 'string' || !setId.startsWith(`${EXAM_ID}.${family.toLowerCase()}.`)) {
    throw new Error(`set_id must start with ${EXAM_ID}.${family.toLowerCase()}. — got ${String(setId)}`);
  }
  const release = batch.release;
  if (release !== 'released' && release !== 'held') throw new Error(`${setId}: release must be 'released' or 'held'`);
  const authored = { ...batch };
  delete authored.set_id;
  delete authored.family;
  delete authored.release;
  const { payload, answers, explanations, transcript } = splitSet(family, authored);
  const itemCount = Object.keys(answers).length;
  if (!itemCount) throw new Error(`${setId}: no answers extracted`);
  if (MEDIA_FAMILIES.has(family) && !transcript) throw new Error(`${setId}: a listening set must carry a script`);
  const version = 'v1';
  const contentVersionId = `${setId}@${version}`;
  const setDigest = createHash('sha256').update(JSON.stringify(authored)).digest('hex');
  const relativeSource = `${path.relative(ROOT, batchPath).replaceAll('\\', '/')}#${family}[${indexInFamily}]`;
  return {
    release,
    row: {
      content: `    (${sqlText(contentVersionId)}, 'task', ${sqlText(SECTION_OF(family).toLowerCase())}, ${sqlText(relativeSource)}, 'unreviewed', 'unknown', ${sqlText(setDigest)}, ${sqlText(EXAM_ID)})`,
      /* A CONTENT ROW WITHOUT A RIGHTS DECISION IS INVISIBLE, not merely ungated: the serving policy allows
         only generated/licensed/commissioned, so a row that falls through to its seed-time value 'unknown'
         fails closed and the set never reaches a learner (0020; tools/content-rights-check.mjs leg 1). The
         batch therefore records the decision with the row, exactly as 0020 did for the seeded corpus. */
      rights: `    (${sqlText(contentVersionId)}, 'generated', ${sqlText(BATCH_RIGHTS.decidedBy)}, ${sqlText(`${BATCH_RIGHTS.note} ${relativeSource}.`)})`,
      set: `    (${[
        sqlText(setId), sqlText(version), sqlText(EXAM_ID), sqlText(family),
        sqlText(SECTION_OF(family)), String(PART_OF(family)),
        sqlText(authored.title || setId),
        sqlJson(payload), String(itemCount), MEDIA_FAMILIES.has(family) ? 'true' : 'false',
        sqlText(contentVersionId),
      ].join(', ')})`,
      key: `    (${[
        sqlText(setId), sqlText(version), sqlJson(answers), sqlJson(explanations),
        transcript === null ? 'NULL' : sqlText(transcript),
      ].join(', ')})`,
    },
  };
}

function buildBatch(batchPath, batchSource, { mediaPath = null } = {}) {
  if (!Array.isArray(batchSource.sets) || !batchSource.sets.length) throw new Error('the batch source carries no sets');
  const seen = new Set();
  const seenIds = new Set();
  const families = new Map();
  const content = [];
  const rights = [];
  const sets = [];
  const keys = [];
  const held = [];
  const mediaContent = [];
  const mediaRights = [];
  const examMedia = [];
  const recordedMedia = new Set();
  const mediaFile = mediaPath ?? path.join(ROOT, DEFAULT_BATCH_MEDIA);
  const relativeMedia = path.relative(ROOT, mediaFile).replaceAll('\\', '/');
  let descriptors = null;
  for (const entry of batchSource.sets) {
    const family = entry?.family;
    const indexInFamily = families.get(family) ?? 0;
    families.set(family, indexInFamily + 1);
    if (seenIds.has(entry?.set_id)) throw new Error(`duplicate set_id in the batch source: ${String(entry?.set_id)}`);
    seenIds.add(entry?.set_id);
    const { release, row } = batchRows(entry, batchPath, indexInFamily);
    if (release === 'held') { held.push(`${entry.set_id} (${family})`); continue; }
    seen.add(family);
    content.push(row.content);
    rights.push(row.rights);
    sets.push(row.set);
    keys.push(row.key);
    /* The audio a released listening set DOES carry, emitted as the rows the playback path resolves. */
    const bindings = Array.isArray(entry.recordings) ? entry.recordings : [];
    if (MEDIA_FAMILIES.has(family) && !bindings.length) {
      throw new Error(`${entry.set_id}: a released listening set must carry its recordings[] binding — without it the set stays 'held' (task-48)`);
    }
    if (!MEDIA_FAMILIES.has(family) && bindings.length) {
      throw new Error(`${entry.set_id}: a ${family} set carries recordings[] but is not a listening family`);
    }
    for (const recording of bindings) {
      const mediaId = recording?.mediaId, version = recording?.mediaVersion;
      if (typeof mediaId !== 'string' || typeof version !== 'string' || !mediaId || !version) {
        throw new Error(`${entry.set_id}: a recordings[] binding needs a mediaId and a mediaVersion`);
      }
      if (recordedMedia.has(`${mediaId}@${version}`)) continue;
      recordedMedia.add(`${mediaId}@${version}`);
      descriptors = descriptors ?? readBatchMedia(mediaFile);
      const descriptor = descriptors.get(`${mediaId}@${version}`);
      if (!descriptor) throw new Error(`${entry.set_id}: no built audio descriptor for ${mediaId}@${version} in ${relativeMedia}`);
      const identity = `${mediaId}@${version}`;
      mediaContent.push(`    (${[
        sqlText(identity), "'media'", "'listening'", sqlText(`${relativeMedia}#${identity}`),
        "'unreviewed'", "'generated'", sqlText(packageHash(descriptor)), sqlText(EXAM_ID),
      ].join(', ')})`);
      mediaRights.push(`    (${sqlText(identity)}, 'generated', ${sqlText(MEDIA_RIGHTS.decidedBy)}, ${sqlText(`${MEDIA_RIGHTS.note} ${relativeMedia}#${identity}.`)})`);
      examMedia.push(`    (${[
        sqlText(descriptor.mediaId), sqlText(descriptor.version), sqlText(EXAM_ID), sqlText(descriptor.path),
        sqlText(descriptor.sha256), String(descriptor.byteLength), String(descriptor.durationMs),
        sqlText(descriptor.mimeType), sqlText(identity),
      ].join(', ')})`);
    }
  }
  if (!sets.length) throw new Error('the batch source releases no set at all');
  const batchDigest = createHash('sha256').update(readFileSync(batchPath)).digest('hex');
  const sql = `
    -- POOL-01 (MIRROR-B1PREP-01, task-37) — batch 1 of the prioritised top-up, GENERATED from
    -- ${path.relative(ROOT, batchPath).replaceAll('\\', '/')}.
    --
    -- DO NOT EDIT THIS FILE BY HAND. Run:
    --   node tools/build-objective-migration.mjs --batch ${path.relative(ROOT, batchPath).replaceAll('\\', '/')} --out <this file>
    -- and \`--check\` fails if this file and the source disagree.
    --
    -- Source: ${path.relative(ROOT, batchPath).replaceAll('\\', '/')} (sha256 ${batchDigest})
    -- Batch: ${String(batchSource.batch ?? 'unnamed')} — authored for Hatoove, every set 'unreviewed'.
    ${batchSource.apply_hold ? `
    -- ############################################################################
    -- # HELD FROM APPLY: ${String(batchSource.apply_hold)}
    -- # The SQL below is COMPLETE and idempotent; this marker is procedural. An applied migration cannot be
    -- # withdrawn, so it is released only when the condition above is met. Remove it by clearing \`apply_hold\`
    -- # in the batch source and regenerating — the marker is data, and \`--check\` fails if the two disagree.
    -- ############################################################################` : ''}
    ${batchSource.key_fix_pending ? `
    -- ############################################################################
    -- # CONTENT DECISION PENDING: ${String(batchSource.key_fix_pending.set_id ?? 'a set')} item
    -- # ${String(batchSource.key_fix_pending.text_id ?? '?')} is DISPUTED — the product owner's words:
    -- # "${String(batchSource.key_fix_pending.ron ?? '')}". The authored key is still in the rows below and
    -- # must NOT be applied before he confirms the replacement. The proposal, the mechanical shape check and
    -- # the second pass over the other keys are in the batch source (\`key_fix_pending\`) and in
    -- # work/implementation/POOL-01-BATCH-1.md §2.
    -- ############################################################################` : ''}
    ${Array.isArray(batchSource.content_decisions) && batchSource.content_decisions.length ? `
    -- CONTENT DECISIONS CONFIRMED (the product owner, relayed by the Lead):
${batchSource.content_decisions.map((decision) => {
  const parts = [`item ${String(decision.text_id ?? '?')} -> headline ${String(decision.confirmed_answer ?? '?')}`];
  if (decision.headline_text && decision.previous_headline_text) {
    parts.push(`headline ${String(decision.confirmed_answer)} is reworded to "${String(decision.headline_text)}" (was "${String(decision.previous_headline_text)}")`);
  }
  return `    --   ${String(decision.set_id ?? decision.label ?? '?')}: ${parts.join('; ')}`;
}).join('\n')}` : ''}
    --
    -- WHY A SECOND MIGRATION AND NOT AN EDIT OF 0010. 0010 is applied in every installation and its bytes
    -- are pinned in MANIFEST.json; a batch is a FORWARD change. This file inserts only its own rows and
    -- nothing else, so applying it to a database that already carries 0010 (or to an empty one) is the
    -- same operation.
    ${held.length ? `
    -- HELD, and deliberately NOT inserted: ${held.join(', ')}.
    -- Their scripts and items are authored and validated (tools/pool-01-check.mjs normalises every one of
    -- them), but a listening set whose audio cannot play must not enter the pool. Releasing one is a one-word
    -- edit to its \`release\` marker in the source, a recordings[] binding, the built audio and a new forward
    -- migration from this same command.` : ''}
    INSERT INTO "__SCHEMA__".content_version
      (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
    VALUES
${content.join(',\n')}
    ON CONFLICT (content_version_id) DO NOTHING;

    -- The rights decision that goes WITH the row. Without it the serving policy fails closed ('unknown' can
    -- never be opted in) and the set would sit in the catalogue, invisible: 0020 records one decision per
    -- content version, and tools/content-rights-check.mjs asserts the invariant.
    INSERT INTO "__SCHEMA__".content_rights (content_version_id, basis, decided_by, note)
    VALUES
${rights.join(',\n')}
    ON CONFLICT (content_version_id) DO NOTHING;

    INSERT INTO "__SCHEMA__".objective_set
      (set_id, version, exam_id, family, section, part, title, payload, item_count, media_required, content_version_id)
    VALUES
${sets.join(',\n')}
    ON CONFLICT (set_id, version) DO NOTHING;

    INSERT INTO "__SCHEMA__".objective_key
      (set_id, version, answers, explanations, transcript)
    VALUES
${keys.join(',\n')}
    ON CONFLICT (set_id, version) DO NOTHING;
${examMedia.length ? `
    -- THE AUDIO A RELEASED LISTENING SET PLAYS (task-48). Same three rows the exam-package importer creates for
    -- a packaged recording — its own content_version ('media'/'listening'), its rights decision, and the
    -- exam_media row the playback port resolves — because a set whose recordings[] names a media row that does
    -- not exist answers 'media_unavailable' and debits nothing. The facts are the DESCRIPTOR's, read from
    -- ${relativeMedia}, which was written from the real bytes by
    -- tools/listening-tts-build.mjs; the generator re-reads it on every --check, so a re-cut file fails here.
    INSERT INTO "__SCHEMA__".content_version
      (content_version_id, kind, family, source_path, review_status, rights_status, content_sha256, exam_id)
    VALUES
${mediaContent.join(',\n')}
    ON CONFLICT (content_version_id) DO NOTHING;

    INSERT INTO "__SCHEMA__".content_rights (content_version_id, basis, decided_by, note)
    VALUES
${mediaRights.join(',\n')}
    ON CONFLICT (content_version_id) DO NOTHING;

    INSERT INTO "__SCHEMA__".exam_media
      (media_id, version, exam_id, path, sha256, byte_length, duration_ms, mime_type, content_version_id)
    VALUES
${examMedia.join(',\n')}
    ON CONFLICT (media_id, version) DO NOTHING;
` : ''}`;
  return { sql, released: sets.length, held, families: [...seen].sort(), media: examMedia.length };
}

/*
 * CLI BODY, GUARDED (N5). This module is both a generator and a library: `tools/pool-01-check.mjs` imports
 * the source-record rule from it, and an unguarded import would RUN the generator — printing the census and,
 * in the write path below, rewriting the committed `0010-objective-catalogue.sql` as a side effect of a
 * CHECK. The bytes happen to be identical while the tree is consistent, which is exactly why the hazard is
 * worth removing rather than noticing later.
 */
const isCli = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCli) {
const batchArg = argValue('--batch');
if (batchArg) {
  const batchPath = path.resolve(ROOT, batchArg);
  const outArg = argValue('--out');
  if (!outArg) { console.error('batch mode needs --out <migration file>'); process.exit(2); }
  const outPath = path.resolve(ROOT, outArg);
  const batchSource = JSON.parse(readFileSync(batchPath, 'utf8'));
  const mediaArg = argValue('--media');
  const buildOptions = { mediaPath: mediaArg ? path.resolve(ROOT, mediaArg) : null };
  const { sql: batchText, released, held, families, media } = buildBatch(batchPath, batchSource, buildOptions);
  if (process.argv.includes('--check')) {
    const current = existsSync(outPath) ? readFileSync(outPath, 'utf8') : '';
    // Every byte must match except the platform-dependent source record (see legitimateSourceDigests above).
    if (canonicalSourceRecord(current, batchPath) !== canonicalSourceRecord(batchText, batchPath)) {
      console.error(`objective-batch: FAILED ${path.relative(ROOT, outPath)} differs from ${path.relative(ROOT, batchPath)}`);
      console.error(`  run: node tools/build-objective-migration.mjs --batch ${batchArg} --out ${outArg}`);
      process.exit(1);
    }
    console.log(`objective-batch: OK ${path.relative(ROOT, outPath)} matches ${path.relative(ROOT, batchPath)}`);
    console.log(`  released sets: ${released} (${families.join(', ')}); held: ${held.length}${held.length ? ' — ' + held.join(', ') : ''}`);
    console.log(`  recordings   : ${media} media row(s) pinned from the built descriptors`);
    process.exit(0);
  }
  writeFileSync(outPath, batchText);
  console.log(`objective-batch: wrote ${path.relative(ROOT, outPath)}`);
  console.log(`  released sets : ${released} (${families.join(', ')})`);
  console.log(`  held sets     : ${held.length}${held.length ? ' — ' + held.join(', ') : ''}`);
  console.log(`  recordings    : ${media} media row(s) pinned from the built descriptors`);
  process.exit(0);
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
  // Every byte must match except the platform-dependent source record (see legitimateSourceDigests above).
  if (canonicalSourceRecord(current, SOURCE) !== canonicalSourceRecord(sql, SOURCE)) {
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
} /* end of the guarded CLI body */
