/**
 * CONTENT-CORRECTIONS — the focused check for the three source defects and migration 0043.
 *
 * Offline and dependency-free: no server, no database, no network. It reads the corrected data files, the
 * frozen seeds, migration 0043 and MANIFEST.json, and asserts that:
 *
 *  1. the frozen seeds are untouched — 0012/0014 by pinned digest, and 0013 by pinned digest AND by its
 *     MANIFEST line when it has one (it does not: MANIFEST carries no line for 0012/0013/0014, which is why
 *     the digest pin is the primary anchor here; the applied-checksum rule is the whole reason 0043 exists);
 *  2. the frozen seeds still CONTAIN the defects — this is a correction added on top of them, not a rewrite;
 *  3. data/noun-lexicon.json carries the two noun corrections and the corrected values are internally
 *     consistent (the plural of the corrected lemma, the gloss that matches the plural);
 *  4. data/speaking-guide.json's Teil 1 states the official task and no longer teaches the presentation,
 *     while Teil 2 and Teil 3 are byte-identical to the version this slice started from;
 *  5. migration 0043 corrects exactly what the data says and nothing else: three UPDATEs, two rows of
 *     noun_entry and one guide_section row, no INSERT/DELETE/DROP/ALTER, the payload equal to the builder's
 *     payload mapping, LF-only, and its digest equal to its own MANIFEST line;
 *  6. no defect string survives anywhere under data/.
 *
 * MUTATION PROOF: `--root=<dir>` runs every leg against a copy of the tree, so a mutated lexicon, a mutated
 * speaking guide or a mutated 0043 must fail the corresponding leg. See work/implementation/CONTENT-CORRECTIONS.md.
 *
 * Usage: node tools/content-corrections-check.mjs [--root=<dir>]
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const rootFlag = process.argv.find((value) => value.startsWith('--root='));
const ROOT = rootFlag ? path.resolve(rootFlag.slice('--root='.length)) : fileURLToPath(new URL('../', import.meta.url));
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

/* ---------------------------------------------------------------- the frozen pins */
/*
 * Digests of the three seed migrations as they stand at base commit 3be374a, before this slice. They are the
 * applied artifacts: production holds 0001-0041 with frozen checksums, and nothing in this slice may change
 * 0012/0013/0014. A future slice that needs to change a seed must change this pin deliberately — and should
 * not, because the applied checksum is what makes an old attempt's content mean anything.
 */
const FROZEN_SEEDS = {
  '0012-noun-lexicon-catalogue.sql': 'aeb3fac321571fecca605cbce0a03fc98a10e9c72bbfecf57e0de2ef27c5e746',
  '0013-guide-library.sql': 'fe43ab3e1f2434e337d50be22b8e90198d91d56888f4ebfbef25d5d77f3cead3',
  '0014-writing-speaking-guides.sql': '0cd012f1fb4f6a8aba216b0d688f32e459a62731b389955a3e90fa35d9b974b1',
};
/** The parts this slice must not touch, pinned as they stood before it. */
const FROZEN_SP2 = '3a8119fc321c869dcb3139c9bfe9635918c7b46db23710d2e316ced7a68ac147';
const FROZEN_SP3 = 'd5cf17de1ee6cbd071659d5c571c7b9dd2aa943301341d02f02e5f74569c01b2';

/** The defects exactly as the frozen seeds carry them, and the corrected values they must become. */
const NOUN_FIXES = [
  {
    entryId: 'telc-deutsch-b1.noun.das-familiemitglied',
    seeded: ['das Familiemitglied', 'die Familiemitglieder', 'Jedes Familiemitglied bringt etwas zum Buffet mit.'],
    corrected: ['das Familienmitglied', 'die Familienmitglieder', 'Jedes Familienmitglied bringt etwas zum Buffet mit.'],
    columns: ['de', 'plural', 'example'],
  },
  {
    entryId: 'telc-deutsch-b1.noun.die-moebel',
    seeded: ['piece of furniture', 'Dieses Möbel passt überhaupt nicht in unser Wohnzimmer.'],
    corrected: ['furniture', 'Dieses Möbelstück passt überhaupt nicht in unser Wohnzimmer.'],
    columns: ['en', 'example'],
  },
];
/** Vocabulary that may only describe the OLD Teil 1 in the guide's own copy. */
const PRESENTATION_MARKERS = ['Präsentation', 'Stichwörter', 'Vortrag', 'drei Minuten', 'Anschlussfrage'];

