/**
 * F2 LIBRARY-I18N-01 — the uk/ar/tr reference-library translations (MIRROR-B1PREP-01 §4.3, §4.4).
 *
 * Three jobs, one file, because they are three views of the same artifact and a second copy of the
 * bundle's shape is exactly how the two would drift apart:
 *
 *   1. VERIFY the offline bundle against its pinned digest and against the frozen German/English
 *      source it was generated from. The bundle ships `{en, uk, ar, tr}` per string; the guide and
 *      noun source lives in the migration-seeded tables byte-for-byte as 0012/0013/0014 wrote it,
 *      so `en` can be checked against the source's own English field for every one of the 737 guide
 *      strings (all 737 have one) and the nouns' `de`/`example_de`/`en`/`example_en` can be checked
 *      against `noun_entry`. A bundle whose source moved is REFUSED rather than imported against
 *      the wrong version.
 *   2. IMPORT into `guide_translation` / `noun_translation` (migration 0042), every row
 *      `machine_unreviewed`. Idempotent: an existing row is compared and left completely alone, so
 *      a second run inserts nothing, changes no bytes, and cannot undo a native review.
 *   3. READ the additive `translations` member of contract §4.3, never serving a rejected row and
 *      never serving a row whose `source_content_version` is not the version current at read time.
 *
 * WHAT THIS MODULE DOES NOT DO. It does not open a connection, does not choose a role, and does not
 * begin a transaction: `tools/import-library-translations.mjs` runs it as the schema-owner
 * (`<prefix>_migration`) role inside one transaction, and the runtime reads it through the
 * restricted learner pool. It never marks anything approved, and it never deletes a row.
 *
 * See work/implementation/LIBRARY-I18N-01.md.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/** The three languages the bundle carries. `de`/`en` are the source, not a translation. */
export const TRANSLATION_LOCALES = Object.freeze(['uk', 'ar', 'tr']);
/** Every interface language the read path accepts. `de` and `en` have no bundle and answer `null`. */
export const INTERFACE_LOCALES = Object.freeze(['de', 'en', 'uk', 'ar', 'tr']);
/** The review states contract §4.4 allows. Nothing in this module writes 'approved'. */
export const REVIEW_STATUS = Object.freeze({
  MACHINE: 'machine_unreviewed', APPROVED: 'approved', REJECTED: 'rejected',
});
/** The marker the client shows while native review is owed (contract §4.3, README rule 4). */
export const MACHINE_REVIEW_MARKER = 'maschinell übersetzt · Prüfung ausstehend';

export const BUNDLE_PATH = new URL('../content/library-translations/hatoove-library-translations-uk-ar-tr.json', import.meta.url);
export const README_PATH = new URL('../content/library-translations/README.md', import.meta.url);

/** The delivered bundle's counts, also stated in the README. A change here is a new bundle. */
export const EXPECTED_GUIDE_STRINGS = 737;
export const EXPECTED_NOUNS = 240;
export const EXPECTED_STRINGS_PER_GUIDE = Object.freeze({
  'cases-guide': 61,
  'gender-rules': 80,
  'grammar-guide': 132,
  'core-grammar': 125,
  'core-phrases': 130,
  'writing-guide': 110,
  'speaking-guide': 99,
});

/** A verification or import failure: a stable lowercase code plus the detail that names the row. */
export class LibraryTranslationError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LibraryTranslationError';
    this.code = code;
    this.detail = detail ?? null;
  }
}

const fail = (code, detail) => { throw new LibraryTranslationError(code, detail); };

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The digest the README pins for the ingested bundle. Exactly one `sha256 … <64 hex>` mention is
 * expected: two mentions would mean the pin is ambiguous, and none would mean it is missing, and
 * both are failures rather than "use whichever was found".
 */
export function pinnedBundleDigest(readmeText) {
  const found = [...String(readmeText).matchAll(/sha256[^\n]*?([0-9a-f]{64})/gi)].map((m) => m[1].toLowerCase());
  const unique = [...new Set(found)];
  if (unique.length !== 1) fail('bundle_pin_ambiguous', `content/library-translations/README.md states ${unique.length} distinct sha256 values`);
  return unique[0];
}

