#!/usr/bin/env node
/**
 * POOL-01 batch 1 (MIRROR-B1PREP-01, task-37) — the authored batch and the migration it generates.
 *
 *   node tools/pool-01-check.mjs                 the offline legs
 *   node tools/pool-01-check.mjs --postgres      adds the database legs (disposable database)
 *   node tools/pool-01-check.mjs --no-mutations  the legs without the mutation proof
 *
 * WHAT THIS GUARDS. Batch 1 authors six sets: three for LV1 (released by
 * `server/migrations/0047-pool-01-batch-1.sql`) and one each for HV1, HV2 and HV3, which are AUTHORED AND
 * HELD — not imported — until the listening media bind-mount is fixed, because a listening set whose audio
 * cannot play must not enter the pool (contract A11(b); POOL-01 lease rule 2). The legs therefore check four
 * different things:
 *
 *   1. the authored source has the EXAM'S SHAPE per family (LV1: 10 headlines a–j for 5 matching items; HV1
 *      5, HV2 10, HV3 5 richtig/falsch items with the blueprint's item numbers) and the approved arithmetic
 *      (25 released sets before, 28 after, 31 once the held three are released);
 *   2. every set — released AND held — normalises through the REAL `normalisePracticeSet` to a served DTO
 *      whose item ids ARE the key ids and whose every key is offered with its own JSON type, with no secret
 *      field anywhere in the learner payload;
 *   3. the generated migration imports the released sets and NOTHING ELSE, marks every set `unreviewed` with
 *      its provenance, carries no answer/explanation/transcript material in the learner payload, and the
 *      committed file is byte-identical to what the builder regenerates;
 *   4. the additive builder change left the frozen `0010` byte-identical (its MANIFEST sha256) and the
 *      database applies `0047` last, serves the new sets through the shipped practice path, reaches them by
 *      the selection rule, and wraps at the new per-part set count.
 *
 * MUTATION PROOF. Seven mutations, each applied to a throwaway copy: a held listening set marked `released`, an
 * LV1 answer that is not one of the set's headlines, a released set dropped from the batch, the builder's
 * secret-field rule emptied, and three checks on Ron's `lv1.06` decisions (a duplicated confirmed key, the
 * confirmed key changed afterwards, the rejected wording restored). The pristine control runs first; when it is
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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SOURCE = 'content/pool-01/batch-1.json';
const MIGRATION = 'server/migrations/0047-pool-01-batch-1.sql';
const CORPUS_MIGRATION = 'server/migrations/0010-objective-catalogue.sql';
const MANIFEST = 'server/migrations/MANIFEST.json';
const BUILDER = 'tools/build-objective-migration.mjs';
const LOCALES = null; // not an interface-copy slice

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
 */
const sourceDigestForms = (absolute) => {
  const raw = fs.readFileSync(absolute);
  const lf = Buffer.from(String(raw).replace(/\r\n/g, '\n'), 'utf8');
  const crlf = Buffer.from(String(lf).replace(/\n/g, '\r\n'), 'utf8');
  return new Set([raw, lf, crlf].map(sha256));
};

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