const results = [];
function leg(name, run) {
  try { run(); results.push(true); console.log(`PASS ${name}`); }
  catch (error) { results.push(false); console.log(`FAIL ${name}: ${error.message}`); }
}

/* ---------------------------------------------------------------- load everything */

const seeds = Object.fromEntries(Object.entries(FROZEN_SEEDS).map(([file]) => [file, read(`server/migrations/${file}`)]));
const lexicon = JSON.parse(read('data/noun-lexicon.json'));
const speaking = JSON.parse(read('data/speaking-guide.json'));
const migrationFile = 'server/migrations/0043-content-corrections.sql';
const migration = read(migrationFile);
const manifest = JSON.parse(read('server/migrations/MANIFEST.json')).migrations;
const dataText = Object.fromEntries(['data/noun-lexicon.json', 'data/speaking-guide.json'].map((file) => [file, read(file)]));

/** The payload the migration builder puts in `guide_section.payload` for a speaking part. */
const builderPayload = (part) => ({
  minutes: part.minutes, approach: part.approach, phrases: part.phrases,
  examples: part.examples, watchOut: part.watchOut, watchOutEn: part.watchOutEn,
});

/* ---------------------------------------------------------------- 1-2: the frozen seeds */

leg('1 the three seed migrations are byte-identical to their pre-slice digests', () => {
  for (const [file, digest] of Object.entries(FROZEN_SEEDS)) {
    assert.equal(sha256(seeds[file]), digest, `${file} changed; the applied seeds are frozen and this slice must not rewrite them`);
  }
});

leg('2 the frozen seeds still carry the defects, so 0043 is a correction and not a rewrite', () => {
  for (const fix of NOUN_FIXES) {
    for (const needle of fix.seeded) assert.ok(seeds['0012-noun-lexicon-catalogue.sql'].includes(needle), `0012 no longer carries ${JSON.stringify(needle)}`);
  }
  assert.ok(seeds['0014-writing-speaking-guides.sql'].includes('Teil 1 – Präsentation'), '0014 no longer teaches Teil 1 as a presentation');
  assert.ok(seeds['0014-writing-speaking-guides.sql'].includes('Der Kandidat präsentiert etwa drei Minuten'), '0014 no longer carries the presentation summary');
});

/* ---------------------------------------------------------------- 3: the noun corrections */

