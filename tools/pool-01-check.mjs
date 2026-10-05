#!/usr/bin/env node
/**
 * POOL-01 batch 1 (MIRROR-B1PREP-01, tasks 37 + 48) — the authored batch and the migrations it generates.
 *
 *   node tools/pool-01-check.mjs                 the offline legs
 *   node tools/pool-01-check.mjs --postgres      adds the database legs (disposable database)
 *   node tools/pool-01-check.mjs --no-mutations  the legs without the mutation proof
 *
 * WHAT THIS GUARDS. Batch 1 authors six sets: three for LV1, released by the FROZEN
 * `server/migrations/0047-pool-01-batch-1.sql`, and one each for HV1, HV2 and HV3, which were AUTHORED AND
 * HELD because a listening set whose audio cannot play must not enter the pool (contract A11(b); POOL-01
 * lease rule 2). Task-48 built the three recordings (Google Cloud TTS) and released all three, so the held
 * half is now released too, by `server/migrations/0048-pool-01-listening-release.sql` — and THAT migration
 * carries the audio's own rows (`content_version`, `content_rights`, `exam_media`), because a
 * `recordings[]` binding that names a media row nobody created answers `media_unavailable` and plays nothing.
 * The legs therefore check:
 *
 *   1. the authored source has the EXAM'S SHAPE per family (LV1: 10 headlines a–j for 5 matching items; HV1
 *      5, HV2 10, HV3 5 richtig/falsch items with the blueprint's item numbers), every set is released, and
 *      every released listening set carries a `recordings[]` binding that names a BUILT descriptor;
 *   2. every set normalises through the REAL `normalisePracticeSet` to a served DTO whose item ids ARE the
 *      key ids and whose every key is offered with its own JSON type, with no secret field anywhere in the
 *      learner payload — and whose listening material reaches the runner;
 *   3. the FROZEN 0047 still imports exactly the three LV1 sets, unreviewed, with their provenance, their
 *      rights decisions and Ron's confirmed content decisions recorded (the half that must not move);
 *   4. the new 0048 imports the three listening sets, unreviewed, with their provenance, their keys and one
 *      `exam_media` row per recording whose facts are the BUILT file's, and whose bytes the SHIPPED reader
 *      (`server/media-contract.mjs`) actually reads;
 *   5. the committed 0048 is byte-identical to what the builder regenerates (`--check`), the additive builder
 *      change left the frozen `0010` byte-identical, and the database applies `0048` last, serves the new
 *      LV1 sets through the shipped practice path, reaches them by the selection rule, and wraps at the new
 *      per-part set count.
 *
 * MUTATION PROOF. Every named guard is attacked on a throwaway copy: a released listening set stripped of
 * its `recordings[]` binding, a built recording whose recorded sha256 is changed, a descriptor deleted, an
 * LV1 answer that is not one of the set's headlines, a released set dropped from the batch, the builder's
 * secret-field rule emptied, the generator's source-record rule accepting any digest, and three checks on
 * Ron's `lv1.06` decisions (a duplicated confirmed key, the confirmed key changed afterwards, the rejected
 * wording restored). A leg that cannot fail is worse than no leg. The pristine control runs first; when it is
 * not clean the run reports that as a NAMED failure, skips the mutation proofs and still prints its tally —
 * it used to throw an uncaught AssertionError, which is how CI lost legs 8+ entirely (POOL-01-CI-01).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

/* ONE implementation of the source-record rule, shared with the generator (N5). */
import { canonicalSourceRecord, legitimateSourceDigests } from './build-objective-migration.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'content/pool-01/batch-1.json';
/** The FROZEN half: applied in production, its bytes pinned by MANIFEST.json, never regenerated. */
const FROZEN_MIGRATION = 'server/migrations/0047-pool-01-batch-1.sql';
/** This slice's migration. Generated from the SAME source with the same command. */
const MIGRATION = 'server/migrations/0048-pool-01-listening-release.sql';
/** The audio descriptors of the batch's listening sets, written from the real bytes by listening-tts-build. */
const MEDIA = 'content/exams/telc-deutsch-b1/pool-listening-media.json';
const CORPUS_MIGRATION = 'server/migrations/0010-objective-catalogue.sql';
const MANIFEST = 'server/migrations/MANIFEST.json';
const BUILDER = 'tools/build-objective-migration.mjs';
const LOCALES = null; // not an interface-copy slice
/** The three LV1 sets the frozen migration imports, and the three listening sets this slice releases. */
const LV1_BATCH = Object.freeze(['telc-deutsch-b1.lv1.04', 'telc-deutsch-b1.lv1.05', 'telc-deutsch-b1.lv1.06']);
const LISTENING_BATCH = Object.freeze(['telc-deutsch-b1.hv1.04', 'telc-deutsch-b1.hv2.04', 'telc-deutsch-b1.hv3.04']);
/**
 * The exact authored text of one released listening set's `recordings[]` binding, and the same source with that
 * audio removed. ONE definition, used twice: the negative leg that requires the GENERATOR to refuse a released
 * listening set with no audio, and the source mutation that proves the leg can fail. A mutation whose pattern
 * is written twice drifts; this one cannot.
 */
const HV1_RECORDINGS_BLOCK = Object.freeze({
  with: '"title": "Nachrichten von Kolleginnen und Kollegen",\n      "recordings": [\n        {\n          "id": "hv1.04-recording",\n          "mediaId": "telc-deutsch-b1.hv1.04.audio",\n          "mediaVersion": "v1",\n          "label": "Nachrichten von Kolleginnen und Kollegen"\n        }\n      ],',
  without: '"title": "Nachrichten von Kolleginnen und Kollegen",',
});
/** Remove hv1.04's audio binding from a source text. Returns the text unchanged when the pattern is absent. */
const stripListeningAudio = (text) => text.replace(HV1_RECORDINGS_BLOCK.with, HV1_RECORDINGS_BLOCK.without);

const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const firstLine = (error) => String(error && error.message).split('\n')[0];

/**
 * The digests a source file legitimately hashes to.
 *
 * `data/seed.json` and `content/pool-01/batch-1.json` carry no `eol` attribute, so git checks them out CRLF on
 * Windows (`core.autocrlf=true`) and LF everywhere else: the SAME content has two byte forms, and a committed
 * migration can only record the digest of the form its generating platform had. Measured on 5 October 2026
 * (POOL-01-CI-01): seed.json is `ef26279d…` CRLF / `40a0a066…` LF, and batch-1.json is `45e361a1…` CRLF /
 * `f39498a1…` LF. The committed `0010` and `0047` record the CRLF values, which is why a literal comparison
 * passed on Windows and failed on the ubuntu checkout.
 *
 * A record is therefore accepted only when it is the digest of THIS checkout's file in one of those two forms
 * — the set is computed from the file on disk at check time, never from a table of blessed digests, so a stale
 * record or a source that moved still fails.
 *
 * THE RULE IS NOT REIMPLEMENTED HERE (N5). It lives in `tools/build-objective-migration.mjs`
 * (`legitimateSourceDigests` / `canonicalSourceRecord`) and is imported, because a generator and its checker
 * that each implement the rule can drift — and a drifted pair is how a gate silently stops meaning anything.
 */

/** The blueprint's item numbering per family (docs/exam/TELC-B1-SOURCES.md §3.1, §3.3). */
const ITEM_NUMBERS = Object.freeze({
  HV1: [41, 42, 43, 44, 45],
  HV2: [46, 47, 48, 49, 50, 51, 52, 53, 54, 55],
  HV3: [56, 57, 58, 59, 60],
});
/** The item member of each family's authored shape. */
const ITEM_MEMBER = Object.freeze({ LV1: 'texts', LV2: 'questions', LV3: 'situations', SB1: 'gaps', SB2: 'gaps', HV1: 'items', HV2: 'items', HV3: 'items' });
/** The section each family belongs to. */
const SECTION_OF = (family) => family.replace(/[0-9]+$/, '');
/** Released sets per part BEFORE this batch, measured from a migrated database (POOL-01-INVENTORY.md). */
const RELEASED_BEFORE = Object.freeze({ LV1: 3, LV2: 3, LV3: 3, SB1: 4, SB2: 3, HV1: 3, HV2: 3, HV3: 3 });
/** The approved distribution of the six authored sets (Lead, 5 Oct 2026). */
const APPROVED_BATCH = Object.freeze({ LV1: 3, HV1: 1, HV2: 1, HV3: 1 });
/** The pool once BOTH halves of batch 1 are applied: the LV1 three by 0047, the listening three by 0048. */
const RELEASED_AFTER = Object.freeze({ LV1: 6, LV2: 3, LV3: 3, SB1: 4, SB2: 3, HV1: 4, HV2: 4, HV3: 4 });
const SECRET_KEYS = Object.freeze(['answer', 'why', 'script', 'grammar', 'explanations', 'transcript']);

const deepFindKeys = (value, wanted, found = []) => {
  if (Array.isArray(value)) { for (const entry of value) deepFindKeys(entry, wanted, found); return found; }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (wanted.includes(key)) found.push(key);
      deepFindKeys(entry, wanted, found);
    }
  }
  return found;
};

/**
 * The learner-facing payload of one authored set, derived INDEPENDENTLY of the builder: the check must be
 * able to disagree with the artifact, so it re-derives the split's expectation rather than asking the
 * builder for it. `set_id`/`family`/`release` are the batch file's own metadata, not content.
 */
function expectedPayload(entry) {
  const payload = {};
  for (const [field, value] of Object.entries(entry)) {
    if (['set_id', 'family', 'release'].includes(field)) continue;
    if (SECRET_KEYS.includes(field)) continue;
    if (!Array.isArray(value)) { payload[field] = value; continue; }
    payload[field] = value.map((item) => {
      if (!item || typeof item !== 'object') return item;
      return Object.fromEntries(Object.entries(item).filter(([key]) => !SECRET_KEYS.includes(key)));
    });
  }
  return payload;
}

/** The key side of one authored set: `answers` by item id and `explanations` by item id (plus the set-level why). */
function expectedKey(entry) {
  const answers = {};
  const explanations = {};
  for (const [field, value] of Object.entries(entry)) {
    if (field === 'why') { explanations['_set_why'] = value; continue; }
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id ?? item.n ?? '');
      if (item.answer !== undefined) answers[id] = item.answer;
      if (item.why !== undefined) explanations[id] = item.why;
    }
  }
  return { answers, explanations };
}