/** The byte count the README states for the bundle, when it states one. */
export function pinnedBundleBytes(readmeText) {
  const found = [...String(readmeText).matchAll(/\(([\d\s\u00a0]{3,})\s*bytes\)/gi)]
    .map((m) => Number(m[1].replace(/[\s\u00a0]/g, '')))
    .filter((value) => Number.isSafeInteger(value));
  return found.length ? found[0] : null;
}

/**
 * Prove a bundle's bytes are the pinned artifact named by a README. Separated from the file read so a
 * check can hand it a tampered copy and assert the refusal, without a second implementation of the rule.
 */
export function verifyBundleBytes(bytes, readmeText) {
  const digest = sha256(bytes);
  const pinned = pinnedBundleDigest(readmeText);
  if (digest !== pinned) fail('bundle_digest_mismatch', `the bundle is ${digest}, the README pins ${pinned}`);
  const expectedBytes = pinnedBundleBytes(readmeText);
  if (expectedBytes !== null && expectedBytes !== bytes.length) {
    fail('bundle_length_mismatch', `the bundle is ${bytes.length} bytes, the README states ${expectedBytes}`);
  }
  let bundle;
  try { bundle = JSON.parse(bytes.toString('utf8')); }
  catch (error) { fail('bundle_not_json', error.message); }
  return { bytes, digest, pinned, pinnedBytes: expectedBytes, bundle };
}

/** Read the tracked bundle and its README, and prove the bytes are the pinned artifact. */
export async function loadVerifiedBundle() {
  const [bytes, readme] = await Promise.all([readFile(BUNDLE_PATH), readFile(README_PATH, 'utf8')]);
  return { readme, ...verifyBundleBytes(bytes, readme) };
}

/* ------------------------------------------------------------------ bundle shape */

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === 'string' && value.length > 0;

/**
 * The bundle header and counts, checked against the README and against this module's own record of
 * the delivered artifact. Every failure is collected so one run reports the whole shape problem.
 */
export function validateBundleShape(bundle) {
  const problems = [];
  if (!isObject(bundle)) fail('bundle_shape', 'the bundle is not a JSON object');
  if (bundle.status !== 'machine-unreviewed') problems.push(`header status is ${JSON.stringify(bundle.status)}, expected "machine-unreviewed"`);
  const languages = Array.isArray(bundle.languages) ? [...bundle.languages] : null;
  if (!languages || languages.join(',') !== TRANSLATION_LOCALES.join(',')) {
    problems.push(`header languages are ${JSON.stringify(bundle.languages)}, expected ${JSON.stringify(TRANSLATION_LOCALES)}`);
  }
  if (!isObject(bundle.guides)) problems.push('bundle.guides is not an object');
  if (!isObject(bundle.nouns)) problems.push('bundle.nouns is not an object');
  if (problems.length) fail('bundle_header_invalid', problems.join('; '));

  let guideStrings = 0;
  for (const [guideId, strings] of Object.entries(bundle.guides)) {
    if (!isObject(strings) || !Object.keys(strings).length) { problems.push(`guide ${guideId} carries no strings`); continue; }
    const expected = EXPECTED_STRINGS_PER_GUIDE[guideId];
    if (expected === undefined) problems.push(`guide ${guideId} is not one of the seven delivered guides`);
    else if (Object.keys(strings).length !== expected) problems.push(`guide ${guideId} has ${Object.keys(strings).length} strings, expected ${expected}`);
    guideStrings += Object.keys(strings).length;
  }
  for (const guideId of Object.keys(EXPECTED_STRINGS_PER_GUIDE)) {
    if (!isObject(bundle.guides[guideId])) problems.push(`guide ${guideId} is missing from the bundle`);
  }
  if (guideStrings !== EXPECTED_GUIDE_STRINGS) problems.push(`the bundle carries ${guideStrings} guide strings, expected ${EXPECTED_GUIDE_STRINGS}`);
  const nounCount = Object.keys(bundle.nouns).length;
  if (nounCount !== EXPECTED_NOUNS) problems.push(`the bundle carries ${nounCount} nouns, expected ${EXPECTED_NOUNS}`);
  if (problems.length) fail('bundle_counts_invalid', problems.join('; '));
  return { guideStrings, nouns: nounCount };
}

