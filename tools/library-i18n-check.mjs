#!/usr/bin/env node
/**
 * LIBRARY-I18N-01 (F2) — the library-translation contract, checked.
 *
 * Offline (no database):
 *   1. the bundle's sha256 is the digest pinned in `content/library-translations/README.md`
 *   2. a tampered bundle, an ambiguous pin or a wrong byte count are REFUSED
 *   3. the bundle header and its counts are the delivered artifact (737 strings, 240 nouns, per guide)
 *   4. the frozen German/English source parses out of 0012/0013/0014: 240 nouns and 123 sections
 *   5. every one of the 737 guide strings binds to that source: the path names a real section and a
 *      real field, and the bundle's `en` equals the source's own English field byte for byte
 *   6. the German example sentences are unchanged: the 240 nouns' `de`/`example_de`/`en`/`example_en`
 *      equal the seeded columns, and every German article+noun fragment the translations quote
 *      appears verbatim in the German source
 *   7. MUTATION PROOF: changing one `en`, one quoted German fragment or one German noun sentence in
 *      a COPY of the bundle makes legs 5 and 6 fail
 *
 * PostgreSQL (`--postgres`, disposable database only):
 *   8. the import writes 2211 guide rows + 720 noun rows, every one `machine_unreviewed`, and touches
 *      neither `guide_section`, `guide` nor `noun_entry`
 *   9. a second import inserts nothing and leaves the row fingerprint identical (byte idempotence)
 *  10. the read path: no locale = the exact pre-slice response; `de`/`en`/unimported locale = `null`;
 *      `uk` serves the bundle's strings and nouns with the version they were generated from
 *  11. a rejected row is not served; an approved row is marked per string while the bundle marker stays
 *      conservative; a stale `source_content_version` is not served as current; a closed locale is 422
 *
 * Usage:
 *   node tools/library-i18n-check.mjs
 *   OWNAPI_PG_ALLOW=1 OWNAPI_PG_DATABASE=<disposable> node tools/library-i18n-check.mjs --postgres
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import {
  GERMAN_NOUN_PHRASE, INTERFACE_LOCALES, LibraryTranslationError, TRANSLATION_LOCALES,
  EXPECTED_GUIDE_STRINGS, EXPECTED_NOUNS, EXPECTED_STRINGS_PER_GUIDE,
  alteredGermanFragments, importLibraryTranslations, loadVerifiedBundle, planGuideStrings, planNounRows,
  pinnedBundleDigest, readFrozenSource, readGuideTranslations, translationFingerprint, validateBundleShape,
  verifyBundleBytes,
} from '../server/library-translations.mjs';

const results = [];
async function check(name, run) {
  try { await run(); results.push(true); console.log(`PASS ${name}`); }
  catch (error) { results.push(false); console.log(`FAIL ${name}: ${error.message}`); }
}
const clone = (value) => JSON.parse(JSON.stringify(value));
const codeOf = (code) => (error) => error instanceof LibraryTranslationError && error.code === code;

/* ------------------------------------------------------- the frozen source, from the migrations */

/** Tokenise one generated INSERT row: `('a', 'b', 3, '{"x":1}'::jsonb),`. */
function rowValues(line) {
  const text = line.trim().replace(/^\(/, '').replace(/\)\s*,?\s*$/, '');
  const values = [];
  let index = 0;
  while (index < text.length) {
    while (index < text.length && (text[index] === ' ' || text[index] === ',')) index += 1;
    if (index >= text.length) break;
    if (text[index] === "'") {
      let value = '';
      index += 1;
      while (index < text.length) {
        if (text[index] !== "'") { value += text[index]; index += 1; continue; }
        if (text[index + 1] === "'") { value += "'"; index += 2; continue; }
        index += 1;
        break;
      }
      values.push(value);
    } else {
      const start = index;
      while (index < text.length && text[index] !== ',') index += 1;
      values.push(text.slice(start, index).trim());
    }
    while (index < text.length && text[index] !== ',') index += 1; // a cast such as ::jsonb
  }
  return values;
}

