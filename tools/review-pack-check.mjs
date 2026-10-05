#!/usr/bin/env node
/**
 * REVIEW-PACK-01 — completeness checked, not claimed.
 *
 * What this check refuses to take on trust:
 *   1. that the pack covers every string, in BOTH directions: a string missing from the pack fails,
 *      and a row no source can account for fails too;
 *   2. that every row has a real source: a `source_de`, a `source_file`, a `source_locator`, and for
 *      a guide row the German re-derived here from the frozen source rather than read from the
 *      pack's own claim;
 *   3. that nothing is approved without a recorded reviewer: `approved` needs a reviewer name AND a
 *      ledger entry that was decided against the same text;
 *   4. that building the pack changes no source byte, and that two builds are byte-identical;
 *   5. MUTATIONS: six deliberate corruptions of a pack copy must each fail, by name — a deleted row,
 *      a row whose source was blanked, an approval with no reviewer, an approval with a reviewer but
 *      no ledger entry, an invented row, and a stale approval.
 *
 * The four packs together cover every (string, locale) pair. English is NOT one of them: Ron named
 * uk, ar and tr for native review plus de for the interface copy, and an `en-rows.csv` in the pack
 * directory is treated as a failure rather than silently accepted.
 *
 * USAGE
 *   node tools/review-pack-check.mjs                       # build into %TEMP% and check that build
 *   node tools/review-pack-check.mjs --pack-dir <dir>      # check the packs that were delivered
 *   node tools/review-pack-check.mjs --no-build --pack-dir <dir>
 *   node tools/review-pack-check.mjs --keep                # keep the scratch build for inspection
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CATALOGUES, FALLBACK_MAPS, LOCALES, NOSCRIPT_FILES, PACK_LANGUAGES, ROOT,
  build, census, instructionDigestProblems, packCsv, packCsvRows, readFallbackMaps,
  readFrozenSource, readInterfaceCatalogues, readInstructions, readNoscriptMessages, readPendingRecord,
  writePacks,
} from './build-review-pack.mjs';
import {
  EXPECTED_NOUNS, EXPECTED_STRINGS_PER_GUIDE, TRANSLATION_LOCALES,
  loadVerifiedBundle, planGuideStrings, planNounRows, validateBundleShape,
} from '../server/library-translations.mjs';

const results = [];
async function check(name, run) {
  try { await run(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (error) { results.push({ name, pass: false, message: error.message }); console.log(`FAIL ${name}: ${error.message}`); }
}
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const read = (file) => readFileSync(file, 'utf8');

/* ------------------------------------------------------------------ the sources, read here */

/** Files the builder reads. A byte change in any of them must not be caused by building a pack. */
const SOURCE_FILES = Object.freeze([
  ...CATALOGUES.map((entry) => entry.file),
  ...FALLBACK_MAPS.map((entry) => entry.file),
  ...NOSCRIPT_FILES,
  'content/library-translations/hatoove-library-translations-uk-ar-tr.json',
  'content/library-translations/README.md',
  'server/library-translations.mjs',
]);
const sourceFingerprint = () => Object.fromEntries(SOURCE_FILES.map((file) => [file, sha256(readFileSync(path.join(ROOT, file)))]));

/**
 * Every namespace that registers itself, discovered by scanning the catalogue directory rather than
 * by reading the builder's table. A new catalogue therefore breaks this check until it is added to
 * the pack — the drift this pack exists to prevent.
 */