/* ------------------------------------------------------------------ field paths */

const fieldParts = (fieldPath) => fieldPath.replace(/\[(\d+)\]/g, '.$1').split('.');

function readField(section, fieldPath) {
  let cursor = section;
  for (const part of fieldParts(fieldPath)) {
    // Arrays are objects here on purpose: a part may be a numeric index (`payload.headers[1]`).
    if (cursor === null || typeof cursor !== 'object' || !Object.hasOwn(cursor, part)) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

/**
 * The source's own English field for a German field path, e.g. `payload.note` -> `payload.noteEn`,
 * `payload.items[3].example` -> `payload.items[3].exampleEn`, `payload.traps[1]` -> `payload.trapsEn[1]`,
 * `title` -> `title_en`. `undefined` when the source has no English sibling.
 */
export function englishSibling(section, fieldPath) {
  if (fieldPath === 'title') return section.title_en;
  if (fieldPath === 'summary') return section.summary_en;
  let parentPath = fieldPath;
  let index = null;
  const trailing = fieldPath.match(/^(.*)\[(\d+)\]$/);
  if (trailing) { parentPath = trailing[1]; index = Number(trailing[2]); }
  const parts = fieldParts(parentPath);
  const leaf = parts.pop();
  const parent = parts.length ? readField(section, parts.join('.')) : section;
  if (!isObject(parent) || !Object.hasOwn(parent, `${leaf}En`)) return undefined;
  const sibling = parent[`${leaf}En`];
  if (index === null) return sibling;
  return Array.isArray(sibling) ? sibling[index] : undefined;
}

/**
 * German noun phrases the translator kept inside a translation, e.g. "das Fenster" or "der Stahl".
 * README rule 2: those sentences/fragments stay verbatim. A case difference on the article is
 * accepted, because a sentence-initial "Das Rind" is correctly lowercased when quoted mid-sentence;
 * nothing else is.
 */
const GERMAN_NOUN_PHRASE = /\b(?:der|die|das|den|dem|des|ein|eine|einen|einem|eines|einer|kein|keine|keinen|keinem|keiner|mein|meine|meinen|meinem|meiner|dein|deine|deinen|sein|seine|seinen|ihr|ihre|ihren|unser|unsere|unseren|euer|eure|Ihr|Ihre|Ihren)\s+[A-ZÄÖÜ][a-zäöüß]{2,}/g;
/** The same expression, exported so a check can find the fragments this rule is about. */
export { GERMAN_NOUN_PHRASE };

/** The German fragments of `text` that are NOT verbatim in `germanSource`. Empty means verbatim. */
export function alteredGermanFragments(text, germanSource) {
  if (typeof germanSource !== 'string') return [];
  const source = germanSource.toLowerCase();
  const altered = [];
  for (const match of String(text).matchAll(GERMAN_NOUN_PHRASE)) {
    if (!source.includes(match[0].toLowerCase())) altered.push(match[0]);
  }
  return altered;
}

/* ------------------------------------------------------------------ planning rows */

/**
 * Bind every bundle guide string to a frozen `guide_section` row and to the German field it
 * translates. `sections` are the rows 0013/0014 seeded. Returns one entry per (path, locale):
 * `{ guide_id, section_id, path, fieldPath, locale, text, english, source_content_version }`.
 *
 * The three checks in here are the ones that make the import safe rather than merely successful:
 * the path must name a real section and a real field, the `en` member must equal the source's own
 * English field, and no German fragment may have been altered inside the translation.
 */
export function planGuideStrings(bundle, sections, versions) {
  const byGuide = new Map();
  for (const section of sections) {
    if (!byGuide.has(section.guide_id)) byGuide.set(section.guide_id, []);
    byGuide.get(section.guide_id).push(section);
  }
  const problems = [];
  const rows = [];
  let boundEnglish = 0;
  for (const [guideId, strings] of Object.entries(bundle.guides)) {
    const candidates = byGuide.get(guideId) ?? [];
    const sourceVersion = versions.get(guideId);
    if (!candidates.length) { problems.push(`${guideId}: no guide_section rows in this installation`); continue; }
    if (!sourceVersion) { problems.push(`${guideId}: no guide row to take the source version from`); continue; }
    for (const [path, members] of Object.entries(strings)) {
      const prefix = `${guideId}/`;
      if (!path.startsWith(prefix)) { problems.push(`${path}: does not start with ${prefix}`); continue; }
      const rest = path.slice(prefix.length);
      let section = null;
      for (const candidate of candidates) {
        if (rest === candidate.section_id || rest.startsWith(`${candidate.section_id}.`)) {
          if (!section || candidate.section_id.length > section.section_id.length) section = candidate;
        }
      }
      if (!section) { problems.push(`${path}: names no guide_section of ${guideId}`); continue; }
      const fieldPath = rest.slice(section.section_id.length + 1);
      if (!fieldPath) { problems.push(`${path}: names no field`); continue; }
      const german = readField(section, fieldPath);
      if (typeof german !== 'string') { problems.push(`${path}: the source has no string at ${fieldPath}`); continue; }
      const keys = Object.keys(members).sort().join(',');
      if (keys !== 'ar,en,tr,uk') { problems.push(`${path}: members are ${keys}, expected ar,en,tr,uk`); continue; }
      const english = englishSibling(section, fieldPath);
      if (typeof english !== 'string') { problems.push(`${path}: the source has no English field to bind ${fieldPath} to`); continue; }
      if (members.en !== english) { problems.push(`${path}: bundle en does not equal the source's ${fieldPath}En`); continue; }
      boundEnglish += 1;
      for (const locale of TRANSLATION_LOCALES) {
        if (!nonEmptyString(members[locale])) { problems.push(`${path}: ${locale} is empty`); continue; }
        const altered = alteredGermanFragments(members[locale], german);
        if (altered.length) { problems.push(`${path}: ${locale} alters German ${JSON.stringify(altered.slice(0, 3))}`); continue; }
        rows.push({
          guide_id: guideId, section_id: section.section_id, path, field_path: fieldPath,
          locale, text: members[locale], english, source_content_version: sourceVersion, german,
        });
      }
    }
  }
  if (problems.length) fail('bundle_source_mismatch', `${problems.length} problem(s); first: ${problems.slice(0, 5).join(' | ')}`);
  return { rows, boundEnglish };
}

/**
 * Bind every bundle noun to a frozen `noun_entry` row. The German name and the German and English
 * example sentences must be byte-identical to the seeded columns: that is the mechanical proof that
 * "the German example sentences inside the translations are unchanged" (README rule 2) for the nouns.
 */
export function planNounRows(bundle, entries) {
  const byId = new Map(entries.map((entry) => [entry.entry_id, entry]));
  const problems = [];
  const rows = [];
  for (const [entryId, members] of Object.entries(bundle.nouns)) {
    const entry = byId.get(entryId);
    if (!entry) { problems.push(`${entryId}: no noun_entry row`); continue; }
    for (const [column, actual] of [['de', entry.de], ['en', entry.en], ['example', entry.example], ['example_en', entry.example_en]]) {
      const bundleKey = column === 'example' ? 'example_de' : column;
      if (members[bundleKey] !== actual) problems.push(`${entryId}: ${bundleKey} is not the seeded ${column}`);
    }
    if (!entry.content_version_id) { problems.push(`${entryId}: no content_version_id`); continue; }
    for (const locale of TRANSLATION_LOCALES) {
      const member = members[locale];
      if (!isObject(member)) { problems.push(`${entryId}: ${locale} is missing`); continue; }
      if (!['meaning', 'example', 'rule'].every((key) => nonEmptyString(member[key]))) {
        problems.push(`${entryId}: ${locale} needs non-empty meaning, example and rule`); continue;
      }
      if (Object.keys(member).sort().join(',') !== 'example,meaning,rule') {
        problems.push(`${entryId}: ${locale} members are ${Object.keys(member).join(',')}`); continue;
      }
      rows.push({
        entry_id: entryId, locale, meaning: member.meaning, example: member.example, rule: member.rule,
        source_content_version: entry.content_version_id,
      });
    }
  }
  if (problems.length) fail('bundle_noun_mismatch', `${problems.length} problem(s); first: ${problems.slice(0, 5).join(' | ')}`);
  return { rows };
}

/* ------------------------------------------------------------------ import */

const GUIDE_COLUMNS = 'path, locale, text, review_status, source_content_version';
const NOUN_COLUMNS = 'entry_id, locale, meaning, example, rule, review_status, source_content_version';

/**
 * Read the frozen source rows the bundle must agree with. One place, one shape, so the importer and
 * the check cannot disagree about what "the source" is.
 */
export async function readFrozenSource(client) {
  const guides = (await client.query(
    'SELECT guide_id, content_version_id FROM guide ORDER BY guide_id')).rows;
  const sections = (await client.query(
    'SELECT guide_id, section_id, title, title_en, summary, summary_en, payload FROM guide_section ORDER BY guide_id, ordinal')).rows;
  const entries = (await client.query(
    'SELECT entry_id, de, en, example, example_en, content_version_id FROM noun_entry ORDER BY ordinal')).rows;
  return {
    guides,
    sections,
    entries,
    versions: new Map(guides.map((row) => [row.guide_id, row.content_version_id])),
  };
}

/**
 * Import the bundle. The CALLER owns the transaction and the role (schema owner, so the write is
 * permitted and no runtime role needs INSERT).
 *
 * Idempotent by construction: an existing row is compared on its text and its source version and is
 * then LEFT ALONE — never updated, so a native review survives a re-import and a second run changes
 * no row bytes. A row that disagrees is a conflict and stops the import instead of overwriting it,
 * because "the bundle changed" and "the database changed" cannot both be resolved silently.
 *
 * `dryRun` performs the whole comparison and writes nothing.
 */
export async function importLibraryTranslations(client, { bundle, digest, dryRun = false }, { source = null } = {}) {
  validateBundleShape(bundle);
  const frozen = source ?? await readFrozenSource(client);
  if (!frozen.guides.length || !frozen.entries.length) {
    fail('source_catalogue_empty', 'this database has no guide or noun catalogue to translate; apply the migrations first');
  }
  // One importer at a time per bundle, so the read-then-insert below cannot race with a peer.
  const lockKey = `library-translations:${digest ?? 'unknown'}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 7352))', [lockKey]);

  const guidePlan = planGuideStrings(bundle, frozen.sections, frozen.versions);
  const nounPlan = planNounRows(bundle, frozen.entries);

  const counts = { inserted: 0, unchanged: 0 };
  const nounCounts = { inserted: 0, unchanged: 0 };
  const conflicts = [];

  for (const row of guidePlan.rows) {
    const existing = (await client.query(
      `SELECT ${GUIDE_COLUMNS} FROM guide_translation WHERE path = $1 AND locale = $2`,
      [row.path, row.locale])).rows[0];
    if (existing) {
      if (existing.text !== row.text) conflicts.push(`${row.path} (${row.locale}): stored text differs from the bundle`);
      else if (existing.source_content_version !== row.source_content_version) {
        conflicts.push(`${row.path} (${row.locale}): stored for ${existing.source_content_version}, the bundle is for ${row.source_content_version}`);
      } else counts.unchanged += 1;
      continue;
    }
    counts.inserted += 1;
    if (dryRun) continue;
    await client.query(
      `INSERT INTO guide_translation (guide_id, section_id, path, locale, text, review_status, source_content_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.guide_id, row.section_id, row.path, row.locale, row.text, REVIEW_STATUS.MACHINE, row.source_content_version]);
  }

  for (const row of nounPlan.rows) {
    const existing = (await client.query(
      `SELECT ${NOUN_COLUMNS} FROM noun_translation WHERE entry_id = $1 AND locale = $2`,
      [row.entry_id, row.locale])).rows[0];
    if (existing) {
      const same = existing.meaning === row.meaning && existing.example === row.example && existing.rule === row.rule;
      if (!same) conflicts.push(`${row.entry_id} (${row.locale}): stored text differs from the bundle`);
      else if (existing.source_content_version !== row.source_content_version) {
        conflicts.push(`${row.entry_id} (${row.locale}): stored for ${existing.source_content_version}, the bundle is for ${row.source_content_version}`);
      } else nounCounts.unchanged += 1;
      continue;
    }
    nounCounts.inserted += 1;
    if (dryRun) continue;
    await client.query(
      `INSERT INTO noun_translation (entry_id, locale, meaning, example, rule, review_status, source_content_version)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [row.entry_id, row.locale, row.meaning, row.example, row.rule, REVIEW_STATUS.MACHINE, row.source_content_version]);
  }

  if (conflicts.length) {
    fail('translation_conflict', `${conflicts.length} stored row(s) disagree with the bundle; first: ${conflicts.slice(0, 3).join(' | ')}`);
  }
  return {
    digest: digest ?? null,
    dryRun,
    guideStrings: { ...counts, total: guidePlan.rows.length, boundEnglish: guidePlan.boundEnglish },
    nouns: { ...nounCounts, total: nounPlan.rows.length },
  };
}

/* ------------------------------------------------------------------ read path (§4.3) */

/**
 * The additive `translations` member for `GET /api/v1/guides/:id?locale=<l>`, or `null`.
 *
 * `null` means "render German only with one Übersetzung-folgt note", and it is the answer whenever this
 * guide has no CURRENT translated line in that locale. Three situations deliberately share it, because
 * the frozen interface has one way to say "not current" and inventing a second would be an amendment:
 * a locale with no imported bundle (`de`, `en`, or an unimported uk/ar/tr), a bundle whose every row for
 * this guide is rejected, and a bundle generated from a guide version that is no longer current.
 * Serving the last of those as if it were current is the defect contract §4.3 names.
 *
 * The rule is anchored on the GUIDE STRINGS, not on the nouns: this member is returned for a guide page,
 * so a guide with no current translated line must answer `null` even when the noun lexicon is current,
 * or the client's "translations is null" branch would never fire and the note would go missing. The noun
 * lexicon rides along when both are current, and is simply absent from a `null` answer.
 */
export async function readGuideTranslations(client, { guideId, locale }) {
  if (!INTERFACE_LOCALES.includes(locale)) fail('invalid_locale', locale);
  if (!TRANSLATION_LOCALES.includes(locale)) return null;
  const head = (await client.query(
    'SELECT content_version_id FROM guide WHERE guide_id = $1', [guideId])).rows[0];
  if (!head) return null;

  const strings = (await client.query(
    `SELECT path, text, review_status FROM guide_translation
      WHERE guide_id = $1 AND locale = $2 AND review_status <> $3 AND source_content_version = $4
      ORDER BY path`,
    [guideId, locale, REVIEW_STATUS.REJECTED, head.content_version_id])).rows;
  if (!strings.length) return null;
  const nouns = (await client.query(
    `SELECT t.entry_id, t.meaning, t.example, t.rule, t.review_status
       FROM noun_translation t
       JOIN noun_entry e USING (entry_id)
      WHERE t.locale = $1 AND t.review_status <> $2 AND t.source_content_version = e.content_version_id
      ORDER BY e.ordinal`,
    [locale, REVIEW_STATUS.REJECTED])).rows;

  const statuses = [...strings, ...nouns].map((row) => row.review_status);
  return {
    locale,
    guideVersion: head.content_version_id,
    // The conservative marker: while any served row is still machine-produced, the whole member says so.
    status: statuses.includes(REVIEW_STATUS.MACHINE) ? REVIEW_STATUS.MACHINE : REVIEW_STATUS.APPROVED,
    strings: Object.fromEntries(strings.map((row) => [row.path, row.text])),
    nouns: Object.fromEntries(nouns.map((row) => [row.entry_id, { meaning: row.meaning, example: row.example, rule: row.rule }])),
    // Contract §4.3 asks for the per-string status so the client can mark unreviewed lines
    // individually once native review approves some of them.
    stringStatus: Object.fromEntries(strings.map((row) => [row.path, row.review_status])),
  };
}

/** A stable fingerprint of every translation row, for "a second run changed no bytes" evidence. */
export async function translationFingerprint(client) {
  const guides = (await client.query(
    `SELECT path, locale, guide_id, section_id, text, review_status, reviewer, reviewed_at, source_content_version
       FROM guide_translation ORDER BY path, locale`)).rows;
  const nouns = (await client.query(
    `SELECT entry_id, locale, meaning, example, rule, review_status, reviewer, reviewed_at, source_content_version
       FROM noun_translation ORDER BY entry_id, locale`)).rows;
  return sha256(Buffer.from(JSON.stringify({ guides, nouns }), 'utf8'));
}