/** Every row of the one generated `INSERT INTO "__SCHEMA__".<table>` block in a migration file. */
function insertRows(sql, table) {
  const lines = sql.split('\n');
  const marker = new RegExp(`INSERT INTO "__SCHEMA__"\\.${table}\\b`);
  const start = lines.findIndex((line) => marker.test(line));
  if (start < 0) return [];
  let index = start + 1;
  for (; index < lines.length; index += 1) {
    if (/^\s*VALUES\s*$/i.test(lines[index])) { index += 1; break; }
  }
  const rows = [];
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (/ON CONFLICT/i.test(line)) break;
    if (!line.trim()) continue;
    if (!line.trim().startsWith('(')) break;
    rows.push(rowValues(line));
  }
  return rows;
}

async function frozenSource() {
  const [nouns, guides13, guides14] = await Promise.all([
    readFile(new URL('../server/migrations/0012-noun-lexicon-catalogue.sql', import.meta.url), 'utf8'),
    readFile(new URL('../server/migrations/0013-guide-library.sql', import.meta.url), 'utf8'),
    readFile(new URL('../server/migrations/0014-writing-speaking-guides.sql', import.meta.url), 'utf8'),
  ]);
  const entries = insertRows(nouns, 'noun_entry').map((value) => ({
    entry_id: value[0], de: value[3], en: value[4], example: value[10], example_en: value[11],
    content_version_id: value[12],
  }));
  const sections = [];
  const versions = new Map();
  for (const sql of [guides13, guides14]) {
    for (const value of insertRows(sql, 'guide')) versions.set(value[0], value[9]);
    for (const value of insertRows(sql, 'guide_section')) {
      sections.push({
        guide_id: value[0], section_id: value[1], title: value[4], title_en: value[5],
        summary: value[6], summary_en: value[7], payload: JSON.parse(value[8]),
      });
    }
  }
  return { entries, sections, versions };
}

/* --------------------------------------------------------------------------------- offline */

const verified = await loadVerifiedBundle();
const { bundle, bytes, digest } = verified;
const source = await frozenSource();
const guidePlan = planGuideStrings(bundle, source.sections, source.versions);
const nounPlan = planNounRows(bundle, source.entries);

let germanFragments = 0;
for (const guide of Object.values(bundle.guides)) {
  for (const members of Object.values(guide)) {
    for (const locale of TRANSLATION_LOCALES) {
      germanFragments += [...members[locale].matchAll(GERMAN_NOUN_PHRASE)].length;
    }
  }
}

await check('bundle sha256 is the digest pinned in content/library-translations/README.md', async () => {
  assert.equal(digest, pinnedBundleDigest(verified.readme));
  assert.equal(bytes.length, 546584);
});

await check('a tampered bundle, a mutated pin or a second pin are refused', async () => {
  const tampered = Buffer.from(bytes.toString('utf8').replace('"uk"', '"ux"'));
  assert.notEqual(tampered.length, 0);
  assert.throws(() => verifyBundleBytes(tampered, verified.readme), codeOf('bundle_digest_mismatch'));
  const repinned = verified.readme.replace(digest, '0'.repeat(64));
  assert.throws(() => verifyBundleBytes(bytes, repinned), codeOf('bundle_digest_mismatch'));
  assert.throws(() => verifyBundleBytes(bytes, `${verified.readme}\nsha256 of something else: ${'1'.repeat(64)}\n`),
    codeOf('bundle_pin_ambiguous'));
  assert.throws(() => verifyBundleBytes(Buffer.from('{}'), verified.readme), codeOf('bundle_digest_mismatch'));
});

await check('bundle header and counts are the delivered artifact', () => {
  const counts = validateBundleShape(bundle);
  assert.equal(counts.guideStrings, EXPECTED_GUIDE_STRINGS);
  assert.equal(counts.nouns, EXPECTED_NOUNS);
  assert.deepEqual(bundle.languages, [...TRANSLATION_LOCALES]);
  assert.deepEqual(INTERFACE_LOCALES, ['de', 'en', 'uk', 'ar', 'tr']);
});

await check('the frozen source parses out of 0012/0013/0014', () => {
  assert.equal(source.entries.length, EXPECTED_NOUNS, 'noun_entry rows');
  assert.equal(source.sections.length, 123, 'guide_section rows');
  assert.equal(source.versions.size, 7, 'guide rows');
  assert.equal(new Set(source.sections.map((row) => row.guide_id)).size, 7, 'guides carrying sections');
});