leg('3 the lexicon carries the two corrections, and no defect string survives on those entries', () => {
  const byLemma = new Map(lexicon.nouns.map((entry) => [entry.de, entry]));
  const family = byLemma.get('das Familienmitglied');
  assert.ok(family, 'data/noun-lexicon.json has no entry "das Familienmitglied"');
  assert.equal(family.plural, 'die Familienmitglieder');
  assert.match(family.example, /^Jedes Familienmitglied /, 'the example must use the corrected lemma');
  assert.equal(family.en, 'family member');
  const moebel = byLemma.get('die Möbel');
  assert.ok(moebel, 'data/noun-lexicon.json has no entry "die Möbel"');
  assert.equal(moebel.en, 'furniture', 'die Möbel is plural; the gloss must not be the singular "piece of furniture"');
  assert.equal(moebel.plural, 'die Möbel', 'the plural-only noun keeps its plural form');
  assert.equal(moebel.example, 'Dieses Möbelstück passt überhaupt nicht in unser Wohnzimmer.', 'the example must use the singular das Möbelstück');
  assert.equal(moebel.exampleEn, 'This piece of furniture does not fit in our living room at all.', 'the English example keeps its meaning');
  // The misspelling is a typo, so it must survive nowhere in the file at all.
  assert.ok(!dataText['data/noun-lexicon.json'].includes('Familiemitglied'), 'the misspelling "Familiemitglied" survives in data/noun-lexicon.json');
  // The other two seeded strings are ordinary German/English, so they are checked on THEIR entry only:
  // "piece of furniture" is a correct gloss for other furniture nouns elsewhere in the lexicon.
  for (const fix of NOUN_FIXES) {
    const entry = fix.entryId.includes('familiemitglied') ? family : moebel;
    for (const needle of fix.seeded) {
      assert.ok(!Object.values(entry).includes(needle), `entry ${fix.entryId} still carries the seeded value ${JSON.stringify(needle)}`);
    }
    for (const needle of fix.corrected) {
      assert.ok(Object.values(entry).includes(needle), `entry ${fix.entryId} is missing the corrected value ${JSON.stringify(needle)}`);
    }
  }
  assert.equal(lexicon.nouns.length, 240, 'the lexicon must still hold 240 entries');
});

/* ---------------------------------------------------------------- 4: the speaking guide */

leg('4 Teil 1 states the official task and no longer teaches the presentation', () => {
  const sp1 = speaking.parts[0];
  assert.equal(sp1.id, 'SP1');
  assert.equal(sp1.title, 'Teil 1 – Sich kennenlernen');
  assert.match(sp1.summary, /lernen sich kennen/, 'the summary must state the official Teil 1 task');
  assert.match(sp1.summary, /direkte Interaktion/, 'the summary must carry the direct-interaction point');
  // The markers are banned from the material that TEACHES the task. The watch-out is where "this is not a
  // presentation" belongs, so it is checked separately below rather than scanned for the same words.
  const teaching = JSON.stringify({
    title: sp1.title, titleEn: sp1.titleEn, summary: sp1.summary, summaryEn: sp1.summaryEn,
    approach: sp1.approach, phrases: sp1.phrases, examples: sp1.examples,
  });
  for (const marker of PRESENTATION_MARKERS) {
    // A marker may appear only inside a clause that NEGATES it ("halten Sie keinen Vortrag"), never as the
    // task being taught. Splitting on sentence enders keeps that rule reviewable.
    const offending = teaching.split(/(?<=[.!?:])\s+/)
      .filter((sentence) => sentence.includes(marker))
      .filter((sentence) => !/kein|nicht|ohne/i.test(sentence));
    assert.deepEqual(offending, [], `SP1 teaches the presentation marker ${JSON.stringify(marker)}: ${offending.join(' | ').slice(0, 160)}`);
  }
  assert.ok(sp1.approach.length >= 3, 'SP1 needs approach steps for the new task');
  assert.ok(sp1.phrases.some((group) => /selbst|eigene Person/i.test(group.group)), 'SP1 needs Redemittel for talking about yourself');
  assert.ok(sp1.phrases.some((group) => /Fragen an den Partner/i.test(group.group)), 'SP1 needs Redemittel for asking the partner questions');
  assert.ok(sp1.watchOut.some((line) => /keinen Vortrag/.test(line)), 'SP1 must warn that Teil 1 is not a presentation');
});

leg('5 Teil 2 and Teil 3 are unchanged by this slice', () => {
  assert.equal(sha256(JSON.stringify(speaking.parts[1])), FROZEN_SP2, 'SP2 changed; the repository verifies nothing about official Teil 2');
  assert.equal(sha256(JSON.stringify(speaking.parts[2])), FROZEN_SP3, 'SP3 changed; the repository verifies nothing about official Teil 3');
  assert.equal(speaking.parts.length, 3, 'the guide must keep exactly three parts');
});

/* ---------------------------------------------------------------- 6: migration 0043 */