function buildLegs({ source, sourceText, migration, migrationText, releaseText, media, mediaText, normalise, builderPath, corpusText, mediaPath, readMediaBytes }) {
  const sets = source.sets ?? [];
  const released = sets.filter((entry) => entry.release === 'released');
  /** No set may stay HELD once its audio exists — the release marker and the audio move together (task-48). */
  const held = sets.filter((entry) => entry.release === 'held');
  /** The half the FROZEN 0047 owns, and the listening ids 0047 names but deliberately does not insert. */
  const frozenReleased = sets.filter((entry) => LV1_BATCH.includes(entry.set_id));
  const frozenHeld = LISTENING_BATCH;
  /** The descriptors the audio build wrote, by media identity. */
  const descriptors = new Map(((media && media.media) ?? []).map((row) => [`${row.mediaId}@${row.version}`, row]));
  /** The exam_media rows of one migration, so a leg can compare them with the built file. */
  const examMediaRows = (text) => {
    const start = text.indexOf('INSERT INTO "__SCHEMA__".exam_media');
    if (start < 0) return [];
    const body = text.slice(start).split('ON CONFLICT')[0];
    return [...body.matchAll(/\(\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([a-f0-9]{64})',\s*(\d+),\s*(\d+),\s*'([^']+)',\s*'([^']+)'\)/g)]
      .map((match) => ({
        mediaId: match[1], version: match[2], examId: match[3], path: match[4],
        sha256: match[5], byteLength: Number(match[6]), durationMs: Number(match[7]),
        mimeType: match[8], contentVersionId: match[9],
      }));
  };
  return [
    ['1 the authored batch: six sets, all released, the approved distribution, and the EXAM shape per family', () => {
      assert.equal(sets.length, 6, 'six authored sets');
      const perFamily = {};
      for (const entry of sets) perFamily[entry.family] = (perFamily[entry.family] ?? 0) + 1;
      assert.deepEqual(perFamily, APPROVED_BATCH, 'LV1 +3 and one each to HV1/HV2/HV3 (Lead, 5 Oct 2026)');
      assert.equal(released.length, 6, 'all six sets are released: the LV1 three by 0047, the listening three by 0048');
      assert.equal(held.length, 0, 'no set is held once its audio exists (task-48 released the three listening sets)');
      assert.deepEqual(released.map((entry) => entry.family), ['LV1', 'LV1', 'LV1', 'HV1', 'HV2', 'HV3'], 'in source order');
      const ids = new Set();
      for (const entry of sets) {
        assert.ok(/^telc-deutsch-b1\.[a-z]{2}[0-9]\.[0-9]{2}$/.test(entry.set_id), `set_id shape: ${entry.set_id}`);
        assert.ok(entry.set_id.startsWith(`telc-deutsch-b1.${entry.family.toLowerCase()}.`), `${entry.set_id} matches its family`);
        assert.ok(!ids.has(entry.set_id), `duplicate set id ${entry.set_id}`);
        ids.add(entry.set_id);
        assert.ok(typeof entry.title === 'string' && entry.title.trim().length > 3, `${entry.set_id} has a title`);
        if (entry.family === 'LV1') {
          assert.ok(!entry.recordings, `${entry.set_id}: a reading set carries no audio`);
          assert.equal(entry.headlines.length, 10, 'LV1 offers ten headlines (a–j) for five items');
          assert.deepEqual(entry.headlines.map((row) => row.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
          assert.equal(entry.texts.length, 5, 'LV1 asks five matching items');
          assert.deepEqual(entry.texts.map((row) => row.id), ['1', '2', '3', '4', '5'], 'the blueprint numbers them 1–5');
          const headlineIds = new Set(entry.headlines.map((row) => row.id));
          const used = new Set();
          for (const text of entry.texts) {
            assert.ok(headlineIds.has(text.answer), `${entry.set_id}/${text.id}: the answer is one of the headlines, got ${JSON.stringify(text.answer)}`);
            assert.ok(!used.has(text.answer), `${entry.set_id}: NO two texts share a headline (a corrected key must not create a duplicate) — ${text.answer}`);
            used.add(text.answer);
            assert.ok(typeof text.text === 'string' && text.text.trim().split(/\s+/).length >= 20, `${entry.set_id}/${text.id}: an authored text, not a fragment`);
            assert.ok(typeof entry.why?.[text.id] === 'string' && entry.why[text.id].length > 20, `${entry.set_id}/${text.id}: an explanation for the key`);
          }
          assert.equal(used.size, 5, 'EXACTLY ONE headline per text: five distinct headlines answer the five texts');
        } else {
          const numbers = ITEM_NUMBERS[entry.family];
          assert.ok(numbers, `${entry.set_id}: a known listening family`);
          assert.deepEqual(entry.items.map((row) => row.n), numbers, `${entry.family} uses the blueprint's item numbers`);
          for (const item of entry.items) {
            assert.equal(typeof item.answer, 'boolean', `${entry.set_id}/${item.n}: a richtig/falsch key`);
            assert.ok(typeof item.statement === 'string' && item.statement.trim().split(/\s+/).length >= 6, `${entry.set_id}/${item.n}: a statement`);
            assert.ok(typeof item.why === 'string' && item.why.length > 20, `${entry.set_id}/${item.n}: an explanation`);
          }
          assert.ok(entry.answerDistribution === undefined, 'no invented field');
          const trues = entry.items.filter((item) => item.answer === true).length;
          assert.ok(trues >= 1 && trues < entry.items.length, `${entry.set_id}: the key is not all one value`);
          assert.ok(typeof entry.script === 'string' && entry.script.trim().length >= 300, `${entry.set_id}: a full recording script is authored`);
          /*
           * THE RELEASE IS THE AUDIO. A listening set is 'released' only because a recording exists, and the
           * binding that names it is the only thing the playback port can resolve: `recordings[]` at set level,
           * `mediaId`/`mediaVersion` matching a descriptor the synthesis actually produced. A released
           * listening set without one is the defect this whole slice exists to prevent, so it is asserted
           * here as well as refused by the generator.
           */
          assert.equal(entry.release, 'released', `${entry.set_id}: released — its recording exists (task-48)`);
          assert.ok(Array.isArray(entry.recordings) && entry.recordings.length === 1, `${entry.set_id}: one recordings[] binding`);
          const [binding] = entry.recordings;
          assert.equal(binding.mediaId, `${entry.set_id}.audio`, `${entry.set_id}: the binding names this set's audio`);
          assert.equal(binding.mediaVersion, 'v1', `${entry.set_id}: pinned to the media version`);
          assert.equal(binding.label, entry.title, `${entry.set_id}: and it is labelled with the set's own title`);
          assert.ok(descriptors.has(`${binding.mediaId}@${binding.mediaVersion}`),
            `${entry.set_id}: the binding resolves to a BUILT descriptor (${binding.mediaId}@${binding.mediaVersion})`);
        }
      }
      /* The arithmetic, before/after, per part. */
      const after = { ...RELEASED_BEFORE };
      for (const entry of released) after[entry.family] += 1;
      assert.deepEqual(after, RELEASED_AFTER, 'released sets after BOTH halves of batch 1');
      assert.equal(Object.values(RELEASED_BEFORE).reduce((a, b) => a + b, 0), 25, '25 released sets before');
      assert.equal(Object.values(after).reduce((a, b) => a + b, 0), 31, '31 released in total');
    }],
    ['2 every authored set serves a well-formed DTO through the REAL normaliser, audio material included', () => {
      for (const entry of sets) {
        const payload = expectedPayload(entry);
        const { answers } = expectedKey(entry);
        const items = payload[ITEM_MEMBER[entry.family]];
        const itemIds = items.filter((row) => row.answer !== undefined || answers[String(row.id ?? row.n)] !== undefined).map((row) => String(row.id ?? row.n));
        assert.deepEqual(itemIds.sort(), Object.keys(answers).sort(), `${entry.set_id}: the DTO's item ids are the key ids`);
        const served = normalise({
          set_id: entry.set_id, version: 'v1', title: entry.title, family: entry.family,
          section: SECTION_OF(entry.family), part: Number(entry.family.match(/([0-9]+)$/)[1]),
          item_count: Object.keys(answers).length,
          media_required: ['HV1', 'HV2', 'HV3'].includes(entry.family),
          payload,
        }, null);
        assert.equal(served.items.length, Object.keys(answers).length, `${entry.set_id}: every keyed item is served`);
        assert.deepEqual(served.items.map((item) => item.item_id).sort(), Object.keys(answers).sort(), `${entry.set_id}: id identity`);
        for (const item of served.items) {
          const key = answers[item.item_id];
          const keyed = item.options.find((option) => option.value === key);
          assert.ok(keyed, `${entry.set_id}/${item.item_id}: the key is OFFERED by the served options`);
          assert.equal(typeof keyed.value, typeof key, `${entry.set_id}/${item.item_id}: offered with the KEY's own JSON type`);
          assert.ok(item.options.length >= 2, `${entry.set_id}/${item.item_id}: at least two options`);
        }
        if (['HV1', 'HV2', 'HV3'].includes(entry.family)) {
          /* The runner needs the binding in `material`, not only in the stored payload (practice-sets.mjs). */
          assert.ok(Array.isArray(served.material.recordings) && served.material.recordings.length === 1,
            `${entry.set_id}: the served material carries the recording the runner binds its items to`);
          assert.equal(served.material.recordings[0].mediaId, `${entry.set_id}.audio`, `${entry.set_id}: with the pinned media id`);
        } else {
          assert.ok(served.material.recordings === undefined, `${entry.set_id}: no audio material on a reading set`);
        }
        /* No secret material anywhere in the learner payload — deep scan, not a field-by-field check. */
        const leaked = deepFindKeys(payload, SECRET_KEYS);
        assert.deepEqual(leaked, [], `${entry.set_id}: no answer/why/script/explanation rides in the learner payload`);
        assert.ok(!JSON.stringify(payload).includes('"answer"'), `${entry.set_id}: and not as a JSON key either`);
      }
    }],
    ['3 the FROZEN 0047 still imports the three LV1 sets and nothing else, unreviewed, with its provenance', () => {
      for (const entry of frozenReleased) {
        assert.ok(migrationText.includes(`'${entry.set_id}'`), `${entry.set_id} is imported`);
        assert.ok(migrationText.includes(`@v1`), 'versioned');
      }
      const indexInFamily = new Map();
      for (const entry of sets.filter((row) => row.family === 'LV1')) {
        const index = indexInFamily.get(entry.family) ?? 0;
        indexInFamily.set(entry.family, index + 1);
        if (entry.release !== 'released') continue;
        assert.ok(migrationText.includes(`'${SOURCE}#LV1[${index}]'`), `the provenance path of ${entry.set_id} names the authored source`);
      }
      for (const setId of frozenHeld) {
        assert.ok(!migrationText.includes(`'${setId}'`), `${setId} was HELD when 0047 was cut: it must not be imported by it`);
        assert.ok(!new RegExp(`'${setId.replaceAll('.', '\\.')}@v1'`).test(migrationText), `${setId} has no content_version row in 0047 either`);
      }
      assert.ok(migrationText.includes('HELD, and deliberately NOT inserted'), 'the frozen artifact discloses the held sets in its own header');
      for (const setId of frozenHeld) assert.ok(migrationText.includes(setId), `the disclosure names ${setId}`);
      /* The ROW shape, not the bare word: the header comment also says "unreviewed". */
      const unreviewed = migrationText.match(/'unreviewed', 'unknown'/g) ?? [];
      assert.equal(unreviewed.length, frozenReleased.length, 'every set FROZEN 0047 imported is marked unreviewed — an agent does not mark content reviewed');
      /*
       * THE APPLY HOLD IS DATA, IN EITHER STATE. The Lead held this batch from being applied until Ron had read
       * the three LV1 sets (an applied migration cannot be withdrawn) and LIFTED it once he had (task-43). The
       * marker lives in the SOURCE and is emitted into the migration, so a regeneration can neither drop the
       * hold silently nor keep it silently: the field must still exist, and its state must match the artifact.
       */
      assert.ok(Object.hasOwn(source, 'apply_hold'), 'the source still declares the hold field, so its state is explicit');
      if (source.apply_hold) {
        assert.ok(migrationText.includes('HELD FROM APPLY'), 'the source holds this batch from apply, and the migration says so');
        assert.ok(migrationText.includes(String(source.apply_hold).slice(0, 60)), 'with the reason the source records');
      } else {
        assert.ok(!migrationText.includes('HELD FROM APPLY'), 'the hold is LIFTED in the source, and the migration carries no hold marker');
        assert.ok(typeof source.apply_hold_history === 'string' && /LIFTED/.test(source.apply_hold_history),
          'and the lift is recorded rather than forgotten');
      }
      /*
       * A CONTENT DECISION IS EITHER PENDING OR CONFIRMED, AND THE CHECK KNOWS BOTH. While a key is disputed the
       * authored value stays and the migration carries a PENDING banner (task-43). Once the product owner
       * confirms, the source carries `content_decisions` and this leg flips to the stronger pin: the authored key
       * IS the confirmed value and the pending banner is gone — so a future agent cannot silently change a
       * confirmed key, and a pending marker cannot linger after a decision.
       */
      assert.ok(typeof source.key_fix_pending === 'undefined' || typeof source.key_fix_pending === 'object');
      const decisions = Array.isArray(source.content_decisions) ? source.content_decisions : [];
      assert.ok(decisions.length > 0, 'the source records the confirmed content decisions');
      assert.ok(read('work/implementation/POOL-01-BATCH-1.md').includes('lv1.06'), 'the note records them');
      if (source.key_fix_pending) {
        assert.ok(migrationText.includes('CONTENT DECISION PENDING'), 'a pending decision is marked in the artifact');
        assert.ok(!migrationText.includes('CONTENT DECISIONS CONFIRMED'), 'and a pending one is not called confirmed');
      } else {
        assert.ok(!migrationText.includes('CONTENT DECISION PENDING'), 'no decision is pending, and no stale banner lingers');
        assert.ok(migrationText.includes('CONTENT DECISIONS CONFIRMED'), 'the artifact records that the decisions were confirmed');
      }
      for (const decision of decisions) {
        const label = decision.label ?? decision.set_id;
        const set = sets.find((entry) => entry.set_id === decision.set_id);
        assert.ok(set, `${label}: ${decision.set_id} is in the batch`);
        const text = set.texts.find((row) => row.id === String(decision.text_id));
        assert.ok(text, `${label}: item ${decision.text_id} exists`);
        assert.ok(decision.confirmed_by && /Ron/.test(decision.confirmed_by), `${label}: the decision names who confirmed it`);
        assert.equal(text.answer, decision.confirmed_answer,
          `${label}: the authored key IS the confirmed value (${decision.confirmed_answer}) — not something an agent may change`);
        assert.equal(set.texts.filter((row) => row.answer === decision.confirmed_answer).length, 1,
          `${label}: the confirmed headline answers exactly ONE text`);
        assert.equal(new Set(set.texts.map((row) => row.answer)).size, set.texts.length,
          `${label}: and one headline per text still holds — no duplicate`);
        if (decision.headline_text) {
          const headline = set.headlines.find((row) => row.id === decision.confirmed_answer);
          assert.ok(headline, `${label}: the confirmed headline exists`);
          assert.equal(headline.text, decision.headline_text, `${label}: the headline carries the confirmed wording`);
          assert.notEqual(decision.headline_text, decision.previous_headline_text,
            `${label}: the wording actually changed from the rejected form`);
        }
      }
      /*
       * THE REWORDED HEADLINE, CHECKED THREE WAYS (task-47). Ron chose "keep the text, reword the headline", and a
       * reworded ad can break a set in ways a key swap cannot, so the edit is asserted rather than eyeballed:
       *   (a) it answers BOTH halves of the text (a van AND helpers), so a learner reasoning from
       *       „Wer hat einen Transporter …?" is not trapped;
       *   (b) it stays a headline in the register and length of the other nine;
       *   (c) it cannot become a better match for any OTHER text of the set.
       */
      const moving = decisions.find((decision) => decision.headline_text);
      if (moving?.headline_text) {
        const set = sets.find((entry) => entry.set_id === moving.set_id);
        const headline = set.headlines.find((row) => row.id === moving.confirmed_answer);
        const text = set.texts.find((row) => row.id === String(moving.text_id));
        assert.match(headline.text, /(Transporter|Umzug)/i, '(a) the reworded headline names the transport half');
        assert.match(headline.text, /(Helfer|Hilfe|helfen)/i, '(a) and the help half — nobody is trapped on the van');
        assert.ok(!/zu vermieten|zu verleihen/i.test(headline.text), '(a) and it no longer offers a van FOR HIRE');
        assert.ok(text.text.includes('Transporter') && text.text.includes('helfen'),
          '(a) the text it answers still asks for both, unchanged');
        const lengths = set.headlines.map((row) => row.text.length);
        assert.ok(headline.text.length >= Math.min(...lengths) - 10 && headline.text.length <= Math.max(...lengths) + 10,
          `(b) headline length ${headline.text.length} sits with the other nine (${Math.min(...lengths)}–${Math.max(...lengths)})`);
        assert.ok(headline.text.split(/\s+/).length <= 10, '(b) headline length in words');
        assert.ok(!/[.!]$/.test(headline.text), '(b) a headline, not a sentence');
        /* (c) No topic of another text may appear: this is the mechanical half of "check it against every text". */
        const TOPIC_TERMS = {
          1: ['Nachhilfe', 'Mathematik', 'Klasse'],
          2: ['Senior', 'Spazierg', 'Gespräch'],
          3: ['Hund'],
          5: ['Kind', 'Babysitter', 'Betreu', 'Tagesmutter'],
        };
        for (const [textId, terms] of Object.entries(TOPIC_TERMS)) {
          if (textId === String(moving.text_id)) continue;
          for (const term of terms) {
            assert.ok(!new RegExp(term, 'i').test(headline.text),
              `(c) the reworded headline must not claim text ${textId}'s topic (${term})`);
          }
        }
        /* The served payload carries the reworded headline and NOT the rejected wording. */
        const payloadRow = migrationText.split('\n').find((line) => line.includes(`'${moving.set_id}'`) && line.includes('::jsonb'));
        assert.ok(payloadRow, 'the migration carries the learner payload for the reworded set');
        assert.ok(payloadRow.includes(moving.headline_text), 'and the payload carries the reworded headline');
        assert.ok(!/zu vermieten/i.test(payloadRow), 'and NOT the wording the product owner rejected');
      }
      /* The second question is CLOSED: text 5 keeps `g`, and text 5 and headline b are untouched. */
      const care = decisions.find((decision) => decision.headline_b);
      if (care) {
        const set = sets.find((entry) => entry.set_id === care.set_id);
        assert.equal(set.texts.find((row) => row.id === String(care.text_id)).answer, care.confirmed_answer,
          'text 5 keeps the confirmed key g');
        assert.equal(set.headlines.find((row) => row.id === 'b').text, care.headline_b,
          'and headline b is untouched, as the closed decision records');
        assert.match(care.status, /CLOSED/, 'the near-tie is recorded as closed rather than left open');
      }
      const valued = migrationText.slice(migrationText.indexOf('INSERT INTO'));
      assert.ok(!/'approved'/.test(valued), 'and none is claimed reviewed');
      assert.ok(!valued.includes('"answer"'), 'no answers in the generated SQL payload');
      assert.ok(!valued.includes('"why"'), 'no explanations in the learner payload');
      assert.ok(!valued.includes('"script"'), 'no transcripts in the learner payload');
      assert.ok(!migrationText.includes('CREATE TABLE'), 'forward-only: it adds rows, it does not restate the schema');
      assert.ok(migrationText.includes('ON CONFLICT (set_id, version) DO NOTHING'), 'idempotent on re-apply');
      assert.ok(migrationText.includes('INSERT INTO "__SCHEMA__".objective_key'), 'the key lands in the key table');
      /* A content row without a rights decision is INVISIBLE: the policy fails closed on 'unknown'. */
      assert.ok(migrationText.includes('INSERT INTO "__SCHEMA__".content_rights'), 'the rights decision travels WITH the content row');
      const rightsRows = migrationText.match(/@v1', 'generated',/g) ?? [];
      assert.equal(rightsRows.length, frozenReleased.length, 'one recorded basis per imported set');
    }],
    ['4 the new 0048 releases the three listening sets, unreviewed, with their PROVENANCE and their AUDIO', () => {
      for (const setId of LISTENING_BATCH) {
        assert.ok(releaseText.includes(`'${setId}@v1'`), `${setId} has a content_version row in the release migration`);
      }
      /* Provenance is per family: the index restarts at the first set of each family in the source. */
      for (const entry of sets.filter((row) => LISTENING_BATCH.includes(row.set_id))) {
        assert.ok(releaseText.includes(`'${SOURCE}#${entry.family}[0]'`), `${entry.set_id}: provenance names the authored batch source`);
      }
      const unreviewed = releaseText.match(/'unreviewed', 'unknown'/g) ?? [];
      assert.equal(unreviewed.length, released.length, 'every released set the migration carries is marked unreviewed');
      assert.ok(!/'approved'/.test(releaseText.slice(releaseText.indexOf('INSERT INTO'))), 'and none is claimed reviewed');
      /*
       * THE LV1 HALF IS REPLAYED, NOT REWRITTEN. The generator emits the batch's released sets as they now
       * stand, so the three LV1 rows appear in 0048 as well — harmless only because `ON CONFLICT … DO NOTHING`
       * makes them no-ops. That is exactly the shape that could smuggle a silent content edit past a reviewer,
       * so the whole LV1 half of 0048 is compared, line for line, with the half the FROZEN 0047 already
       * applied: content_version, rights, set and key. A changed word, key or digest fails here by name.
       */
      const linesFor = (text, setId) => text.split('\n')
        .filter((line) => line.includes(`'${setId}`))
        /* The last value tuple of a file has no trailing comma; the row itself is what is compared. */
        .map((line) => line.replace(/,$/, ''));
      for (const setId of LV1_BATCH) {
        const frozen = linesFor(migrationText, setId);
        assert.ok(frozen.length >= 4, `${setId}: the frozen 0047 carries all four rows`);
        assert.deepEqual(linesFor(releaseText, setId), frozen, `${setId}: 0048 replays exactly the rows 0047 applied`);
      }
      const setRights = releaseText.match(/standing D1 basis applied by POOL-01 task-37/g) ?? [];
      assert.equal(setRights.length, released.length, 'one recorded basis per released set');
      const mediaRights = releaseText.match(/standing D1 basis applied by POOL-01 task-48/g) ?? [];
      assert.equal(mediaRights.length, LISTENING_BATCH.length, 'and one per released recording');
      /*
       * THE AUDIO'S OWN ROWS. A recordings[] binding is a promise; `exam_media` is the row the trigger and the
       * playback port resolve it against (`0045-practice-playback.sql`), and without it a released listening
       * set answers `media_unavailable` and plays nothing. So the binding, the media row and the descriptor
       * have to AGREE on all three sides: identity, file and content_version.
       */
      const rows = examMediaRows(releaseText);
      assert.equal(rows.length, LISTENING_BATCH.length, 'one exam_media row per released recording');
      for (const entry of sets.filter((row) => LISTENING_BATCH.includes(row.set_id))) {
        const [binding] = entry.recordings;
        const row = rows.find((candidate) => candidate.mediaId === binding.mediaId && candidate.version === binding.mediaVersion);
        assert.ok(row, `${entry.set_id}: exam_media carries ${binding.mediaId}@${binding.mediaVersion}`);
        const descriptor = descriptors.get(`${binding.mediaId}@${binding.mediaVersion}`);
        assert.equal(row.examId, 'telc-deutsch-b1', `${entry.set_id}: exam scoped`);
        assert.equal(row.path, descriptor.path, `${entry.set_id}: the row names the BUILT file`);
        assert.equal(row.sha256, descriptor.sha256, `${entry.set_id}: and pins its sha256`);
        assert.equal(row.byteLength, descriptor.byteLength, `${entry.set_id}: byte length`);
        assert.equal(row.durationMs, descriptor.durationMs, `${entry.set_id}: duration`);
        assert.equal(row.mimeType, 'audio/wav', `${entry.set_id}: the only mime type 0029 allows`);
        assert.equal(row.contentVersionId, `${binding.mediaId}@${binding.mediaVersion}`, `${entry.set_id}: the row is tied to the media content_version`);
        /* The media content_version is the importer's own shape: kind 'media', family 'listening', unreviewed. */
        assert.ok(releaseText.includes(`'${binding.mediaId}@${binding.mediaVersion}', 'media', 'listening'`),
          `${entry.set_id}: the media content_version uses the importer's kind/family`);
        /* The stored payload carries the binding the playback port reads (and no transcript). */
        const setRow = releaseText.split('\n').find((line) => line.includes(`('${entry.set_id}', 'v1', 'telc-deutsch-b1'`));
        assert.ok(setRow, `${entry.set_id}: the objective_set row is in the migration`);
        assert.ok(setRow.includes(`"mediaId":"${binding.mediaId}"`), `${entry.set_id}: the payload carries the media binding`);
        assert.ok(/,\s*true,\s*'telc-deutsch-b1\.hv[123]\.04@v1'\)/.test(setRow), `${entry.set_id}: and is marked media_required`);
        assert.ok(!setRow.includes('"script"') && !setRow.includes('"answer"'), `${entry.set_id}: no transcript or answer in the learner payload`);
      }
      assert.ok(!releaseText.includes('CREATE TABLE'), 'forward-only: it adds rows, it does not restate the schema');
      assert.ok(releaseText.includes('ON CONFLICT (set_id, version) DO NOTHING'), 'idempotent on re-apply');
      assert.ok(releaseText.includes('ON CONFLICT (media_id, version) DO NOTHING'), 'and idempotent for the media rows');
      assert.ok(releaseText.includes('INSERT INTO "__SCHEMA__".objective_key'), 'the keys land in the key table');
      assert.ok(releaseText.includes('INSERT INTO "__SCHEMA__".content_rights'), 'every content row travels WITH its rights decision');
    }],
    ['5 the additive builder change left the corpus untouched: 0010 still matches its source, and the batch is not spliced into it', async () => {
      const generated = await runNode([builderPath, '--check']);
      assert.equal(generated.code, 0, `the corpus migration must still match data/seed.json:\n${generated.out.slice(-300)}`);
      assert.match(generated.out, /24 sets, 24 keys/, 'the seeded corpus is still 24 sets');
      const header = corpusText.match(/([ \t]*-- Source: data\/seed\.json \(sha256 )([0-9a-f]{64})(\))/);
      assert.ok(header, '0010 records the digest of the source it was generated from');
      /*
       * EXACT, BUT PLATFORM-INDEPENDENT — and NOT a rubber stamp. Two things are asserted, and both can
       * fail. (1) The record is this checkout's data/seed.json in one of its byte forms, through the
       * GENERATOR'S OWN rule (imported, not reimplemented). (2) A hand-edited record is refused end to end:
       * the digest is changed by one character in a throwaway copy of the migration and the generator is
       * asked to accept it with `--check`, which must fail. The old assert here compared a fabricated
       * digest against a set of three real ones and could never fail; this one cannot pass vacuously,
       * because it also requires the PRISTINE copy to be accepted first.
       */
      const seedFile = path.join(ROOT, 'data/seed.json');
      const seedForms = legitimateSourceDigests(seedFile);
      assert.ok(seedForms.has(header[2]),
        `0010's recorded digest must be data/seed.json in one of its byte forms; recorded ${header[2]}, this checkout has ${[...seedForms].join(' / ')}`);
      const handEdited = `${header[2].slice(0, 63)}${header[2].endsWith('0') ? '1' : '0'}`;
      assert.notEqual(handEdited, header[2], 'the fabricated digest is a different value');
      /* The generator canonicalises a legitimate record and leaves a hand-edited one alone, so the two
         cannot look the same to the comparison. */
      assert.notEqual(
        canonicalSourceRecord(`${header[1]}${header[2]}${header[3]}`, seedFile),
        canonicalSourceRecord(`${header[1]}${handEdited}${header[3]}`, seedFile),
        'a hand-edited source record must NOT canonicalise to the same thing as a real one',
      );
      /* (2) A hand-edited record is refused END TO END. The generator's own `--check` honours `--out` on the
         BATCH axis, so a copy of THIS slice's 0048 with one hex character of its source record changed must
         be refused, and the pristine copy accepted first — otherwise the refusal could be about something
         else. The axis is the release migration, not the frozen 0047: 0047 is no longer regenerable from the
         moved-on source, and a check that regenerated it would be asserting a historical coincidence. */
      const batchRecord = releaseText.match(/([ \t]*-- Source: content\/pool-01\/batch-1\.json \(sha256 )([0-9a-f]{64})(\))/);
      assert.ok(batchRecord, '0048 carries a source record to hand-edit');
      const handEditedBatch = `${batchRecord[2].slice(0, 63)}${batchRecord[2].endsWith('0') ? '1' : '0'}`;
      assert.notEqual(handEditedBatch, batchRecord[2], 'the hand-edited digest differs');
      const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pool01-handedited-'));
      const pristineCopy = path.join(scratchDir, '0048-pristine.sql');
      const editedCopy = path.join(scratchDir, '0048-hand-edited.sql');
      fs.writeFileSync(pristineCopy, releaseText);
      fs.writeFileSync(editedCopy, releaseText.replace(batchRecord[0], `${batchRecord[1]}${handEditedBatch}${batchRecord[3]}`));
      const acceptedControl = await runNode([builderPath, '--batch', SOURCE, '--media', mediaPath, '--out', pristineCopy, '--check']);
      assert.equal(acceptedControl.code, 0, `the generator must still accept the pristine copy (the control):\n${acceptedControl.out.slice(-300)}`);
      const refusedEdited = await runNode([builderPath, '--batch', SOURCE, '--media', mediaPath, '--out', editedCopy, '--check']);
      assert.notEqual(refusedEdited.code, 0, 'a hand-edited source digest must be REFUSED by the generator, not accepted');
      assert.match(refusedEdited.out, /objective-batch: FAILED|differs from/, `and the refusal must name the migration:\n${refusedEdited.out.slice(-300)}`);
      fs.rmSync(scratchDir, { recursive: true, force: true });
      /* The batch lives in its OWN source: no batch set id may appear in the corpus source. */
      const seedText = read('data/seed.json');
      for (const entry of sets) assert.ok(!seedText.includes(entry.set_id), `${entry.set_id} is not spliced into data/seed.json`);
      assert.ok(!seedText.includes(sets[0].title), 'nor its passages');
    }],
    ['6 the committed 0048 is byte-identical to what the builder regenerates (--check)', async () => {
      const result = await runNode([builderPath, '--batch', SOURCE, '--media', mediaPath, '--out', MIGRATION, '--check']);
      assert.equal(result.code, 0, `the builder must accept the committed migration:\n${result.out.slice(-400)}`);
      assert.match(result.out, /released sets: 6/, 'and report that all six sets are released');
      assert.match(result.out, /held: 0/, 'with none held');
      assert.match(result.out, /recordings\s*: 3 media row/, 'and the three pinned recordings');
      // The same platform-independent reading of 0048's own source record as leg 5 applies to 0010's.
      const record = releaseText.match(/Source: content\/pool-01\/batch-1\.json \(sha256 ([0-9a-f]{64})\)/);
      assert.ok(record, '0048 records the digest of the batch source it was generated from');
      const batchForms = legitimateSourceDigests(path.join(ROOT, SOURCE));
      assert.ok(batchForms.has(record[1]),
        `0048's recorded digest must be ${SOURCE} in one of its byte forms; recorded ${record[1]}, this checkout has ${[...batchForms].join(' / ')}`);
      /*
       * AND THE GENERATOR REFUSES THE DEFECT THIS SLICE REMOVES. A listening set that says `released` while
       * nothing names its audio is exactly what 'held' used to be for, so the generator must not quietly
       * release a set whose recording is missing: it exits non-zero and names the set. The mutated source is a
       * throwaway copy, so the repository's own batch file is never written to.
       */
      const stripped = stripListeningAudio(sourceText.replaceAll('\r\n', '\n'));
      assert.notEqual(stripped, sourceText.replaceAll('\r\n', '\n'), 'the no-audio mutation must change the source');
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pool01-noaudio-'));
      const strippedSource = path.join(scratch, 'batch-1.json');
      fs.writeFileSync(strippedSource, stripped);
      const refused = await runNode([builderPath, '--batch', strippedSource, '--media', mediaPath, '--out', path.join(scratch, 'out.sql')]);
      fs.rmSync(scratch, { recursive: true, force: true });
      assert.notEqual(refused.code, 0, 'a released listening set with no recordings[] binding must be REFUSED by the generator');
      assert.match(refused.out, /must carry its recordings\[\] binding/, `and the refusal must say why:\n${refused.out.slice(-300)}`);
    }],
    ['7 the MANIFEST lines are the sha256 of the migration bytes — the frozen one included', () => {
      const recorded = JSON.parse(read(MANIFEST)).migrations;
      assert.equal(recorded['0048-pool-01-listening-release'], sha256(read(MIGRATION)), 'MANIFEST 0048 equals the generated bytes');
      assert.equal(recorded['0047-pool-01-batch-1'], sha256(read(FROZEN_MIGRATION)), 'MANIFEST 0047 still equals the FROZEN bytes');
      assert.ok(!/\r\n/.test(releaseText), 'LF only: the manifest digest records the bytes');
      assert.ok(!/\r\n/.test(migrationText), 'LF only for the frozen migration too');
      /* The frozen half must not move: 0047 keeps its own three sets and none of the released listening ids. */
      for (const setId of LV1_BATCH) assert.ok(migrationText.includes(`'${setId}'`), `the frozen 0047 still carries ${setId}`);
      for (const setId of LISTENING_BATCH) assert.ok(!migrationText.includes(`'${setId}'`), `${setId} is a 0048 row, not a 0047 one`);
    }],
    ['8 the three recordings exist: the SHIPPED reader verifies them, and their ids are free in the corpus', async () => {
      assert.equal(descriptors.size, 3, 'the batch built exactly three recordings');
      const corpus = corpusText;
      for (const entry of sets.filter((row) => LISTENING_BATCH.includes(row.set_id))) {
        const [binding] = entry.recordings;
        const descriptor = descriptors.get(`${binding.mediaId}@${binding.mediaVersion}`);
        assert.ok(!corpus.includes(`'${entry.set_id}'`), `${entry.set_id} does not collide with the seeded corpus`);
        assert.ok(!corpus.includes(`'${binding.mediaId}'`), `${binding.mediaId} does not collide with the seeded media`);
        const { answers } = expectedKey(entry);
        assert.equal(Object.keys(answers).length, ITEM_NUMBERS[entry.family].length, `${entry.set_id}: every blueprint item is keyed`);
        assert.ok(Object.values(answers).every((value) => typeof value === 'boolean'), `${entry.set_id}: boolean keys`);
        /*
         * HONESTY IS PART OF THE SHAPE. Machine speech from a machine-drafted script is exactly what this is,
         * so the descriptor may not claim otherwise: the media contract's own rule refuses anything that is
         * not unreviewed/generated, and the source string has to name the machine voice.
         */
        assert.equal(descriptor.reviewStatus, 'unreviewed', `${binding.mediaId}: machine speech is unreviewed until a human hears it`);
        assert.equal(descriptor.rightsStatus, 'generated', `${binding.mediaId}: recorded basis 'generated'`);
        assert.match(descriptor.source, /Text-to-Speech/, `${binding.mediaId}: the source names the machine voice`);
        assert.match(descriptor.source, new RegExp(entry.set_id.replaceAll('.', '\\.')), `${binding.mediaId}: and the authored script it reads`);
        /*
         * THE BYTES, THROUGH THE READER THE SERVER USES. Not a stat() and not a hash of our own: readMediaBytes
         * re-parses the RIFF header, re-derives the duration and compares the sha256 with the descriptor, so a
         * re-cut, truncated or corrupt file fails here with the same code publication would raise.
         */
        const bytes = await readMediaBytes(descriptor, {});
        assert.equal(bytes.length, descriptor.byteLength, `${binding.mediaId}: the file is the recorded length`);
        const row = examMediaRows(releaseText).find((candidate) => candidate.mediaId === binding.mediaId);
        assert.ok(row, `${binding.mediaId}: the migration pins the file`);
        assert.deepEqual(
          { path: row.path, sha256: row.sha256, byteLength: row.byteLength, durationMs: row.durationMs },
          { path: descriptor.path, sha256: descriptor.sha256, byteLength: descriptor.byteLength, durationMs: descriptor.durationMs },
          `${binding.mediaId}: the pinned media row is the built descriptor`,
        );
      }
      const ids = new Set(sets.map((entry) => entry.set_id));
      assert.equal(ids.size, sets.length, 'no duplicate ids');
      assert.ok(!sets.some((entry) => ['LV2', 'LV3', 'SB1', 'SB2'].includes(entry.family)), 'the batch stays inside the four authorised parts');
      const mediaIds = new Set([...descriptors.values()].map((row) => row.mediaId));
      assert.equal(mediaIds.size, 3, 'three distinct media identities');
    }],
  ];
}

/* ------------------------------------------------------------------------------- harness */

const runNode = (args, extraEnv = {}, timeoutMs = 180000) => new Promise((resolve) => {
  const child = spawn(process.execPath, args, { cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += String(chunk); });
  child.stderr.on('data', (chunk) => { out += String(chunk); });
  const timer = setTimeout(() => { child.kill('SIGKILL'); }, timeoutMs);
  child.once('exit', (code) => { clearTimeout(timer); resolve({ code, out }); });
});

async function runLegs(label, deps) {
  const results = [];
  for (const [name, run] of buildLegs(deps)) {
    try {
      await run();
      results.push(['PASS', name]);
    } catch (error) {
      results.push(['FAIL', `${label}${name}  [${firstLine(error).slice(0, 220)}]`]);
    }
  }
  return results;
}

/**
 * A throwaway tree in which a MUTATED builder can still resolve the repository.
 *
 * The builder derives its root from its own file location, so a copy dropped in a bare temp directory reads no
 * source at all: every leg then fails on "the corpus migration must still match data/seed.json" — a missing
 * file, not the mutation — and the "proof" becomes decorative. That is exactly what the first version of this
 * harness did for every builder mutation. The tree below mirrors the layout with directory junctions to the
 * real `data/`, `content/` and `server/`, and the mutated file is the only real file in it.
 *
 * `--check` RUNS ONLY. A write through a junction would reach the repository, so no leg may write to a path
 * under this tree. (fs.rmSync does not follow junctions — verified on Windows — so teardown cannot delete the
 * repository either.)
 */
function isolatedBuilderTree(mutatedText) {
  const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-01-builder-'));
  for (const name of ['data', 'content', 'server']) {
    fs.symlinkSync(path.join(ROOT, name), path.join(tree, name), 'junction');
  }
  fs.mkdirSync(path.join(tree, 'tools'));
  const builderCopy = path.join(tree, 'tools', 'build-objective-migration.mjs');
  fs.writeFileSync(builderCopy, mutatedText);
  return { tree, builderCopy };
}

/* ------------------------------------------------------------------ PostgreSQL legs */

async function postgresLegs() {
  if (process.env.OWNAPI_PG_ALLOW !== '1' || process.env.OWNAPI_PG_HOST !== '127.0.0.1') {
    throw new Error('explicit local disposable PostgreSQL required (OWNAPI_PG_ALLOW=1, OWNAPI_PG_HOST=127.0.0.1)');
  }
  const { randomUUID } = await import('node:crypto');
  const { createFixture } = await import('../server/owned-postgres/bootstrap.mjs');
  const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
  const { persistentConfig, createAdminPool } = await import('../server/owned-postgres/provision.mjs');
  const outcome = [];
  const pgLeg = async (name, run) => {
    try { await run(); outcome.push(['PASS', name]); } catch (error) { outcome.push(['FAIL', `${name}: ${firstLine(error)}`]); }
  };
  const policyKeys = ['B1PREP_CONTENT_MODE', 'B1PREP_SERVE_REVIEW', 'B1PREP_SERVE_RIGHTS'];
  const savedPolicy = Object.fromEntries(policyKeys.map((key) => [key, process.env[key]]));
  const restorePolicy = () => {
    for (const key of policyKeys) {
      if (savedPolicy[key] === undefined) delete process.env[key];
      else process.env[key] = savedPolicy[key];
    }
  };
  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
  delete process.env.B1PREP_SERVE_REVIEW;
  delete process.env.B1PREP_SERVE_RIGHTS;
  const EXAM = 'telc-deutsch-b1';

  /* ---------------------------------------------------- a real migration into a scratch schema */
  const leg = 'pool01_l1';
  const legConfig = persistentConfig({ ...process.env, OWNAPI_PG_SCHEMA: leg, OWNAPI_PG_ROLE_PREFIX: leg });
  const legAdmin = createAdminPool(legConfig, { applicationName: `${leg}:checker` });
  const resetLeg = async () => {
    await legAdmin.query(`DROP SCHEMA IF EXISTS "${leg}" CASCADE`);
    const roles = (await legAdmin.query('SELECT rolname FROM pg_roles WHERE rolname LIKE $1', [`${leg}\\_%`])).rows;
    for (const { rolname } of roles) {
      await legAdmin.query(`DROP OWNED BY "${rolname}" CASCADE`).catch(() => {});
      await legAdmin.query(`DROP ROLE IF EXISTS "${rolname}"`).catch(() => {});
    }
  };

  let db = null;
  try {
    await resetLeg();
    const migrated = await runNode(['server/migrate.mjs'], { OWNAPI_PG_SCHEMA: leg, OWNAPI_PG_ROLE_PREFIX: leg, OWNAPI_PG_ALLOW: '1' });
    await pgLeg('P1 SQL: a clean database applies 0048 LAST, with the ledger checksums matching the file bytes', async () => {
      assert.equal(migrated.code, 0, `migrate must exit 0:\n${migrated.out.slice(-300)}`);
      const rows = (await legAdmin.query(`SELECT id, checksum FROM "${leg}".hatoove_migrations ORDER BY id`)).rows;
      assert.equal(rows.at(-1).id, '0048-pool-01-listening-release', 'the release migration is applied last');
      assert.equal(rows.at(-1).checksum, sha256(read(MIGRATION)), 'and its ledger checksum is the sha256 of the generated file');
      const frozen = rows.find((row) => row.id === '0047-pool-01-batch-1');
      assert.ok(frozen, 'the frozen 0047 is in the ledger');
      assert.equal(frozen.checksum, sha256(read(FROZEN_MIGRATION)), 'with the checksum of ITS bytes — an applied migration did not move');
      assert.ok(rows.every((row) => row.checksum), 'every migration carries a checksum');
    });

    await pgLeg('P2 SQL: the released pool is 31 sets — LV1 six, each listening part four — with the audio the three sets name', async () => {
      const counts = (await legAdmin.query(
        `SELECT family, count(*)::int AS sets FROM "${leg}".objective_set WHERE exam_id = $1 GROUP BY family ORDER BY family`, [EXAM])).rows;
      const perFamily = Object.fromEntries(counts.map((row) => [row.family, row.sets]));
      assert.deepEqual(perFamily, RELEASED_AFTER, 'the pool after BOTH halves of batch 1');
      assert.equal(counts.reduce((total, row) => total + row.sets, 0), 31, '31 released sets');
      /* The listening three are RELEASED now, and each one's payload binds the recording it plays. */
      for (const entry of JSON.parse(read(SOURCE)).sets.filter((row) => LISTENING_BATCH.includes(row.set_id))) {
        const bound = (await legAdmin.query(
          `SELECT s.media_required, s.payload->'recordings'->0->>'mediaId' AS media_id,
                  s.payload->'recordings'->0->>'mediaVersion' AS media_version
             FROM "${leg}".objective_set s WHERE s.set_id = $1`, [entry.set_id])).rows[0];
        assert.ok(bound, `${entry.set_id} is in the released pool`);
        assert.equal(bound.media_required, true, `${entry.set_id}: marked as audio material`);
        assert.equal(bound.media_id, entry.recordings[0].mediaId, `${entry.set_id}: bound to the recording it plays`);
        assert.equal(bound.media_version, entry.recordings[0].mediaVersion, `${entry.set_id}: at the pinned version`);
      }
    });

    await pgLeg('P2b SQL: each released recording has an exam_media row that is the BUILT file, unreviewed and generated', async () => {
      const descriptors = JSON.parse(read(MEDIA)).media;
      const rows = (await legAdmin.query(
        `SELECT m.media_id, m.version, m.path, m.sha256, m.byte_length, m.duration_ms, m.mime_type, m.content_version_id,
                c.kind, c.family, c.review_status, c.rights_status, coalesce(r.basis, c.rights_status) AS basis
           FROM "${leg}".exam_media m
           JOIN "${leg}".content_version c USING (content_version_id)
           LEFT JOIN "${leg}".content_rights r USING (content_version_id)
          WHERE m.media_id = ANY($1::text[]) ORDER BY m.media_id`,
        [descriptors.map((row) => row.mediaId)])).rows;
      assert.equal(rows.length, descriptors.length, 'one exam_media row per released recording');
      for (const descriptor of descriptors) {
        const row = rows.find((candidate) => candidate.media_id === descriptor.mediaId);
        assert.ok(row, `${descriptor.mediaId}: the row the binding names exists`);
        assert.equal(row.path, descriptor.path, `${descriptor.mediaId}: the file the build wrote`);
        assert.equal(row.sha256, descriptor.sha256, `${descriptor.mediaId}: the sha256 of those bytes`);
        assert.equal(row.byte_length, descriptor.byteLength, `${descriptor.mediaId}: byte length`);
        assert.equal(row.duration_ms, descriptor.durationMs, `${descriptor.mediaId}: duration`);
        assert.equal(row.mime_type, 'audio/wav', `${descriptor.mediaId}: the only type 0029 allows`);
        assert.equal(row.content_version_id, `${descriptor.mediaId}@${descriptor.version}`, `${descriptor.mediaId}: tied to its own content_version`);
        assert.equal(row.kind, 'media', `${descriptor.mediaId}: the importer's own kind`);
        assert.equal(row.family, 'listening', `${descriptor.mediaId}: and family`);
        assert.equal(row.review_status, 'unreviewed', `${descriptor.mediaId}: machine speech stays unreviewed`);
        assert.equal(row.basis, 'generated', `${descriptor.mediaId}: with a recorded rights basis, so the row can be served`);
      }
    });

    await pgLeg('P3 SQL: every imported set is unreviewed, carries its provenance, and its key has all the answers', async () => {
      const rows = (await legAdmin.query(
        `SELECT s.set_id, s.title, s.item_count, s.media_required, c.review_status, c.source_path, c.exam_id,
                r.basis, r.decided_by, r.note,
                (SELECT count(*)::int FROM "${leg}".objective_key k WHERE k.set_id = s.set_id AND k.version = s.version) AS keys,
                (SELECT count(*)::int FROM jsonb_object_keys((SELECT k.answers FROM "${leg}".objective_key k WHERE k.set_id = s.set_id AND k.version = s.version))) AS answers
           FROM "${leg}".objective_set s
           JOIN "${leg}".content_version c USING (content_version_id)
           LEFT JOIN "${leg}".content_rights r USING (content_version_id)
          WHERE s.set_id LIKE 'telc-deutsch-b1.lv1.0%' AND s.set_id >= 'telc-deutsch-b1.lv1.04'
          ORDER BY s.set_id`)).rows;
      assert.equal(rows.length, 3, 'three new LV1 sets');
      rows.forEach((row, index) => {
        assert.equal(row.review_status, 'unreviewed', `${row.set_id}: unreviewed, as an agent must leave it`);
        assert.equal(row.source_path, `${SOURCE}#LV1[${index}]`, `${row.set_id}: provenance names the authored batch source`);
        assert.equal(row.exam_id, EXAM, 'exam scoped');
        assert.equal(row.item_count, 5, `${row.set_id}: five matching items`);
        assert.equal(row.answers, 5, `${row.set_id}: five keys`);
        assert.equal(row.keys, 1, `${row.set_id}: one key row`);
        assert.equal(row.media_required, false, `${row.set_id}: LV1 needs no media`);
        assert.ok(row.title.length > 3, 'a title');
        /* The rights decision is what makes the row SERVABLE; without it the set fails closed. */
        assert.equal(row.basis, 'generated', `${row.set_id}: a recorded rights basis`);
        assert.ok(row.decided_by && row.decided_by.length > 2, `${row.set_id}: the decision names who`);
        assert.ok(row.note && row.note.length > 20, `${row.set_id}: and the note is auditable`);
      });
      /* The released listening sets: unreviewed, provenance per family, audio material, every blueprint item keyed. */
      for (const entry of JSON.parse(read(SOURCE)).sets.filter((row) => LISTENING_BATCH.includes(row.set_id))) {
        const row = (await legAdmin.query(
          `SELECT s.title, s.media_required, s.item_count, c.review_status, c.source_path,
                  r.basis, r.note,
                  (SELECT count(*)::int FROM jsonb_object_keys((SELECT k.answers FROM "${leg}".objective_key k
                     WHERE k.set_id = s.set_id AND k.version = s.version))) AS answers
             FROM "${leg}".objective_set s
             JOIN "${leg}".content_version c USING (content_version_id)
             LEFT JOIN "${leg}".content_rights r USING (content_version_id)
            WHERE s.set_id = $1`, [entry.set_id])).rows[0];
        assert.ok(row, `${entry.set_id} is in the pool`);
        assert.equal(row.review_status, 'unreviewed', `${entry.set_id}: machine speech from a machine-drafted script — unreviewed`);
        assert.equal(row.source_path, `${SOURCE}#${entry.family}[0]`, `${entry.set_id}: provenance names the authored batch source`);
        assert.equal(row.title, entry.title, `${entry.set_id}: the authored title`);
        assert.equal(row.media_required, true, `${entry.set_id}: audio material`);
        assert.equal(row.answers, entry.items.length, `${entry.set_id}: every authored item is keyed`);
        assert.equal(row.item_count, entry.items.length, `${entry.set_id}: and counted`);
        assert.equal(row.basis, 'generated', `${entry.set_id}: a recorded rights basis`);
        assert.ok(row.note && row.note.length > 20, `${entry.set_id}: the note is auditable`);
      }
      const unrecorded = (await legAdmin.query(
        `SELECT count(*)::int AS n FROM "${leg}".content_version c
          LEFT JOIN "${leg}".content_rights r USING (content_version_id)
         WHERE r.content_version_id IS NULL`)).rows[0].n;
      assert.equal(unrecorded, 0, 'EVERY content row in the batch schema carries a basis (content-rights-check leg 1)');
    });

    /* ---------------------------------------------------- the served DTO and the selection rule */
    db = await createFixture();
    const world = await createPostgresWorld({ fixture: db });
    const port = world.store.port;
    /* No manual apply: `createFixture` applies every tracked content migration from `0010-` onward FROM THE
       FILE, so the batch arrives through exactly the artifact a real installation applies. The assertion
       below is what proves the fixture picked it up. */
    const signup = await world.sessions.signUp({ name: 'Pool 01', email: `pool-01-${Date.now()}@example.invalid`, password: 'synthetic-pool-01-password' });
    const cookie = String(signup.setCookie).split(';')[0];
    const owner = (await world.sessions.getSession({ cookie })).userId;
    const created = await port.createPreparation(owner, EXAM);
    const preparationId = (created.preparation ?? created).id;
    const asOwner = async (run) => {
      const client = await db.learner.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('hatoove.owner_id', $1, true)", [owner]);
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    };
    const keysFor = async (setId, version) => {
      const row = (await db.admin.query('SELECT answers FROM objective_key WHERE set_id = $1 AND version = $2', [setId, version])).rows[0];
      assert.ok(row, `no key for ${setId}@${version}`);
      return row.answers;
    };
    const newSetIds = (await db.admin.query(
      `SELECT set_id FROM objective_set WHERE set_id >= 'telc-deutsch-b1.lv1.04' AND family = 'LV1' ORDER BY set_id`)).rows.map((row) => row.set_id);
    assert.deepEqual(newSetIds, ['telc-deutsch-b1.lv1.04', 'telc-deutsch-b1.lv1.05', 'telc-deutsch-b1.lv1.06'], 'the fixture carries the batch');

    await pgLeg('P4 SQL: the shipped serving path serves a NEW set with a well-formed DTO and no leaked key', async () => {
      const served = await port.practiceSetForPart(owner, { preparationId, family: 'LV1' });
      assert.ok(served, 'LV1 serves a set');
      assert.equal(served.family, 'LV1');
      assert.equal(served.set.item_count, 5);
      assert.equal(served.set.media_required, false);
      const keys = await keysFor(served.set.set_id, served.set.version);
      assert.deepEqual(served.set.items.map((item) => item.item_id).sort(), Object.keys(keys).sort(), 'every served item id IS a key id');
      for (const item of served.set.items) {
        const key = keys[item.item_id];
        const offered = item.options.find((option) => option.value === key);
        assert.ok(offered, `${served.set.set_id}/${item.item_id}: the key is offered`);
        assert.equal(typeof offered.value, typeof key, `${served.set.set_id}/${item.item_id}: offered with the key's own JSON type`);
      }
      const wire = JSON.stringify(served);
      for (const secret of ['"answers"', '"explanations"', '"transcript"', '"why"', '"script"']) {
        assert.ok(!wire.includes(secret), `the served DTO carries no ${secret}`);
      }
      assert.ok(!wire.includes('"answer"'), 'and no per-item answer field');
    });

    await pgLeg('P5 SQL: the selection rule reaches the new sets (most wrong first), and unseen sets stay ordered', async () => {
      const sets = (await db.admin.query(
        `SELECT set_id, version FROM objective_set WHERE family = 'LV1' ORDER BY set_id`)).rows;
      assert.equal(sets.length, 6, 'six LV1 candidates');
      /* Every candidate must be SEEN for the tier-2 rule to decide: an unseen set legitimately outranks a
         seen-but-wrong one, so "most wrong" is only testable once nothing is unseen. */
      const crafted = 'telc-deutsch-b1.lv1.06';
      await db.admin.query('DELETE FROM item_evidence WHERE owner_id = $1', [owner]);
      await asOwner(async (client) => {
        for (const row of sets) {
          const wrong = row.set_id === crafted ? 3 : 1;
          for (let index = 0; index < wrong; index += 1) {
            await client.query(
              `INSERT INTO item_evidence
                 (evidence_id, owner_id, exam_id, set_id, version, item_id, family, section, answer, correct,
                  latency_ms, preparation_id, answered_at)
               VALUES ($1, $2, $3, $4, $5, $6, 'LV1', 'LV', $7::jsonb, $8, NULL, $9, now())`,
              [randomUUID(), owner, EXAM, row.set_id, row.version, `crafted-${index}`, JSON.stringify('a'),
                row.set_id === 'telc-deutsch-b1.lv1.01' && index === 0, preparationId]);
          }
        }
      });
      const served = await port.practiceSetForPart(owner, { preparationId, family: 'LV1' });
      assert.equal(served.set.set_id, crafted, `the new set with the most wrong items is served: ${JSON.stringify({ got: served.set.set_id, reason: served.reason, evidence: served.evidence })}`);
      assert.equal(served.reason, 'most-wrong');
      assert.equal(served.evidence.wrong, 3);
    });

    await pgLeg('P6 SQL: the wrap fires at the NEW per-part count, not at a hard-coded three', async () => {
      await db.admin.query('DELETE FROM item_evidence WHERE owner_id = $1', [owner]);
      await db.admin.query('DELETE FROM practice_attempt WHERE owner_id = $1', [owner]);
      const sets = (await db.admin.query(
        `SELECT set_id, version, section, item_count FROM objective_set WHERE family = 'LV1' ORDER BY set_id`)).rows;
      assert.equal(sets.length, 6, 'six LV1 sets');
      for (const [index, row] of sets.entries()) {
        if (index >= 5) break;
        await db.admin.query(
          `INSERT INTO practice_attempt
             (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count, state, answered_count, correct_count, checked_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'LV1', $7, $8, 'checked', $8, $8, now())`,
          [randomUUID(), owner, EXAM, preparationId, row.set_id, row.version, row.section, row.item_count]);
      }
      const five = await port.practiceSetForPart(owner, { preparationId, family: 'LV1' });
      assert.equal(five.round.setCount, 6, `the part reports its real set count: ${JSON.stringify(five.round)}`);
      assert.equal(five.round.checkedSets, 5, `five checked: ${JSON.stringify(five.round)}`);
      assert.equal(five.round.wrapped, false, 'five of six is not the wrap');
      assert.equal(five.round.round, 6, 'the sixth round begins');
      const sixth = sets[5];
      await db.admin.query(
        `INSERT INTO practice_attempt
           (attempt_id, owner_id, exam_id, preparation_id, set_id, version, family, section, item_count, state, answered_count, correct_count, checked_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'LV1', $7, $8, 'checked', $8, $8, now())`,
        [randomUUID(), owner, EXAM, preparationId, sixth.set_id, sixth.version, sixth.section, sixth.item_count]);
      const wrapped = await port.practiceSetForPart(owner, { preparationId, family: 'LV1' });
      assert.equal(wrapped.round.checkedSets, 6);
      assert.equal(wrapped.round.wrapped, true, 'the SEVENTH tap of a six-set part is the wrap');
      assert.equal(wrapped.round.notice, 'practiceAllSets');
      assert.equal(wrapped.round.round, 6, 'a wrap begins no further round');
    });

    await pgLeg('P7 SQL: the released listening sets are in the pool with playable audio, and only a PLAYABLE one is served', async () => {
      for (const entry of JSON.parse(read(SOURCE)).sets.filter((row) => LISTENING_BATCH.includes(row.set_id))) {
        const rows = (await db.admin.query(
          `SELECT s.set_id, s.version, s.media_required, s.item_count,
                  (SELECT count(*)::int FROM exam_media m
                     WHERE m.exam_id = s.exam_id
                       AND m.media_id = s.payload->'recordings'->0->>'mediaId'
                       AND m.version = s.payload->'recordings'->0->>'mediaVersion') AS media_rows
             FROM objective_set s WHERE s.set_id = $1`, [entry.set_id])).rows;
        assert.equal(rows.length, 1, `${entry.set_id} is in the served pool`);
        assert.equal(rows[0].media_required, true, `${entry.set_id}: audio material`);
        /* The binding RESOLVES: the media row the trigger and the playback port look up exists in the same exam. */
        assert.equal(rows[0].media_rows, 1, `${entry.set_id}: its recording resolves to exactly one exam_media row`);
        assert.equal(rows[0].item_count, entry.items.length, `${entry.set_id}: every authored item was imported`);
      }
      for (const family of ['HV1', 'HV2', 'HV3']) {
        const rows = (await db.admin.query(
          `SELECT set_id, media_required FROM objective_set WHERE family = $1 ORDER BY set_id`, [family])).rows;
        assert.equal(rows.length, 4, `${family} carries its three seeded sets AND the released batch set`);
        assert.deepEqual(rows.map((row) => row.set_id), [`telc-deutsch-b1.${family.toLowerCase()}.01`, `telc-deutsch-b1.${family.toLowerCase()}.02`, `telc-deutsch-b1.${family.toLowerCase()}.03`, `telc-deutsch-b1.${family.toLowerCase()}.04`].sort(),
          `${family}: the seeded three plus .04`);
        assert.ok(rows.every((row) => row.media_required === true), `${family}: every set is audio material`);
        /*
         * FIX-F1 SURVIVES THE RELEASE (A13), narrowed to the truth by POOL-01/task-49. A listening part serves
         * ONLY a set this deployment can actually play: the released `.04` set binds a recording that resolves
         * to an `exam_media` row, so it IS served now; the three SEEDED sets carry no `recordings[]` at all, so
         * they are still refused and a learner never meets live answer controls beside a player that cannot
         * play. This leg asserts both halves BY NAME: releasing a listening set still does not make an
         * unplayable one servable, and it no longer withholds one that is.
         *
         * (The playback path itself — allowance, `begin`, `practice_check_required`, bytes — has its own legs
         * in tools/practice-media-check.mjs; the admission rule itself is proved there (F4, with both halves
         * mutation-proved) and in tools/practice-selection-check.mjs P8f.)
         */
        const served = await port.practiceSetForPart(owner, { preparationId, family });
        assert.ok(served, `${family} serves its released, playable set`);
        assert.equal(served.set.set_id, `telc-deutsch-b1.${family.toLowerCase()}.04`,
          `${family}: the only servable set is the one whose recording resolves`);
        assert.ok(Array.isArray(served.set.material.recordings) && served.set.material.recordings.length,
          `${family}: and the served DTO carries the binding the practice player resolves`);
      }
      const released = (await db.admin.query(
        `SELECT count(*)::int AS n FROM objective_set WHERE set_id LIKE 'telc-deutsch-b1.hv%.04'`)).rows[0].n;
      assert.equal(released, 3, 'all three released listening sets are in the pool');
    });
  } finally {
    if (db && typeof db.cleanup === 'function') {
      try { await db.cleanup(); } catch (error) { console.log(`postgres: cleanup reported ${firstLine(error)}`); }
    }
    await resetLeg().catch(() => {});
    await legAdmin.end().catch(() => {});
    restorePolicy();
  }
  return outcome;
}

/* ----------------------------------------------------------------------- mutations */

const SOURCE_MUTATIONS = [
  /* Task-48's replacement for the old M1 ("a held set is marked released"). The release is now the audio: the
     defect that matters is a listening set that claims to be released while nothing names its recording, and
     that is what the source mutation removes. */
  ['M1 a released listening set loses its recordings[] binding', stripListeningAudio],
  ['M1b a released listening set is marked held again with its audio already built', (text) => text.replace(
    '"set_id": "telc-deutsch-b1.hv2.04",\n      "family": "HV2",\n      "release": "released",',
    '"set_id": "telc-deutsch-b1.hv2.04",\n      "family": "HV2",\n      "release": "held",')],
  ['M2 an LV1 answer is not one of the set\'s headlines', (text) => text.replace('"text": "Unser Reparaturcafé öffnet wieder am Samstag von zehn bis vierzehn Uhr. Wir suchen noch Freiwillige, die sich mit Elektrik oder Nähmaschinen auskennen und ihr eigenes Werkzeug mitbringen können.",\n          "answer": "b"', '"text": "Unser Reparaturcafé öffnet wieder am Samstag von zehn bis vierzehn Uhr. Wir suchen noch Freiwillige, die sich mit Elektrik oder Nähmaschinen auskennen und ihr eigenes Werkzeug mitbringen können.",\n          "answer": "z"')],
  ['M3 a released set is dropped from the batch', (text) => text.replace('"set_id": "telc-deutsch-b1.lv1.06",', '"set_id": "telc-deutsch-b1.lv1.07",')],
  /* The shape trap the correction must not walk into: text 4's key is made to duplicate text 1's. A key that
     duplicates another text's answer is worse than the wording defect it fixes. */
  ['M5 the confirmed key duplicates another text\'s answer', (text) => text.replace(
    '"text": "Wir ziehen Ende des Monats in eine andere Wohnung. Wer hat einen Transporter und kann uns am Umzugstag für ein paar Stunden helfen? Die Bezahlung sprechen wir vorher ab.",\n          "answer": "e"',
    '"text": "Wir ziehen Ende des Monats in eine andere Wohnung. Wer hat einen Transporter und kann uns am Umzugstag für ein paar Stunden helfen? Die Bezahlung sprechen wir vorher ab.",\n          "answer": "a"')],
  /* The pin: a CONFIRMED key is silently changed by an agent, long after the product owner decided it. */
  ['M6 the confirmed key is changed after the decision', (text) => text.replace('"confirmed_answer": "e"', '"confirmed_answer": "j"')],
  /* The pin on the wording: headline e is quietly put back to the form the product owner rejected. */
  ['M7 the reworded headline is reverted to the rejected wording', (text) => text.replace(
    '{ "id": "e", "text": "Umzugshilfe: zwei Helfer mit Transporter" }',
    '{ "id": "e", "text": "Umzugshilfe mit Transporter zu vermieten" }')],
];

const BUILDER_MUTATIONS = [
  ['M4 the builder stops stripping the answer fields (SECRET_FIELDS emptied)', (text) => text.replace(
    "const SECRET_FIELDS = new Set(['answer', 'why', 'grammar']);",
    'const SECRET_FIELDS = new Set([]);')],
  /* N5's mutation: the canonicalisation stops asking whether the digest is real, so a hand-edited source
     record would be accepted. Leg 5 must be the leg that fails — that is what makes its assert load-bearing
     rather than decorative. */
  ['M8 the source-record canonicalisation accepts ANY digest', (text) => text.replace(
    'return text.replace(SOURCE_RECORD, (whole, head, hex, tail) => (allowed.has(hex) ? `${head}<source>${tail}` : whole));',
    'return text.replace(SOURCE_RECORD, (whole, head, hex, tail) => `${head}<source>${tail}`);')],
  /* Task-48: the generator stops refusing a released listening set with no audio. The mutation is only
     detectable through a SOURCE that lacks the binding, so it is paired with M1 in the same run — the pair
     proves the refusal is what catches a released set whose audio is missing, not the JSON parse. */
  ['M9 the generator stops requiring a released listening set to carry its audio', (text) => text.replace(
    "    if (MEDIA_FAMILIES.has(family) && !bindings.length) {\n      throw new Error(`${entry.set_id}: a released listening set must carry its recordings[] binding — without it the set stays 'held' (task-48)`);\n    }",
    '    /* M9: the released-listening-set audio requirement removed */')],
];

/*
 * THE AUDIO'S OWN GUARD IS ATTACKED TOO. A descriptor is the only place the recorded sha256, length and
 * duration live, and the migration copies them: if the descriptor can be edited without a leg noticing, the
 * exam_media rows could pin bytes nobody built. Each mutation runs against a COPY passed with `--media`, so
 * the repository's own descriptor is never written to.
 */
const MEDIA_MUTATIONS = [
  ['M10 a built recording\'s sha256 is changed in the descriptors', (text) => {
    const before = JSON.parse(text);
    const row = before.media.find((entry) => entry.mediaId === 'telc-deutsch-b1.hv3.04.audio');
    row.sha256 = `${row.sha256.slice(0, 63)}${row.sha256.endsWith('0') ? '1' : '0'}`;
    return JSON.stringify(before, null, 2) + '\n';
  }],
  ['M11 one built recording disappears from the descriptors', (text) => {
    const before = JSON.parse(text);
    before.media = before.media.filter((entry) => entry.mediaId !== 'telc-deutsch-b1.hv1.04.audio');
    return JSON.stringify(before, null, 2) + '\n';
  }],
  /* The honesty guard: a descriptor that claims a review decision the machine never took. The media contract
     refuses it, and the generator uses that contract's own rule — so this mutation must break a leg. */
  ['M12 a descriptor claims it was reviewed', (text) => text.replace('"reviewStatus": "unreviewed"', '"reviewStatus": "approved"')],
];

/* --------------------------------------------------------------------------- main */

const main = async () => {
  const required = [SOURCE, MIGRATION, FROZEN_MIGRATION, MEDIA, CORPUS_MIGRATION, MANIFEST, BUILDER];
  const missing = required.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));
  if (missing.length) {
    for (const relative of missing) console.log(`FAIL the batch artifact is missing: ${relative}`);
    console.log(`${missing.length} legs, ${missing.length} failed`);
    return 1;
  }
  const runMutations = !process.argv.includes('--no-mutations');
  const { normalisePracticeSet } = await import(pathToFileURL(path.join(ROOT, 'server/practice-sets.mjs')).href);
  const { readMediaBytes } = await import(pathToFileURL(path.join(ROOT, 'server/media-contract.mjs')).href);
  const deps = {
    source: JSON.parse(read(SOURCE)),
    sourceText: read(SOURCE),
    /* `migrationText` is the FROZEN 0047 (the half that must not move); `releaseText` is this slice's 0048. */
    migrationText: read(FROZEN_MIGRATION),
    releaseText: read(MIGRATION),
    media: JSON.parse(read(MEDIA)),
    mediaText: read(MEDIA),
    mediaPath: MEDIA,
    corpusText: read(CORPUS_MIGRATION),
    normalise: normalisePracticeSet,
    readMediaBytes,
    builderPath: BUILDER,
  };
  const legNames = [];
  const failures = [];
  const report = (results) => {
    for (const [result, name] of results) {
      console.log(`${result} ${name}`);
      legNames.push(name);
      if (result === 'FAIL') failures.push(name);
    }
  };

  report(await runLegs('', deps));

  if (process.argv.includes('--postgres')) {
    try {
      report(await postgresLegs());
    } catch (error) {
      console.log(`postgres: legs could not run: ${firstLine(error)}`);
      console.log(String((error && error.stack) || error).split('\n').slice(0, 12).join('\n'));
      report([['FAIL', `postgres legs could not run: ${firstLine(error)}`]]);
    }
  }

  const mutationNote = [];
  if (runMutations) {
    const controlTree = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-01-control-'));
    fs.mkdirSync(path.join(controlTree, path.dirname(SOURCE)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, SOURCE), path.join(controlTree, SOURCE));
    const control = await runLegs('', { ...deps, source: JSON.parse(read(SOURCE)), sourceText: read(SOURCE) });
    const controlFailed = control.filter(([result]) => result === 'FAIL');
    fs.rmSync(controlTree, { recursive: true, force: true });
    /*
     * THE CONTROL IS A NAMED LEG, NOT AN ASSERTION. This was `assert.deepEqual(controlFailed, [], …)`, so any
     * failing leg above threw an uncaught AssertionError right here: CI printed legs 4 and 5 red and then
     * `triggerUncaughtException`, the summary never appeared, and legs 8+ never ran at all. A control that is
     * not pristine now reports a failure the tally can name, and the mutation proofs are SKIPPED rather than
     * evaluated against a broken baseline — they would prove nothing about the mutations there.
     */
    if (controlFailed.length) {
      report([['FAIL', `the pristine batch must pass before a mutation means anything: ${controlFailed[0][1]}`]]);
      mutationNote.push(`mutation proofs SKIPPED: the pristine control already fails (${controlFailed.length} leg(s))`);
    } else {
      /*
       * A mutation proof that cannot even be evaluated must not kill the run either: the same lesson as the
       * control above, applied one level down.
       */
      try {
        for (const [label, mutate] of SOURCE_MUTATIONS) {
          const text = read(SOURCE).replaceAll('\r\n', '\n');
          const mutated = mutate(text);
          assert.notEqual(mutated, text, `${label}: the mutation must change the source`);
          const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-01-mut-'));
          fs.writeFileSync(path.join(tree, 'source.json'), mutated);
          const broken = (await runLegs('', { ...deps, source: JSON.parse(mutated), sourceText: mutated }))
            .filter(([result]) => result === 'FAIL').map(([, name]) => name);
          fs.rmSync(tree, { recursive: true, force: true });
          assert.ok(broken.length > 0, `${label}: no leg failed on the mutated source`);
          mutationNote.push(`${label} -> ${broken.length} leg(s) fail: ${broken[0]}`);
        }
        for (const [label, mutate] of BUILDER_MUTATIONS) {
          const text = read(BUILDER).replaceAll('\r\n', '\n');
          const mutated = mutate(text);
          assert.notEqual(mutated, text, `${label}: the mutation must change the builder`);
          const { tree, builderCopy } = isolatedBuilderTree(mutated);
          const broken = (await runLegs('', { ...deps, builderPath: builderCopy }))
            .filter(([result]) => result === 'FAIL').map(([, name]) => name);
          fs.rmSync(tree, { recursive: true, force: true });
          assert.ok(broken.length > 0, `${label}: no leg failed on the mutated builder`);
          mutationNote.push(`${label} -> ${broken.length} leg(s) fail: ${broken[0]}`);
        }
        /*
         * THE AUDIO DESCRIPTORS, ON THEIR OWN AXIS. They carry the sha256, the byte length and the duration
         * that the migration copies into `exam_media`, so a descriptor that can be edited without a leg
         * noticing would let the pinned media row stop describing the file it names. Each mutation is written
         * to a throwaway copy and passed with `--media`; the repository's descriptor is never touched.
         */
        for (const [label, mutate] of MEDIA_MUTATIONS) {
          const text = read(MEDIA).replaceAll('\r\n', '\n');
          const mutated = mutate(text);
          assert.notEqual(mutated, text, `${label}: the mutation must change the descriptors`);
          const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-01-media-'));
          const mediaCopy = path.join(tree, 'pool-listening-media.json');
          fs.writeFileSync(mediaCopy, mutated);
          const broken = (await runLegs('', { ...deps, media: JSON.parse(mutated), mediaText: mutated, mediaPath: mediaCopy }))
            .filter(([result]) => result === 'FAIL').map(([, name]) => name);
          fs.rmSync(tree, { recursive: true, force: true });
          assert.ok(broken.length > 0, `${label}: no leg failed on the mutated descriptors`);
          mutationNote.push(`${label} -> ${broken.length} leg(s) fail: ${broken[0]}`);
        }
      } catch (error) {
        report([['FAIL', `a mutation proof could not be evaluated: ${firstLine(error)}`]]);
        mutationNote.push('remaining mutation proofs SKIPPED after that failure');
      }
    }
  }

  for (const failure of failures) console.log(`FAIL ${failure}`);
  console.log(`${legNames.length} legs, ${failures.length} failed`);
  for (const note of mutationNote) console.log(`MUTATION ${note}`);
  return failures.length ? 1 : 0;
};

process.exitCode = await main();