await check('every one of the 737 guide strings binds to the frozen source', () => {
  assert.equal(guidePlan.rows.length, EXPECTED_GUIDE_STRINGS * TRANSLATION_LOCALES.length);
  assert.equal(guidePlan.boundEnglish, EXPECTED_GUIDE_STRINGS, 'strings whose en equals the source English field');
  assert.equal(new Set(guidePlan.rows.map((row) => row.path)).size, EXPECTED_GUIDE_STRINGS);
  const perGuide = new Map();
  for (const path of Object.keys(bundle.guides).flatMap((guide) => Object.keys(bundle.guides[guide]))) {
    const guide = path.slice(0, path.indexOf('/'));
    perGuide.set(guide, (perGuide.get(guide) ?? 0) + 1);
  }
  assert.deepEqual(Object.fromEntries([...perGuide].sort()), { ...EXPECTED_STRINGS_PER_GUIDE });
});

await check('the German example sentences are unchanged', () => {
  assert.equal(nounPlan.rows.length, EXPECTED_NOUNS * TRANSLATION_LOCALES.length);
  for (const entry of source.entries) {
    const members = bundle.nouns[entry.entry_id];
    assert.equal(members.de, entry.de);
    assert.equal(members.example_de, entry.example);
    assert.equal(members.en, entry.en);
    assert.equal(members.example_en, entry.example_en);
  }
  assert.equal(germanFragments, 534, 'German article+noun fragments quoted inside the translations');
  assert.deepEqual(alteredGermanFragments('... das Fenster ...', 'Das Fenster ist neutrum.'), [],
    'a lowercased sentence-initial article is still verbatim');
  assert.deepEqual(alteredGermanFragments('... das Fenzter ...', 'Das Fenster ist neutrum.'), ['das Fenzter'],
    'a retyped German fragment is detected');
});

await check('mutation proof: an altered en, German fragment or German noun sentence is refused', () => {
  const alteredEnglish = clone(bundle);
  const englishPath = Object.keys(alteredEnglish.guides['cases-guide'])[0];
  alteredEnglish.guides['cases-guide'][englishPath].en += ' changed';
  assert.throws(() => planGuideStrings(alteredEnglish, source.sections, source.versions), codeOf('bundle_source_mismatch'));

  const alteredGerman = clone(bundle);
  const quoted = Object.entries(alteredGerman.guides)
    .flatMap(([guide, strings]) => Object.entries(strings).map(([path, members]) => ({ path, members })))
    .find(({ members }) => TRANSLATION_LOCALES.some((locale) => members[locale].includes('das Rind')));
  assert.ok(quoted, 'the delivered bundle quotes a German noun phrase to mutate');
  for (const locale of TRANSLATION_LOCALES) quoted.members[locale] = quoted.members[locale].replace('das Rind', 'das Rint');
  assert.throws(() => planGuideStrings(alteredGerman, source.sections, source.versions), codeOf('bundle_source_mismatch'));

  const alteredNoun = clone(bundle);
  alteredNoun.nouns['telc-deutsch-b1.noun.der-nachbar'].example_de = 'Ein anderer deutscher Satz.';
  assert.throws(() => planNounRows(alteredNoun, source.entries), codeOf('bundle_noun_mismatch'));

  const missingSection = clone(bundle);
  missingSection.guides['cases-guide']['cases-guide/nonexistent-section.title'] =
    missingSection.guides['cases-guide'][englishPath];
  assert.throws(() => planGuideStrings(missingSection, source.sections, source.versions), codeOf('bundle_source_mismatch'));
});

/* ------------------------------------------------------------------------------ PostgreSQL */