function buildLegs({ source, sourceText, migration, migrationText, normalise, builderPath, corpusText }) {
  const sets = source.sets ?? [];
  const released = sets.filter((entry) => entry.release === 'released');
  const held = sets.filter((entry) => entry.release === 'held');
  return [
    ['1 the authored batch: six sets, the approved distribution, and the EXAM shape per family', () => {
      assert.equal(sets.length, 6, 'six authored sets');
      const perFamily = {};
      for (const entry of sets) perFamily[entry.family] = (perFamily[entry.family] ?? 0) + 1;
      assert.deepEqual(perFamily, APPROVED_BATCH, 'LV1 +3 and one each to HV1/HV2/HV3 (Lead, 5 Oct 2026)');
      assert.equal(released.length, 3, 'three sets are released by 0047');
      assert.equal(held.length, 3, 'three listening sets are held until the media bind-down fix');
      assert.deepEqual(released.map((entry) => entry.family), ['LV1', 'LV1', 'LV1'], 'only the non-media part is released today');
      assert.deepEqual(held.map((entry) => entry.family).sort(), ['HV1', 'HV2', 'HV3'], 'one held set per listening part');
      const ids = new Set();
      for (const entry of sets) {
        assert.ok(/^telc-deutsch-b1\.[a-z]{2}[0-9]\.[0-9]{2}$/.test(entry.set_id), `set_id shape: ${entry.set_id}`);
        assert.ok(entry.set_id.startsWith(`telc-deutsch-b1.${entry.family.toLowerCase()}.`), `${entry.set_id} matches its family`);
        assert.ok(!ids.has(entry.set_id), `duplicate set id ${entry.set_id}`);
        ids.add(entry.set_id);
        assert.ok(typeof entry.title === 'string' && entry.title.trim().length > 3, `${entry.set_id} has a title`);
        if (entry.family === 'LV1') {
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
          assert.equal(entry.release, 'held', `${entry.set_id}: a listening set may not be released before its audio exists`);
        }
      }
      /* The arithmetic, before/after, per part. */
      const after = { ...RELEASED_BEFORE };
      for (const entry of released) after[entry.family] += 1;
      assert.deepEqual(after, { LV1: 6, LV2: 3, LV3: 3, SB1: 4, SB2: 3, HV1: 3, HV2: 3, HV3: 3 }, 'released sets after batch 1');
      const planned = { ...after };
      for (const entry of held) planned[entry.family] += 1;
      assert.deepEqual(planned, { LV1: 6, LV2: 3, LV3: 3, SB1: 4, SB2: 3, HV1: 4, HV2: 4, HV3: 4 }, 'and once the held three are released');
      assert.equal(Object.values(RELEASED_BEFORE).reduce((a, b) => a + b, 0), 25, '25 released sets before');
      assert.equal(Object.values(after).reduce((a, b) => a + b, 0), 28, '28 released after');
      assert.equal(Object.values(planned).reduce((a, b) => a + b, 0), 31, '31 authored in total');
    }],
    ['2 every authored set — released AND held — serves a well-formed DTO through the REAL normaliser', () => {
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
        /* No secret material anywhere in the learner payload — deep scan, not a field-by-field check. */
        const leaked = deepFindKeys(payload, SECRET_KEYS);
        assert.deepEqual(leaked, [], `${entry.set_id}: no answer/why/script/explanation rides in the learner payload`);
        assert.ok(!JSON.stringify(payload).includes('"answer"'), `${entry.set_id}: and not as a JSON key either`);
      }
    }],
    ['3 the migration imports the RELEASED sets and nothing else, unreviewed, with its provenance', () => {
      for (const entry of released) {
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
      for (const entry of held) {
        assert.ok(!migrationText.includes(`'${entry.set_id}'`), `${entry.set_id} is HELD: it must not be imported before its audio exists`);
        assert.ok(!new RegExp(`'${entry.set_id.replaceAll('.', '\\.')}@v1'`).test(migrationText), `${entry.set_id} has no content_version row either`);
      }
      assert.ok(migrationText.includes('HELD, and deliberately NOT inserted'), 'the held sets are disclosed in the migration itself');
      for (const entry of held) assert.ok(migrationText.includes(entry.set_id), `the disclosure names ${entry.set_id}`);
      /* The ROW shape, not the bare word: the header comment also says "unreviewed". */
      const unreviewed = migrationText.match(/'unreviewed', 'unknown'/g) ?? [];
      assert.equal(unreviewed.length, released.length, 'every imported set is marked unreviewed — an agent does not mark content reviewed');
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
      assert.equal(rightsRows.length, released.length, 'one recorded basis per imported set');
    }],
    ['4 the additive builder change left the corpus untouched: 0010 still matches its source, and the batch is not spliced into it', async () => {
      const generated = await runNode([builderPath, '--check']);
      assert.equal(generated.code, 0, `the corpus migration must still match data/seed.json:\n${generated.out.slice(-300)}`);
      assert.match(generated.out, /24 sets, 24 keys/, 'the seeded corpus is still 24 sets');
      const header = corpusText.match(/Source: data\/seed\.json \(sha256 ([0-9a-f]{64})\)/);
      assert.ok(header, '0010 records the digest of the source it was generated from');
      /*
       * EXACT, BUT PLATFORM-INDEPENDENT. The record is over the source bytes AS CHECKED OUT, and this file has
       * two legitimate byte forms (CRLF on Windows, LF elsewhere), so the assertion is membership in the set of
       * digests THIS checkout's data/seed.json actually has — not equality with one platform's value. The
       * fabrication below is what keeps that from becoming a rubber stamp: a digest one character away from the
       * record must be refused.
       */
      const seedForms = sourceDigestForms(path.join(ROOT, 'data/seed.json'));
      assert.ok(seedForms.has(header[1]),
        `0010's recorded digest must be data/seed.json in one of its byte forms; recorded ${header[1]}, this checkout has ${[...seedForms].join(' / ')}`);
      const fabricated = `${header[1].slice(0, 63)}${header[1].endsWith('0') ? '1' : '0'}`;
      assert.notEqual(fabricated, header[1], 'the fabricated digest is a different value');
      assert.ok(!seedForms.has(fabricated), 'and a digest one character away from the record is NOT accepted');
      /* The batch lives in its OWN source: no batch set id may appear in the corpus source. */
      const seedText = read('data/seed.json');
      for (const entry of sets) assert.ok(!seedText.includes(entry.set_id), `${entry.set_id} is not spliced into data/seed.json`);
      assert.ok(!seedText.includes(sets[0].title), 'nor its passages');
    }],
    ['5 the committed migration is byte-identical to what the builder regenerates (--check)', async () => {
      const result = await runNode([builderPath, '--batch', SOURCE, '--out', MIGRATION, '--check']);
      assert.equal(result.code, 0, `the builder must accept the committed migration:\n${result.out.slice(-400)}`);
      assert.match(result.out, /released sets: 3/, 'and report the released count');
      assert.match(result.out, /held: 3/, 'and the held count');
      // The same platform-independent reading of 0047's own source record as leg 4 applies to 0010's.
      const record = migrationText.match(/Source: content\/pool-01\/batch-1\.json \(sha256 ([0-9a-f]{64})\)/);
      assert.ok(record, '0047 records the digest of the batch source it was generated from');
      const batchForms = sourceDigestForms(path.join(ROOT, SOURCE));
      assert.ok(batchForms.has(record[1]),
        `0047's recorded digest must be ${SOURCE} in one of its byte forms; recorded ${record[1]}, this checkout has ${[...batchForms].join(' / ')}`);
    }],
    ['6 the MANIFEST line is the sha256 of the migration bytes', () => {
      const digest = sha256(read(MIGRATION));
      const recorded = JSON.parse(read(MANIFEST)).migrations['0047-pool-01-batch-1'];
      assert.equal(recorded, digest, 'MANIFEST 0047 equals the reviewed bytes');
      assert.ok(!/\r\n/.test(migrationText), 'LF only: the manifest digest records the bytes');
    }],
    ['7 the held sets are release-ready: their ids are free and their content is complete', () => {
      const corpus = corpusText;
      for (const entry of held) {
        assert.ok(!corpus.includes(`'${entry.set_id}'`), `${entry.set_id} does not collide with the seeded corpus`);
        /* The disclosure comment NAMES the held ids on purpose; the check is that no SQL LITERAL does. */
        assert.ok(!migrationText.includes(`'${entry.set_id}'`), `${entry.set_id} is not inserted by the batch migration`);
        const { answers } = expectedKey(entry);
        assert.equal(Object.keys(answers).length, ITEM_NUMBERS[entry.family].length, `${entry.set_id}: every blueprint item is keyed`);
        assert.ok(Object.values(answers).every((value) => typeof value === 'boolean'), `${entry.set_id}: boolean keys`);
      }
      const ids = new Set(sets.map((entry) => entry.set_id));
      assert.equal(ids.size, sets.length, 'no duplicate ids across released and held');
      assert.ok(!sets.some((entry) => ['LV2', 'LV3', 'SB1', 'SB2'].includes(entry.family)), 'the batch stays inside the four authorised parts');
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
    await pgLeg('P1 SQL: a clean database applies 0047 LAST, with the ledger checksum matching its bytes', async () => {
      assert.equal(migrated.code, 0, `migrate must exit 0:\n${migrated.out.slice(-300)}`);
      const rows = (await legAdmin.query(`SELECT id, checksum FROM "${leg}".hatoove_migrations ORDER BY id`)).rows;
      assert.equal(rows.at(-1).id, '0047-pool-01-batch-1', 'the batch migration is applied last');
      assert.equal(rows.at(-1).checksum, sha256(read(MIGRATION)), 'and its ledger checksum is the sha256 of the frozen file');
      assert.ok(rows.every((row) => row.checksum), 'every migration carries a checksum');
    });

    await pgLeg('P2 SQL: the released pool is 28 sets — LV1 six, every other part unchanged — and the held three are ABSENT', async () => {
      const counts = (await legAdmin.query(
        `SELECT family, count(*)::int AS sets FROM "${leg}".objective_set WHERE exam_id = $1 GROUP BY family ORDER BY family`, [EXAM])).rows;
      const perFamily = Object.fromEntries(counts.map((row) => [row.family, row.sets]));
      assert.deepEqual(perFamily, { LV1: 6, LV2: 3, LV3: 3, SB1: 4, SB2: 3, HV1: 3, HV2: 3, HV3: 3 }, 'the pool after batch 1');
      assert.equal(counts.reduce((total, row) => total + row.sets, 0), 28, '28 released sets');
      const held = (await legAdmin.query(
        `SELECT set_id FROM "${leg}".objective_set WHERE set_id = ANY($1::text[])`,
        [['telc-deutsch-b1.hv1.04', 'telc-deutsch-b1.hv2.04', 'telc-deutsch-b1.hv3.04']])).rows;
      assert.deepEqual(held, [], 'the held listening sets are NOT in the pool (their audio does not exist yet)');
    });

    await pgLeg('P3 SQL: every imported set is unreviewed, carries its provenance, and its key has all five answers', async () => {
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

    await pgLeg('P7 SQL: the held listening sets are not in the pool, and the HV parts keep exactly their seeded three', async () => {
      for (const family of ['HV1', 'HV2', 'HV3']) {
        const rows = (await db.admin.query(
          `SELECT set_id, media_required FROM objective_set WHERE family = $1 ORDER BY set_id`, [family])).rows;
        assert.equal(rows.length, 3, `${family} keeps its three seeded sets — the held batch set is not imported`);
        assert.ok(rows.every((row) => row.media_required === true), `${family}: still media sets`);
        assert.ok(!rows.some((row) => /\.04$/.test(row.set_id)), `${family}: no .04 batch set`);
        /*
         * FIX-F1 (A13): a listening part is not SERVED at all until a practice playback transport exists — the
         * runner answers nothing rather than putting live answer controls beside a player that cannot play. This
         * leg was written before that fix and asserted a served media set; on this branch it asserts the stronger
         * behaviour, because both changes are now on the same tree.
         */
        assert.equal(await port.practiceSetForPart(owner, { preparationId, family }), null,
          `${family} serves nothing while it has no playback path (FIX-F1)`);
      }
      const held = (await db.admin.query(
        `SELECT count(*)::int AS n FROM objective_set WHERE set_id LIKE 'telc-deutsch-b1.hv%.04'`)).rows[0].n;
      assert.equal(held, 0, 'no held HV set is in the pool at all');
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
  ['M1 a HELD listening set is marked released', (text) => text.replace('"set_id": "telc-deutsch-b1.hv1.04",\n      "family": "HV1",\n      "release": "held",', '"set_id": "telc-deutsch-b1.hv1.04",\n      "family": "HV1",\n      "release": "released",')],
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
];

/* --------------------------------------------------------------------------- main */

const main = async () => {
  const required = [SOURCE, MIGRATION, CORPUS_MIGRATION, MANIFEST, BUILDER];
  const missing = required.filter((relative) => !fs.existsSync(path.join(ROOT, relative)));
  if (missing.length) {
    for (const relative of missing) console.log(`FAIL the batch artifact is missing: ${relative}`);
    console.log(`${missing.length} legs, ${missing.length} failed`);
    return 1;
  }
  const runMutations = !process.argv.includes('--no-mutations');
  const { normalisePracticeSet } = await import(pathToFileURL(path.join(ROOT, 'server/practice-sets.mjs')).href);
  const deps = {
    source: JSON.parse(read(SOURCE)),
    sourceText: read(SOURCE),
    migrationText: read(MIGRATION),
    corpusText: read(CORPUS_MIGRATION),
    normalise: normalisePracticeSet,
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
          const tree = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-01-builder-'));
          const builderCopy = path.join(tree, 'builder.mjs');
          fs.writeFileSync(builderCopy, mutated);
          const broken = (await runLegs('', { ...deps, builderPath: builderCopy }))
            .filter(([result]) => result === 'FAIL').map(([, name]) => name);
          fs.rmSync(tree, { recursive: true, force: true });
          assert.ok(broken.length > 0, `${label}: no leg failed on the mutated builder`);
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
