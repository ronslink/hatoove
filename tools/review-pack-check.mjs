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
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
      if (relative.startsWith('..')) { console.log(`     ${target} is outside the repository: nothing to ignore`); return; }
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