function registeredNamespaces() {
  const directory = path.join(ROOT, 'public/assets/i18n');
  const namespaces = new Set();
  for (const file of readdirSync(directory).filter((name) => name.endsWith('.js'))) {
    const text = read(path.join(directory, file));
    for (const match of text.matchAll(/registerMessages\(\s*['"]([A-Za-z0-9_]+)['"]/g)) namespaces.add(match[1]);
  }
  return namespaces;
}

/**
 * The expected id set for one language, derived from the sources by this check: the catalogue keys,
 * the instruction ids, the bundle paths, the README pending paths and the lexicon slots. Only the
 * fallback maps and the <noscript> sentence come from the builder's own constants, and those are
 * separately asserted complete (3 maps × 5 locales, one sentence per locale agreeing across shells).
 */
async function expectedIds(language) {
  const ids = new Set();
  for (const catalogue of await readInterfaceCatalogues()) {
    for (const key of catalogue.keys) ids.add(`ui/${catalogue.namespace}.${key}`);
  }
  for (const id of Object.keys(await readInstructions())) ids.add(`ui/instructions.${id}`);
  for (const map of readFallbackMaps()) {
    assert.equal(Object.keys(map.values).length, LOCALES.length, `${map.id} must carry every locale`);
    ids.add(`ui/${map.id}`);
  }
  const noscript = readNoscriptMessages();
  assert.ok(noscript.values, 'the <noscript> block must be readable and carry one sentence per locale');
  ids.add('ui/html.noscript');

  const { bundle } = await loadVerifiedBundle();
  for (const strings of Object.values(bundle.guides)) for (const path_ of Object.keys(strings)) ids.add(`lib/guide/${path_}`);
  for (const entry of readPendingRecord().pending) {
    for (const fieldPath of entry.rendered) ids.add(`lib/guide/${entry.guide_id}/${entry.section_id}.${fieldPath}`);
  }
  for (const entryId of Object.keys(bundle.nouns)) {
    if (language === 'de') {
      ids.add(`lib/noun/${entryId}/german-headword`);
      ids.add(`lib/noun/${entryId}/german-example`);
    } else {
      ids.add(`lib/noun/${entryId}/meaning`);
      ids.add(`lib/noun/${entryId}/example`);
      ids.add(`lib/noun/${entryId}/rule`);
    }
  }
  return ids;
}

/* ------------------------------------------------------------------ inspecting a pack directory */

const STATUSES = new Set(['machine_unreviewed', 'pending', 'approved', 'not-applicable']);

function loadLedger(dir, language) {
  const file = path.join(dir, `${language}-ledger.json`);
  return existsSync(file) ? JSON.parse(read(file)) : null;
}

/**
 * Inspect one pack directory against the sources. Returns failures rather than throwing, so the
 * mutation legs can assert exactly which leg bit.
 */
async function inspectPackDir(dir, { languages = PACK_LANGUAGES } = {}) {
  const failures = [];
  const stats = {};
  const data = await census();
  const germanByPath = new Map();
  for (const row of data.guidePlan.rows) if (!germanByPath.has(row.path)) germanByPath.set(row.path, row.german);
  for (const row of data.pendingRows) germanByPath.set(row.path, row.german);

  for (const language of languages) {
    const csvFile = path.join(dir, `${language}-rows.csv`);
    if (!existsSync(csvFile)) { failures.push(`${language}: no ${language}-rows.csv in ${dir}`); continue; }
    const parsed = packCsvRows(read(csvFile));
    if (parsed.malformed.length) failures.push(`${language}: ${parsed.malformed.length} row(s) do not match the header`);
    const rows = parsed.rows;
    const issues = (code, detail) => failures.push(`${language}: [${code}] ${detail}`);

    const ledger = loadLedger(dir, language);
    const ledgerById = new Map((ledger?.entries ?? []).map((entry) => [entry.id, entry]));
    if (ledger) {
      for (const entry of ledger.entries ?? []) {
        if (!entry.decided_by || !String(entry.decided_by).trim()) issues('ledger_entry_without_reviewer', `ledger entry ${entry.id} has no decided_by`);
        if (!String(entry.text_at_review ?? '').length) issues('ledger_entry_without_text', `ledger entry ${entry.id} records no text_at_review`);
      }
    }

    const expected = await expectedIds(language);
    const packIds = new Set(rows.map((row) => row.id));
    for (const id of expected) if (!packIds.has(id)) issues('missing_from_pack', `${id} is in the sources but not in the pack`);
    for (const id of packIds) if (!expected.has(id)) issues('no_source_accounts_for_row', `${id} is in the pack but no source accounts for it`);

    for (const row of rows) {
      if (!String(row.source_file ?? '').trim()) issues('row_without_source_file', `${row.id} has no source_file`);
      if (!String(row.source_locator ?? '').trim()) issues('row_without_locator', `${row.id} has no source_locator`);
      const hasGerman = String(row.source_de ?? '').trim().length > 0;
      if (!hasGerman && row.source_kind !== 'translator-label') issues('row_without_source', `${row.id} has no source_de (source_kind=${row.source_kind})`);
      if (!hasGerman && !String(row.source_note ?? '').trim()) issues('row_without_source_note', `${row.id} declares no source and explains nothing`);
      if (hasGerman && row.source_kind === 'frozen-german' && row.id.startsWith('lib/guide/')) {
        if (germanByPath.get(row.id.replace(/^lib\/guide\//, '')) !== row.source_de) {
          issues('source_disagrees_with_frozen_german', `${row.id} carries a source_de the frozen source does not carry`);
        }
      }
      if (!STATUSES.has(row.status)) issues('unknown_status', `${row.id} has status ${JSON.stringify(row.status)}`);
      if (row.status === 'not-applicable' && row.needs_translation !== 'no') {
        issues('not_applicable_but_translation_owed', `${row.id} is not-applicable yet needs_translation=${row.needs_translation}`);
      }
      if (row.status === 'approved') {
        if (!String(row.reviewer ?? '').trim()) issues('approval_without_reviewer', `${row.id} is approved with no reviewer on the row`);
        const entry = ledgerById.get(row.id);
        if (!entry) issues('approval_without_ledger_entry', `${row.id} is approved but the ledger has no entry for it`);
        else if (entry.decision !== 'approved') issues('approval_contradicts_ledger', `${row.id} is approved but the ledger says ${entry.decision}`);
        else if (String(entry.text_at_review) !== String(row.current)) issues('stale_approval', `${row.id} was approved against text the pack no longer carries`);
        else if (String(entry.decided_by ?? '').trim() !== String(row.reviewer ?? '').trim()) issues('approval_reviewer_mismatch', `${row.id} names a different reviewer from the ledger`);
      }
      if (String(row.decision ?? '').trim() && !String(row.reviewer ?? '').trim()) {
        issues('decision_without_reviewer', `${row.id} carries a decision but no reviewer`);
      }
    }
    stats[language] = {
      rows: rows.length, expected: expected.size,
      approved: rows.filter((row) => row.status === 'approved').length,
      pending: rows.filter((row) => row.status === 'pending').length,
      decisions: rows.filter((row) => String(row.decision ?? '').trim()).length,
    };
  }

  for (const language of PACK_LANGUAGES) {
    if (!stats[language]) failures.push(`the ${language} pack is missing from ${dir}`);
  }
  for (const locale of LOCALES) {
    if (!PACK_LANGUAGES.includes(locale) && existsSync(path.join(dir, `${locale}-rows.csv`))) {
      failures.push(`the pack directory carries an ${locale} pack: the named reviewers are uk, ar, tr and de`);
    }
  }
  return { failures, stats };
}

function assertFailure(failures, pattern, leg) {
  const matched = failures.filter((failure) => pattern.test(failure));
  assert.ok(matched.length > 0, `${leg}: expected a failure matching ${pattern}, got: ${failures.slice(0, 4).join(' | ') || 'none'}`);
  return matched[0];
}

/* ------------------------------------------------------------------ mutations */

/** Copy the packs, rewrite one language's records through the same reader/writer the applier uses. */
function mutate(dir, name, language, edit) {
  const target = mkdtempSync(path.join(os.tmpdir(), `rp-mutation-${name}-`));
  cpSync(dir, target, { recursive: true });
  const file = path.join(target, `${language}-rows.csv`);
  const { rows } = packCsvRows(read(file));
  const next = edit(rows);
  writeFileSync(file, packCsv(next));
  return target;
}

/** A row that claims approval: the CSV status and reviewer columns, plus an optional ledger. */
function approve(record, { reviewer = '', textAtReview = null, withLedger = true } = {}) {
  record.status = 'approved';
  record.reviewer = reviewer;
  return { record, textAtReview: textAtReview ?? record.current, withLedger };
}

function writeLedger(dir, language, entries) {
  writeFileSync(path.join(dir, `${language}-ledger.json`), `${JSON.stringify({
    format: 'hatoove-review-ledger/v1', language,
    note: 'synthetic ledger written by tools/review-pack-check.mjs to prove the approval legs bite',
    entries,
  }, null, 2)}\n`);
}

/* ------------------------------------------------------------------ cli */

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--pack-dir') options.packDir = argv[++index];
    else if (token === '--no-build') options.noBuild = true;
    else if (token === '--keep') options.keep = true;
    else throw new Error(`unknown argument ${token}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const before = sourceFingerprint();
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'rp-check-'));
  const first = path.join(scratch, 'build-a');
  const second = path.join(scratch, 'build-b');
  console.log(`scratch ${scratch}`);

  console.log('\n--- the sources, read independently of the pack ---');
  await check('the catalogues agree with themselves: same keys in five locales, same placeholders, nothing empty', async () => {
    const catalogues = await readInterfaceCatalogues();
    assert.equal(catalogues.length, CATALOGUES.length);
    let keys = 0;
    for (const catalogue of catalogues) {
      for (const locale of LOCALES) {
        assert.equal(Object.keys(catalogue.table[locale]).sort().join('|'), [...catalogue.keys].sort().join('|'),
          `${catalogue.namespace}.${locale} disagrees about its key set`);
      }
      const placeholders = (text) => (String(text).match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g) ?? []).sort().join(',');
      for (const key of catalogue.keys) {
        assert.ok(catalogue.table.de[key].trim(), `${catalogue.namespace}.de.${key} is empty`);
        for (const locale of LOCALES) {
          assert.equal(placeholders(catalogue.table[locale][key]), placeholders(catalogue.table.de[key]),
            `${catalogue.namespace}.${locale}.${key} uses different placeholders from the German`);
        }
      }
      keys += catalogue.keys.length;
    }
    console.log(`     ${keys} catalogue keys × five locales`);
  });

  await check('every curated instruction digests to the sha256 it declares', async () => {
    assert.deepEqual(instructionDigestProblems(await readInstructions()), []);
  });

  await check('the bundle is the pinned artifact and carries the delivered counts', async () => {
    const { bundle, digest } = await loadVerifiedBundle();
    const shaped = validateBundleShape(bundle);
    assert.equal(shaped.guideStrings, 704);
    assert.equal(shaped.nouns, 240);
    assert.equal(Object.keys(bundle.guides).length, Object.keys(EXPECTED_STRINGS_PER_GUIDE).length);
    assert.match(digest, /^[0-9a-f]{64}$/);
  });

  await check('the frozen German source is the migrated state and the importer binds every bundle string to it', async () => {
    const source = await readFrozenSource();
    assert.equal(source.entries.length, EXPECTED_NOUNS, 'noun_entry rows');
    assert.equal(source.sections.length, 123, 'guide_section rows');
    assert.equal(source.guides.length, 7, 'guide rows');
    assert.deepEqual(source.corrections, ['0043-content-corrections.sql: noun_entry telc-deutsch-b1.noun.das-familiemitglied, noun_entry telc-deutsch-b1.noun.die-moebel, guide_section speaking-guide'],
      'the offline source must carry every correction a later migration makes');
    const sp1 = source.sections.find((section) => section.section_id === 'telc-deutsch-b1.speaking-guide.sp1');
    assert.equal(sp1.title, 'Teil 1 – Sich kennenlernen', 'the corrected German must be the state the pack shows');
    assert.equal(source.entries.find((entry) => entry.entry_id === 'telc-deutsch-b1.noun.das-familiemitglied').de, 'das Familienmitglied');
    const { bundle } = await loadVerifiedBundle();
    const guides = planGuideStrings(bundle, source.sections, source.versions);
    const nouns = planNounRows(bundle, source.entries);
    assert.equal(guides.boundEnglish, 704);
    assert.equal(nouns.rows.length, EXPECTED_NOUNS * TRANSLATION_LOCALES.length);
  });

  await check('every registered catalogue namespace is represented in the pack', async () => {
    const covered = new Set((await readInterfaceCatalogues()).map((entry) => entry.namespace));
    const missing = [...registeredNamespaces()].filter((namespace) => !covered.has(namespace));
    assert.deepEqual(missing, [], `registered but not packed: ${missing.join(', ')} (add it to CATALOGUES in tools/build-review-pack.mjs)`);
  });

  console.log('\n--- the build ---');
  await check('building writes packs and modifies no source byte', async () => {
    writePacks(await build({ out: first, languages: [...PACK_LANGUAGES] }));
    const after = sourceFingerprint();
    for (const file of SOURCE_FILES) assert.equal(after[file], before[file], `${file} changed while building the pack`);
    assert.ok(existsSync(path.join(first, 'uk-rows.csv')));
    assert.ok(existsSync(path.join(first, 'README.md')));
  });

  await check('two builds are byte-identical', async () => {
    writePacks(await build({ out: second, languages: [...PACK_LANGUAGES] }));
    for (const file of readdirSync(first).sort()) {
      assert.equal(sha256(readFileSync(path.join(second, file))), sha256(readFileSync(path.join(first, file))), `${file} differs between two builds`);
    }
  });

  const target = options.packDir ? path.resolve(options.packDir) : first;
  console.log(`\n--- the packs in ${target} ---`);
  let delivered = null;
  await check('every source string is in the pack, every row has a source, and nothing is approved without a reviewer', async () => {
    delivered = await inspectPackDir(target);
    console.log(`     ${JSON.stringify(delivered.stats)}`);
    assert.deepEqual(delivered.failures, []);
  });

  if (options.packDir) {
    await check('the pack directory is derived output and kept out of git', async () => {
      const relative = path.relative(ROOT, target);
      /* A `--pack-dir` on another drive (a %TEMP% pack, say) cannot be expressed relative to the
         repository: `path.relative` returns an absolute path there, which is "outside", not "not ignored". */
      if (relative.startsWith('..') || path.isAbsolute(relative)) { console.log(`     ${target} is outside the repository: nothing to ignore`); return; }
      const probe = spawnSync('git', ['check-ignore', '-q', relative], { cwd: ROOT });
      if (probe.error) { console.log('     git is unavailable here: not verified'); return; }
      assert.equal(probe.status, 0, `${target} is not gitignored; the packs are derived output and must not be committed`);
    });
  }

  console.log('\n--- mutations: each corruption must fail, by name ---');
  await check('M1 a deleted row fails as missing_from_pack', async () => {
    const mutant = mutate(target, 'm1', 'uk', (rows) => rows.filter((_row, index) => index !== 4));
    const hit = assertFailure((await inspectPackDir(mutant)).failures, /\[missing_from_pack\]/, 'M1');
    console.log(`     ${hit}`);
  });

  await check('M2 a blanked German source fails as row_without_source or source_disagrees_with_frozen_german', async () => {
    const mutant = mutate(target, 'm2', 'uk', (rows) => rows.map((row, index) => (index === 4 ? { ...row, source_de: '' } : row)));
    const hit = assertFailure((await inspectPackDir(mutant)).failures, /\[row_without_source\]|\[source_disagrees_with_frozen_german\]/, 'M2');
    console.log(`     ${hit}`);
  });

  await check('M3 an approval with no reviewer fails as approval_without_reviewer', async () => {
    const mutant = mutate(target, 'm3', 'uk', (rows) => rows.map((row, index) => (index === 4 ? approve(row).record : row)));
    writeLedger(mutant, 'uk', []);
    const hit = assertFailure((await inspectPackDir(mutant)).failures, /\[approval_without_reviewer\]/, 'M3');
    console.log(`     ${hit}`);
  });

  await check('M4 an approval with a reviewer but no ledger entry fails as approval_without_ledger_entry', async () => {
    const mutant = mutate(target, 'm4', 'uk', (rows) => rows.map((row, index) => (index === 4 ? approve(row, { reviewer: 'A Named Human' }).record : row)));
    const hit = assertFailure((await inspectPackDir(mutant)).failures, /\[approval_without_ledger_entry\]/, 'M4');
    console.log(`     ${hit}`);
  });

  await check('M5 an invented row fails as no_source_accounts_for_row', async () => {
    const mutant = mutate(target, 'm5', 'uk', (rows) => {
      const invented = { ...rows[0], id: 'ui/shell.m999' };
      return [...rows.slice(0, 5), invented, ...rows.slice(5)];
    });
    const hit = assertFailure((await inspectPackDir(mutant)).failures, /\[no_source_accounts_for_row\]/, 'M5');
    console.log(`     ${hit}`);
  });

  await check('M6 a stale approval fails as stale_approval', async () => {
    const mutant = mutate(target, 'm6', 'uk', (rows) => rows.map((row, index) => (index === 4 ? approve(row, { reviewer: 'A Named Human' }).record : row)));
    const { rows } = packCsvRows(read(path.join(mutant, 'uk-rows.csv')));
    const row = rows[4];
    writeLedger(mutant, 'uk', [{
      id: row.id, decision: 'approved', decided_by: 'A Named Human', decided_at: '2026-10-06',
      text_at_review: 'text the pack does not carry any more', source_file: row.source_file, source_locator: row.source_locator,
    }]);
    const hit = assertFailure((await inspectPackDir(mutant)).failures, /\[stale_approval\]/, 'M6');
    console.log(`     ${hit}`);
  });

  console.log('\n--- the applier contract ---');
  await check('the decision writer refuses a pack row whose column count moved', async () => {
    const mutant = mutate(target, 'm7', 'uk', (rows) => rows);
    const file = path.join(mutant, 'uk-rows.csv');
    writeFileSync(file, `${read(file)}extra,cell\n`);
    const probe = spawnSync(process.execPath, [
      path.join(ROOT, 'tools/apply-review-decisions.mjs'), '--csv', file, '--reviewer', 'A Named Human',
    ], { encoding: 'utf8' });
    assert.equal(probe.status, 1, 'the applier must refuse a ragged spreadsheet');
    assert.match(`${probe.stderr}`, /do not match the \d+-column header/, probe.stderr);
  });

  await check('the decision writer refuses to approve anything without a named reviewer', async () => {
    const mutant = mutate(target, 'm8', 'uk', (rows) => rows.map((row, index) => (index === 4 ? { ...row, decision: 'ok' } : row)));
    const probe = spawnSync(process.execPath, [
      path.join(ROOT, 'tools/apply-review-decisions.mjs'), '--csv', path.join(mutant, 'uk-rows.csv'),
    ], { encoding: 'utf8' });
    assert.equal(probe.status, 1, 'the applier must refuse without a reviewer');
    assert.match(`${probe.stderr}`, /no reviewer/, probe.stderr);
  });

  /* ------------------------------------------------------------ the applier, attacked (task-49)
   *
   * Every attempt below is a way a script could conceivably produce an approval no human made. The rule
   * for each leg: the applier must exit non-zero, say WHY, and write NOTHING — no ledger, no corrections
   * file. A refusal that still wrote a ledger would be worse than no refusal at all.
   */
  const APPLIER = path.join(ROOT, 'tools/apply-review-decisions.mjs');

  /** A scratch directory holding one corrupted/valid decision file, and the paths nothing must appear at.
   *  Any ledger or corrections file inherited from the source pack is removed: these legs judge what THE
   *  APPLIER wrote, not what the directory arrived with. */
  function applierCase(name, language, edit) {
    const dir = mutate(target, name, language, edit);
    const ledger = path.join(dir, `${language}-ledger.json`);
    const corrections = path.join(dir, `${language}-corrections.csv`);
    for (const file of [ledger, corrections]) if (existsSync(file)) rmSync(file);
    return {
      dir,
      csv: path.join(dir, `${language}-rows.csv`),
      ledger,
      corrections,
      wrote() { return existsSync(ledger) || existsSync(corrections); },
    };
  }
  const runApplier = (args) => spawnSync(process.execPath, [APPLIER, ...args], { encoding: 'utf8' });
  /** Assert: non-zero exit, the message matches, and no ledger and no corrections file appeared. */
  function refuse(name, probe, testCase, pattern) {
    assert.equal(probe.status, 1, `${name}: the applier must refuse (stdout=${probe.stdout} stderr=${probe.stderr})`);
    assert.match(`${probe.stderr}`, pattern, `${name}: the refusal must say why — got ${probe.stderr}`);
    assert.ok(!testCase.wrote(), `${name}: a refused file must write NOTHING (ledger=${existsSync(testCase.ledger)}, corrections=${existsSync(testCase.corrections)})`);
  }
  const decide = (language, index, patch) => (rows) => rows.map((row, position) => (position === index ? { ...row, ...patch } : row));
  const firstDecidedRow = (language, index) => {
    const parsed = packCsvRows(read(path.join(target, `${language}-rows.csv`)));
    return parsed.rows[index];
  };

  console.log('\n--- the applier, attacked: every refusal must write nothing ---');

  await check('A1 a named reviewer plus a real decision IS accepted (the positive control)', async () => {
    const kase = applierCase('a1', 'uk', decide('uk', 4, { decision: 'ok' }));
    const probe = runApplier(['--csv', kase.csv, '--reviewer', 'A Named Human', '--date', '2026-10-05']);
    assert.equal(probe.status, 0, `the applier must accept a complete, named, current decision: ${probe.stderr}`);
    assert.ok(existsSync(kase.ledger), 'the ledger is written');
    const ledger = JSON.parse(read(kase.ledger));
    assert.equal(ledger.entries.length, 1);
    assert.equal(ledger.entries[0].decision, 'approved');
    assert.equal(ledger.entries[0].decided_by, 'A Named Human');
    assert.equal(ledger.entries[0].text_at_review, firstDecidedRow('uk', 4).current, 'the text it was decided against is recorded');
    assert.ok(existsSync(kase.corrections), 'the corrections file is written too');
    console.log(`     accepted 1 decision, ledger has decided_by="${ledger.entries[0].decided_by}" and the exact text`);
  });

  await check('A2 "fix" with no replacement text is refused', async () => {
    const kase = applierCase('a2', 'uk', decide('uk', 4, { decision: 'fix', correction: '' }));
    refuse('A2', runApplier(['--csv', kase.csv, '--reviewer', 'A Named Human']), kase, /"fix" needs the replacement text/);
  });

  await check('A3 a `reject` with no reason is refused, and so is `na` with no reason', async () => {
    const reject = applierCase('a3a', 'uk', decide('uk', 4, { decision: 'reject', note: '' }));
    refuse('A3 reject', runApplier(['--csv', reject.csv, '--reviewer', 'A Named Human']), reject, /"reject" needs a reason/);
    const na = applierCase('a3b', 'uk', decide('uk', 4, { decision: 'na', note: '' }));
    refuse('A3 na', runApplier(['--csv', na.csv, '--reviewer', 'A Named Human']), na, /"na" needs a reason/);
  });

  await check('A4 an unknown id is refused, and so is an id that is in another language\'s pack', async () => {
    const unknown = applierCase('a4a', 'uk', decide('uk', 4, { decision: 'ok', id: 'ui/practice.definitelyNotAKey' }));
    refuse('A4 unknown', runApplier(['--csv', unknown.csv, '--reviewer', 'A Named Human']), unknown, /no such string in the uk pack/);
    /* A REAL key that is not in this language's pack: `lib/noun/<id>/german-headword` exists only in the
       German pack (it is exam-language German, `not-applicable` there). */
    const foreign = applierCase('a4b', 'uk', decide('uk', 4, { decision: 'ok', id: 'lib/noun/telc-deutsch-b1.noun.das-familienmitglied/german-headword' }));
    refuse('A4 foreign id', runApplier(['--csv', foreign.csv, '--reviewer', 'A Named Human']), foreign, /no such string in the uk pack/);
  });

  await check('A5 a ragged CSV is refused: too many cells, too few cells, and a quoted comma is NOT ragged', async () => {
    const tooMany = applierCase('a5a', 'uk', (rows) => rows);
    writeFileSync(tooMany.csv, `${read(tooMany.csv)}extra,cell\n`);
    refuse('A5 too many cells', runApplier(['--csv', tooMany.csv, '--reviewer', 'A Named Human']), tooMany, /do not match the \d+-column header/);

    const tooFew = applierCase('a5b', 'uk', (rows) => rows);
    const lines = read(tooFew.csv).split('\n');
    const cells = lines[5].split(',');
    lines[5] = cells.slice(0, cells.length - 2).join(',');
    writeFileSync(tooFew.csv, lines.join('\n'));
    refuse('A5 too few cells', runApplier(['--csv', tooFew.csv, '--reviewer', 'A Named Human']), tooFew, /do not match the \d+-column header/);

    /* A correction containing a comma is legitimate CSV; it must be parsed, not refused. */
    const quoted = applierCase('a5c', 'uk', decide('uk', 4, { decision: 'fix', correction: 'Erster Teil, zweiter Teil' }));
    const probe = runApplier(['--csv', quoted.csv, '--reviewer', 'A Named Human']);
    assert.equal(probe.status, 0, `a quoted comma must not be treated as corruption: ${probe.stderr}`);
    const corrections = read(quoted.corrections);
    assert.match(corrections, /"Erster Teil, zweiter Teil"/, 'the comma-bearing correction survives the round trip');
  });

  await check('A6 a truncated file is refused, and a JSON that does not parse writes nothing', async () => {
    /* (a) truncated mid-row: the column count no longer matches the header. */
    const midRow = applierCase('a6a', 'uk', (rows) => rows);
    const text = read(midRow.csv);
    writeFileSync(midRow.csv, text.slice(0, text.length - 40));
    refuse('A6 truncated row', runApplier(['--csv', midRow.csv, '--reviewer', 'A Named Human']), midRow, /do not match the \d+-column header/);

    /* (b) truncated at a row boundary: only the rows present are decided — and NO partial entry exists. */
    const boundary = applierCase('a6b', 'uk', decide('uk', 4, { decision: 'ok' }));
    const whole = read(boundary.csv).split('\n');
    writeFileSync(boundary.csv, `${whole.slice(0, whole.length - 3).join('\n')}\n`);
    const probe = runApplier(['--csv', boundary.csv, '--reviewer', 'A Named Human']);
    if (probe.status === 0) {
      const ledger = JSON.parse(read(boundary.ledger));
      assert.deepEqual(ledger.entries.map((entry) => entry.id), [firstDecidedRow('uk', 4).id], 'exactly the decisions present, nothing invented');
      console.log('     a row-boundary truncation applies only the rows present; no partial entry is written');
    } else {
      assert.match(`${probe.stderr}`, /do not match the \d+-column header/, probe.stderr);
    }

    /* (c) a JSON file cut in half is a parse error, not an empty decision list. */
    const jsonDir = mkdtempSync(path.join(os.tmpdir(), 'rp-a6c-'));
    const jsonFile = path.join(jsonDir, 'uk.json');
    writeFileSync(jsonFile, '{"format":"hatoove-review-decisions/v1","language":"uk","reviewer":"A Named Human","decisions":[{"id":"ui/shell.m047","decision":"app');
    const jsonProbe = runApplier(['--json', jsonFile]);
    assert.notEqual(jsonProbe.status, 0, 'a truncated JSON must not be read as "no decisions"');
    assert.ok(!existsSync(path.join(jsonDir, 'uk-ledger.json')), 'and it must write nothing');
  });

  await check('A7 a decision whose text no longer matches the source is REFUSED (the stale-text hole)', async () => {
    /* The reviewer judged text A; the source now carries text B. Writing the decision would record the
       human's approval against B. */
    const kase = applierCase('a7', 'uk', decide('uk', 4, { decision: 'ok', current: 'Text the reviewer read, which the source has since changed' }));
    refuse('A7 stale text', runApplier(['--csv', kase.csv, '--reviewer', 'A Named Human']), kase, /text changed since this pack was generated/);
    /* The same rule in the JSON shape, where the text must be quoted explicitly. */
    const jsonDir = mkdtempSync(path.join(os.tmpdir(), 'rp-a7b-'));
    const row = firstDecidedRow('uk', 4);
    const jsonFile = path.join(jsonDir, 'uk.json');
    writeFileSync(jsonFile, JSON.stringify({
      format: 'hatoove-review-decisions/v1', language: 'uk', reviewer: 'A Named Human', reviewed_at: '2026-10-05',
      decisions: [{ id: row.id, decision: 'approved', text_at_review: 'text the source no longer carries', note: '' }],
    }));
    refuse('A7 stale text (json)', runApplier(['--json', jsonFile]), { wrote: () => existsSync(path.join(jsonDir, 'uk-ledger.json')), ledger: path.join(jsonDir, 'uk-ledger.json'), corrections: '' }, /text changed since this pack was generated/);
  });

  await check('A8 a decision file entry with no quoted text is refused (an approval must say what it approved)', async () => {
    const jsonDir = mkdtempSync(path.join(os.tmpdir(), 'rp-a8-'));
    const row = firstDecidedRow('uk', 4);
    writeFileSync(path.join(jsonDir, 'uk.json'), JSON.stringify({
      format: 'hatoove-review-decisions/v1', language: 'uk', reviewer: 'A Named Human', reviewed_at: '2026-10-05',
      decisions: [{ id: row.id, decision: 'approved', note: '' }],
    }));
    refuse('A8 unquoted', runApplier(['--json', path.join(jsonDir, 'uk.json')]), { wrote: () => existsSync(path.join(jsonDir, 'uk-ledger.json')), ledger: path.join(jsonDir, 'uk-ledger.json'), corrections: '' }, /carries no text_at_review/);
  });

  await check('A9 the applier edits NO catalogue and NO bundle byte, on success or on refusal', async () => {
    const catalogues = [...CATALOGUES.map((entry) => entry.file), 'content/library-translations/hatoove-library-translations-uk-ar-tr.json'];
    const fingerprint = () => Object.fromEntries(catalogues.map((file) => [file, sha256(readFileSync(path.join(ROOT, file)))]));
    const beforeFiles = fingerprint();
    const accepted = applierCase('a9a', 'uk', decide('uk', 4, { decision: 'ok' }));
    assert.equal(runApplier(['--csv', accepted.csv, '--reviewer', 'A Named Human']).status, 0, 'the control applies');
    const refused = applierCase('a9b', 'uk', decide('uk', 4, { decision: 'fix', correction: '' }));
    assert.equal(runApplier(['--csv', refused.csv, '--reviewer', 'A Named Human']).status, 1, 'the refusal refuses');
    const afterFiles = fingerprint();
    for (const [file, digest] of Object.entries(beforeFiles)) assert.equal(afterFiles[file], digest, `${file} was modified by the applier`);
    console.log(`     fingerprinted ${catalogues.length} catalogue/bundle files before and after: unchanged`);
  });

  await check('A10 the ledger is the trust anchor: a hand-written entry DOES approve, and that limit is recorded', async () => {
    /* The honest limit. The applier cannot be made to write an approval without a reviewer, but the pack
       builder trusts the ledger FILE, so anyone who can write a ledger can fabricate an approved row that
       the next build — and this check — cannot tell from a real one. Pinned so nobody mistakes the
       toolchain for a signature. */
    const ledgerDir = mkdtempSync(path.join(os.tmpdir(), 'rp-a10-ledger-'));
    const out = mkdtempSync(path.join(os.tmpdir(), 'rp-a10-out-'));
    const row = firstDecidedRow('uk', 4);
    writeLedger(ledgerDir, 'uk', [{
      id: row.id, decision: 'approved', decided_by: 'A Human Name Written By Hand', decided_at: '2026-10-05',
      text_at_review: row.current, source_file: row.source_file, source_locator: row.source_locator,
    }]);
    /* The ledger travels WITH the pack: the applier writes it into the pack directory, and the next build
       reads it from there. A forged one placed there is indistinguishable to every check below. */
    cpSync(path.join(ledgerDir, 'uk-ledger.json'), path.join(out, 'uk-ledger.json'));
    writePacks(await build({ out, ledgerDir: out, languages: [...PACK_LANGUAGES] }));
    const built = packCsvRows(read(path.join(out, 'uk-rows.csv'))).rows;
    const approved = built.filter((candidate) => candidate.status === 'approved');
    assert.equal(approved.length, 1, 'the hand-written ledger entry reaches the built pack');
    assert.equal(approved[0].reviewer, 'A Human Name Written By Hand', 'with the fabricated name on the row');
    const inspected = await inspectPackDir(out);
    assert.deepEqual(inspected.failures, [], 'and the check cannot tell it from a real approval: the ledger is a file, not a signature');
    console.log('     LIMIT: write access to <language>-ledger.json IS write access to the record; the guard is that no SCRIPT writes one without a named human');
  });

  console.log('\n--- the applier guard is LOAD-BEARING: mutate it and the refusal must disappear ---');
  /** A mutated copy of the applier, beside the trees its import chain reads (catalogues, bundle, frozen
   *  German, shells, tools). Two small copies, never a write into this worktree. */
  function mutateApplier(name, needle, replacement) {
    const dir = mkdtempSync(path.join(os.tmpdir(), `rp-mut-${name}-`));
    cpSync(path.join(ROOT, 'tools'), path.join(dir, 'tools'), { recursive: true });
    cpSync(path.join(ROOT, 'server', 'library-translations.mjs'), path.join(dir, 'server', 'library-translations.mjs'));
    cpSync(path.join(ROOT, 'server', 'migrations'), path.join(dir, 'server', 'migrations'), { recursive: true });
    cpSync(path.join(ROOT, 'public', 'assets', 'i18n'), path.join(dir, 'public', 'assets', 'i18n'), { recursive: true });
    cpSync(path.join(ROOT, 'content', 'library-translations'), path.join(dir, 'content', 'library-translations'), { recursive: true });
    mkdirSync(path.join(dir, 'public'), { recursive: true });
    for (const shell of NOSCRIPT_FILES) cpSync(path.join(ROOT, shell), path.join(dir, shell));
    const file = path.join(dir, 'tools', 'apply-review-decisions.mjs');
    const source = read(file);
    assert.equal(source.split(needle).length - 1, 1, `${name}: the guard must exist exactly once for this proof`);
    writeFileSync(file, source.replace(needle, replacement));
    return file;
  }

  await check('A11 removing the reviewer guard makes the no-reviewer refusal disappear', async () => {
    const mutated = mutateApplier('applier', '  if (!reviewer) problems.push(', '  if (false) problems.push(');
    const kase = applierCase('a11', 'uk', decide('uk', 4, { decision: 'ok' }));
    assert.equal(runApplier(['--csv', kase.csv]).status, 1, 'the shipped applier refuses');
    const mutatedRun = spawnSync(process.execPath, [mutated, '--csv', kase.csv], { encoding: 'utf8' });
    assert.equal(mutatedRun.status, 0, `with the guard removed the applier applies an anonymous approval: ${mutatedRun.stderr}`);
    assert.ok(existsSync(kase.ledger), 'and it writes the ledger');
    const ledger = JSON.parse(read(kase.ledger));
    assert.equal(String(ledger.entries[0].decided_by ?? ''), '', 'the anonymous entry it would never be allowed to write');
    console.log('     guard removed -> the same input exits 0 and writes an approval with no reviewer: the guard is what refuses');
  });

  await check('A12 removing the text guard makes the stale-text refusal disappear', async () => {
    const mutated = mutateApplier('text', '    if (String(entry.quoted) !== String(row.current ?? \'\')) {', '    if (false) {');
    const kase = applierCase('a12', 'uk', decide('uk', 4, { decision: 'ok', current: 'text the reviewer read, the source has moved' }));
    assert.equal(runApplier(['--csv', kase.csv, '--reviewer', 'A Named Human']).status, 1, 'the shipped applier refuses');
    const mutatedRun = spawnSync(process.execPath, [mutated, '--csv', kase.csv, '--reviewer', 'A Named Human'], { encoding: 'utf8' });
    assert.equal(mutatedRun.status, 0, `with the text guard removed the stale approval is written: ${mutatedRun.stderr}`);
    const ledger = JSON.parse(read(kase.ledger));
    assert.equal(ledger.entries[0].text_at_review, firstDecidedRow('uk', 4).current, 'and it re-attributes the decision to text nobody approved');
    console.log('     guard removed -> the stale decision is accepted and recorded against the NEW text: the guard is load-bearing');
  });

  if (!options.keep) rmSync(scratch, { recursive: true, force: true });
  else console.log(`\nkept ${scratch}`);

  const failed = results.filter((result) => !result.pass);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} FAILED` : ''}`);
  if (failed.length) {
    for (const result of failed) console.log(`  FAILED ${result.name}: ${result.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`review-pack-check: ${error.message}`); process.exit(1); });
}