const statements = migration.split('\n').filter((line) => /^(UPDATE|INSERT|DELETE|DROP|ALTER|CREATE)\b/.test(line));
const nounStatements = statements.filter((line) => line.startsWith('UPDATE "__SCHEMA__".noun_entry'));
const sectionStatements = statements.filter((line) => line.startsWith('UPDATE "__SCHEMA__".guide_section'));

leg('6 0043 is exactly three UPDATEs — two noun rows and one section — and nothing else', () => {
  assert.deepEqual(statements, [...nounStatements, ...sectionStatements], '0043 contains a statement that is not an UPDATE');
  assert.equal(nounStatements.length, 2, 'expected two noun_entry UPDATEs');
  assert.equal(sectionStatements.length, 1, 'expected one guide_section UPDATE');
  for (const forbidden of ['DROP ', 'DELETE ', 'ALTER ', 'INSERT INTO', 'TRUNCATE', 'CREATE ']) {
    assert.ok(!migration.includes(forbidden), `0043 must not contain ${forbidden.trim()}`);
  }
  assert.ok(!migration.includes('0013-guide-library'), '0043 must not rewrite 0013');
  assert.ok(!/\r/.test(migration), '0043 must be LF-only (tools/migration-eol-check.mjs and the manifest digest)');
});

leg('7 every value 0043 writes is the value the data files carry', () => {
  const byLemma = new Map(lexicon.nouns.map((entry) => [entry.de, entry]));
  const expectations = [
    ['telc-deutsch-b1.noun.das-familiemitglied', 'das Familienmitglied', ['de', 'plural', 'example']],
    ['telc-deutsch-b1.noun.die-moebel', 'die Möbel', ['en', 'example']],
  ];
  for (const [entryId, lemma, columns] of expectations) {
    const entry = byLemma.get(lemma);
    assert.ok(entry, `data/noun-lexicon.json has no entry ${JSON.stringify(lemma)}`);
    assert.ok(migration.includes(`WHERE entry_id = '${entryId}'`), `0043 has no WHERE clause for ${entryId}`);
    for (const column of columns) {
      assert.ok(migration.includes(`${column} = '${String(entry[column]).replaceAll("'", "''")}'`), `0043 does not set ${entryId}.${column} to the lexicon value`);
    }
  }
  const sp1 = speaking.parts[0];
  for (const [column, value] of [['title', sp1.title], ['title_en', sp1.titleEn], ['summary', sp1.summary], ['summary_en', sp1.summaryEn]]) {
    assert.ok(migration.includes(`${column} = '${String(value).replaceAll("'", "''")}'`), `0043 does not set ${column} to the speaking-guide value`);
  }
  const payloadLiteral = `'${JSON.stringify(builderPayload(sp1)).replaceAll("'", "''")}'::jsonb`;
  assert.ok(migration.includes(payloadLiteral), '0043 payload is not the builder payload mapping of the corrected SP1');
});

leg('8 0043 digest matches its own MANIFEST line, and 0042 is untouched', () => {
  assert.equal(sha256(migration), manifest['0043-content-corrections'], 'the 0043 MANIFEST line does not match the file bytes');
  // MANIFEST carries no line for 0012/0013/0014; the digest pins in leg 1 are the anchor for those, which is
  // why this leg also states that absence explicitly rather than pretending a MANIFEST line exists.
  for (const id of ['0012-noun-lexicon-catalogue', '0013-guide-library', '0014-writing-speaking-guides']) {
    assert.equal(manifest[id], undefined, `${id} unexpectedly has a MANIFEST line; update this leg and the digest pin together`);
  }
  const previous = read('server/migrations/0042-library-translations.sql');
  assert.equal(sha256(previous), manifest['0042-library-translations'], 'the 0042 line no longer matches its file; this slice must not disturb it');
});

const passed = results.filter(Boolean).length;
console.log(`\n${passed} passed, ${results.length - passed} failed (root: ${path.relative(process.cwd(), ROOT) || '.'})`);
process.exitCode = passed === results.length ? 0 : 1;