if (process.argv.includes('--postgres')) {
  assert.equal(process.env.OWNAPI_PG_ALLOW, '1', 'confirm an explicitly disposable database with OWNAPI_PG_ALLOW=1');
  for (const key of ['OWNAPI_PG_HOST', 'OWNAPI_PG_PORT', 'OWNAPI_PG_DATABASE', 'OWNAPI_PG_USER']) {
    assert.ok(process.env[key], `${key} is required`);
  }
  assert.ok(!['postgres', 'template0', 'template1'].includes(process.env.OWNAPI_PG_DATABASE));
  assert.notEqual(process.env.OWNAPI_PG_PORT, '55440', 'refuse the learner installation port');

  const { createFixture } = await import('../server/owned-postgres/bootstrap.mjs');
  const { createPostgresWorld } = await import('../server/owned-postgres/fixture.mjs');
  const { createPostgresDatastore } = await import('../server/owned-postgres/adapter.mjs');
  const { createOwnedApi } = await import('../server/owned-api.mjs');

  const previousMode = process.env.B1PREP_CONTENT_MODE;
  const previousReview = process.env.B1PREP_SERVE_REVIEW;
  const previousRights = process.env.B1PREP_SERVE_RIGHTS;
  // The seeded guides are `unreviewed`, so the deployment must explicitly retain the pilot policy.
  process.env.B1PREP_CONTENT_MODE = 'internal-preview';
  delete process.env.B1PREP_SERVE_REVIEW;
  delete process.env.B1PREP_SERVE_RIGHTS;

  let db = null;
  try {
    db = await createFixture();
    console.log(`Synthetic library-translation fixture: ${db.schema}`);
    const world = await createPostgresWorld({ fixture: db });
    const signup = await world.sessions.signUp({
      name: 'Synthetic library i18n', email: `library-i18n-${randomUUID()}@example.invalid`,
      password: 'synthetic-library-i18n-password',
    });
    const cookie = String(signup.setCookie).split(';')[0];
    const call = async (api, url) => {
      const response = await api.handle({ method: 'GET', path: url, headers: { cookie }, originChecked: true });
      return { status: response.status, data: response.body ? JSON.parse(response.body) : null };
    };
    const get = (url) => call(world.api, url);

    // The same port WITHOUT the additive read path: the pre-slice consumer this slice must not disturb.
    const barePort = { ...createPostgresDatastore({ pool: db.learner }) };
    delete barePort.readGuideTranslations;
    const bareApi = createOwnedApi({ datastore: barePort, sessions: world.sessions, settings: world.settings });

    const migration = async (run) => {
      const client = await db.migration.connect();
      try { await client.query('BEGIN'); const value = await run(client); await client.query('COMMIT'); return value; }
      catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
      finally { client.release(); }
    };
    /** A read on the schema-owner pool, outside a transaction: used for fingerprints and reads. */
    const withClient = async (run) => {
      const client = await db.migration.connect();
      try { return await run(client); } finally { client.release(); }
    };
    const fingerprint = () => withClient((client) => translationFingerprint(client));
    const sourceFingerprint = async () => (await db.admin.query(
      `SELECT md5(string_agg(value, '|' ORDER BY value)) AS digest FROM (
         SELECT to_jsonb(s)::text AS value FROM guide_section s
         UNION ALL SELECT to_jsonb(g)::text FROM guide g
         UNION ALL SELECT to_jsonb(n)::text FROM noun_entry n) rows`)).rows[0].digest;
    const counts = async () => (await db.admin.query(
      `SELECT (SELECT count(*) FROM guide_translation) AS guide_rows,
              (SELECT count(*) FROM noun_translation) AS noun_rows,
              (SELECT count(*) FROM guide_translation WHERE review_status <> 'machine_unreviewed') AS guide_reviewed,
              (SELECT count(*) FROM noun_translation WHERE review_status <> 'machine_unreviewed') AS noun_reviewed`)).rows[0];

    await check('postgres: an unimported locale and the source languages answer translations:null', async () => {
      const uk = await get('/api/v1/guides/cases-guide?locale=uk');
      assert.equal(uk.status, 200);
      assert.equal(uk.data.translations, null);
      assert.equal((await get('/api/v1/guides/cases-guide?locale=de')).data.translations, null);
      assert.equal((await get('/api/v1/guides/cases-guide?locale=en')).data.translations, null);
      assert.equal(await migration((client) => readGuideTranslations(client, { guideId: 'cases-guide', locale: 'uk' })), null);
      assert.equal(await migration((client) => readGuideTranslations(client, { guideId: 'no-such-guide', locale: 'uk' })), null);
    });

    await check('postgres: the import writes every row machine_unreviewed and touches no German source', async () => {
      const before = await sourceFingerprint();
      const summary = await migration((client) => importLibraryTranslations(client, { bundle, digest }));
      assert.equal(summary.guideStrings.inserted, EXPECTED_GUIDE_STRINGS * TRANSLATION_LOCALES.length);
      assert.equal(summary.guideStrings.boundEnglish, EXPECTED_GUIDE_STRINGS);
      assert.equal(summary.nouns.inserted, EXPECTED_NOUNS * TRANSLATION_LOCALES.length);
      assert.deepEqual(await counts(), { guide_rows: '2211', noun_rows: '720', guide_reviewed: '0', noun_reviewed: '0' });
      assert.equal(await sourceFingerprint(), before, 'guide, guide_section and noun_entry bytes must not move');
    });

    await check('postgres: a second import inserts nothing and changes no row bytes', async () => {
      const before = await fingerprint();
      const summary = await migration((client) => importLibraryTranslations(client, { bundle, digest }));
      assert.equal(summary.guideStrings.inserted, 0);
      assert.equal(summary.guideStrings.unchanged, EXPECTED_GUIDE_STRINGS * TRANSLATION_LOCALES.length);
      assert.equal(summary.nouns.inserted, 0);
      assert.equal(summary.nouns.unchanged, EXPECTED_NOUNS * TRANSLATION_LOCALES.length);
      const after = await fingerprint();
      assert.equal(after, before, 'every stored byte must be identical after a re-import');
    });

    await check('postgres: a dry run plans the whole import and writes nothing', async () => {
      const before = await fingerprint();
      const summary = await migration((client) => importLibraryTranslations(client, { bundle, digest, dryRun: true }));
      assert.equal(summary.dryRun, true);
      assert.equal(summary.guideStrings.inserted, 0);
      assert.equal(await fingerprint(), before);
    });

    await check('postgres: uk serves the bundle strings and nouns with their generated version', async () => {
      const data = (await get('/api/v1/guides/cases-guide?locale=uk')).data;
      const { translations } = data;
      assert.equal(translations.locale, 'uk');
      assert.equal(translations.guideVersion, 'telc-deutsch-b1.cases-guide@v1');
      assert.equal(translations.status, 'machine_unreviewed');
      assert.equal(Object.keys(translations.strings).length, EXPECTED_STRINGS_PER_GUIDE['cases-guide']);
      assert.equal(Object.keys(translations.nouns).length, EXPECTED_NOUNS);
      for (const [path, text] of Object.entries(translations.strings)) {
        assert.equal(text, bundle.guides['cases-guide'][path].uk, path);
        assert.equal(translations.stringStatus[path], 'machine_unreviewed', path);
      }
      for (const [entryId, member] of Object.entries(translations.nouns)) {
        assert.deepEqual(member, {
          meaning: bundle.nouns[entryId].uk.meaning,
          example: bundle.nouns[entryId].uk.example,
          rule: bundle.nouns[entryId].uk.rule,
        }, entryId);
      }
      // The German side of the same response is untouched by the additive member.
      assert.equal(data.sections.length, 20);
      assert.equal(data.guide_id, 'cases-guide');
    });

    await check('postgres: without a locale the response is exactly the pre-slice shape', async () => {
      const withPort = await get('/api/v1/guides/cases-guide');
      const withoutPort = await call(bareApi, '/api/v1/guides/cases-guide');
      assert.equal(withPort.status, 200);
      assert.ok(!('translations' in withPort.data), 'no locale means no translations member');
      assert.equal(JSON.stringify(withPort.data), JSON.stringify(withoutPort.data),
        'a consumer that does not ask for a locale must see byte-identical JSON');
    });

    await check('postgres: the locale set is closed', async () => {
      assert.equal((await get('/api/v1/guides/cases-guide?locale=xx')).status, 422);
      assert.equal((await get('/api/v1/guides/cases-guide?locale=fr')).status, 422);
      assert.equal((await get('/api/v1/guides/cases-guide?locale=')).status, 422);
    });

    await check('postgres: a rejected row is not served, and rejection alone does not mark the bundle reviewed', async () => {
      const rejected = 'grammar-guide/telc-deutsch-b1.grammar-guide.passiv.title';
      await migration((client) => client.query(
        `UPDATE guide_translation SET review_status = 'rejected', reviewer = 'synthetic.check',
           reviewed_at = now() WHERE path = $1 AND locale = 'uk'`, [rejected]));
      const { translations } = (await get('/api/v1/guides/grammar-guide?locale=uk')).data;
      assert.ok(!(rejected in translations.strings), 'a rejected string is omitted');
      assert.equal(translations.stringStatus[rejected], undefined);
      assert.equal(Object.keys(translations.strings).length, EXPECTED_STRINGS_PER_GUIDE['grammar-guide'] - 1);
      assert.equal(translations.status, 'machine_unreviewed');

      // Every row of grammar-guide/uk rejected: nothing is served for it, so the member is null.
      await migration((client) => client.query(
        `UPDATE guide_translation SET review_status = 'rejected', reviewer = 'synthetic.check', reviewed_at = now()
          WHERE guide_id = 'grammar-guide' AND locale = 'uk' AND review_status <> 'rejected'`));
      assert.equal((await get('/api/v1/guides/grammar-guide?locale=uk')).data.translations, null);
      // …and the other guides in the same locale are unaffected.
      assert.ok((await get('/api/v1/guides/cases-guide?locale=uk')).data.translations);
    });

    await check('postgres: an approved row is marked per string while the bundle marker stays conservative', async () => {
      const target = (await db.admin.query(
        'SELECT path FROM guide_translation WHERE guide_id = $1 AND locale = $2 ORDER BY path LIMIT 1',
        ['core-grammar', 'ar'])).rows[0].path;
      assert.ok(target, 'the fixture must hold core-grammar translations');
      await migration((client) => client.query(
        `UPDATE guide_translation SET review_status = 'approved', reviewer = 'synthetic.check',
           reviewed_at = now() WHERE path = $1 AND locale = 'ar'`, [target]));
      let { translations } = (await get('/api/v1/guides/core-grammar?locale=ar')).data;
      assert.equal(translations.stringStatus[target], 'approved');
      assert.equal(translations.status, 'machine_unreviewed', 'one unreviewed line keeps the whole marker');

      await migration((client) => client.query(
        `UPDATE guide_translation SET review_status = 'approved', reviewer = 'synthetic.check', reviewed_at = now()
          WHERE guide_id = 'core-grammar' AND locale = 'ar' AND review_status <> 'approved'`));
      await migration((client) => client.query(
        `UPDATE noun_translation SET review_status = 'approved', reviewer = 'synthetic.check', reviewed_at = now()
          WHERE locale = 'ar' AND review_status <> 'approved'`));
      translations = (await get('/api/v1/guides/core-grammar?locale=ar')).data.translations;
      assert.equal(translations.status, 'approved', 'every served ar row is approved, so the marker can go');
      assert.equal(Object.values(translations.stringStatus).every((status) => status === 'approved'), true);
    });

    await check('postgres: a stale source_content_version is not served as current', async () => {
      await migration((client) => client.query(
        `UPDATE guide_translation SET source_content_version = 'telc-deutsch-b1.grammar-guide@v1'
          WHERE guide_id = 'gender-rules' AND locale = 'tr'`));
      assert.equal((await get('/api/v1/guides/gender-rules?locale=tr')).data.translations, null,
        'a bundle generated from a superseded guide version is not current');
      // The same rows under a locale whose rows are current are still served.
      assert.ok((await get('/api/v1/guides/cases-guide?locale=uk')).data.translations);
      // And the version they carry is the guide's current one, not the stale one.
      const fresh = (await get('/api/v1/guides/cases-guide?locale=uk')).data.translations;
      assert.equal(fresh.guideVersion, 'telc-deutsch-b1.cases-guide@v1');
    });

    await check('postgres: the German noun sentences in the database are the ones the bundle carries', async () => {
      const rows = (await db.admin.query('SELECT entry_id, de, example FROM noun_entry ORDER BY ordinal')).rows;
      assert.equal(rows.length, EXPECTED_NOUNS);
      for (const row of rows) {
        assert.equal(row.de, bundle.nouns[row.entry_id].de, row.entry_id);
        assert.equal(row.example, bundle.nouns[row.entry_id].example_de, row.entry_id);
      }
    });
  } finally {
    if (db) await db.cleanup();
    if (previousMode === undefined) delete process.env.B1PREP_CONTENT_MODE; else process.env.B1PREP_CONTENT_MODE = previousMode;
    if (previousReview === undefined) delete process.env.B1PREP_SERVE_REVIEW; else process.env.B1PREP_SERVE_REVIEW = previousReview;
    if (previousRights === undefined) delete process.env.B1PREP_SERVE_RIGHTS; else process.env.B1PREP_SERVE_RIGHTS = previousRights;
  }
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exitCode = passed === results.length ? 0 : 1;
