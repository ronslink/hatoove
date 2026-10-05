/**
 * Shared helpers for the library-seed generators.
 *
 * WHY THIS EXISTS: `build-vocab-migration.mjs` and `build-noun-migration.mjs` are the second and
 * third tools of the same shape, and the queue says seven more corpora follow. Three copies of an
 * escaper is how one of them ends up subtly different from the others — and the difference would be
 * in how a German headword with an apostrophe is escaped into SQL, which is exactly the kind of bug
 * that survives a code review and corrupts a seed.
 *
 * `build-vocab-migration.mjs` is deliberately left as it is rather than refactored onto this module:
 * it is applied, pushed and green, and rewriting a green artifact to remove duplication is a change
 * with no product value and real risk. It should adopt this the next time it is touched for a real
 * reason.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

/** A SQL literal, or NULL. Escapes the quote rather than trusting the corpus to be well behaved. */
export const sqlText = (value) => (value === null || value === undefined
  ? 'NULL'
  : `'${String(value).replace(/'/g, "''")}'`);

/**
 * A stable, readable key from a German headword: `der Verwandte` -> `der-verwandte`.
 *
 * Umlauts are transliterated rather than stripped, so `die Erziehung` and a hypothetical
 * `die Erzieung` cannot collapse onto one id.
 */
export const slug = (term) => String(term)
  .toLowerCase()
  .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '');

/**
 * Assign an id per row, deterministically.
 *
 * Ids come from the HEADWORD rather than the row's position: nothing references a lexicon entry today,
 * but exercises and adaptive selection will, and a positional id silently repoints every entry at a
 * different word the moment the source is reordered. A genuine duplicate gets `-2`, `-3` … in source
 * order, so it is visible in the output instead of being lost.
 */
export function makeIdFactory(prefix) {
  const seen = new Map();
  const collisions = [];
  return {
    idFor(headword) {
      const base = `${prefix}.${slug(headword)}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      if (n > 1) collisions.push(`${base} x${n}`);
      return n === 1 ? base : `${base}-${n}`;
    },
    collisions,
  };
}

export const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

/**
 * Write the migration, or verify it under `--check`. Every generator in this family gets the same
 * drift detection, because a generated file that nobody re-checks is indistinguishable from a
 * hand-edited one.
 */
export function emitMigration({ root, target, sql, summary, argv = process.argv }) {
  const relative = target.replace(`${root}/`, '').replace(`${root}\\`, '');
  if (argv.includes('--check')) {
    const current = existsSync(target) ? readFileSync(target, 'utf8') : '';
    if (current !== sql) {
      console.error('library-seed: FAILED the generated migration differs from its source');
      console.error(`  the committed ${relative} is not what the generator would produce now`);
      /*
       * MIRROR-B1PREP-01 CONTENT-CORRECTIONS. This advice used to say "re-run the generator without
       * --check to regenerate", which is dangerous once the migration has been applied anywhere: the
       * applied file's digest is frozen in server/migrations/MANIFEST.json, so regenerating it would
       * rewrite an applied seed and break every environment that has it. A correction to seeded content
       * ships as a NEW forward migration; the source file is fixed so future generations agree.
       */
      console.error('  the source moved on: this migration has already been applied somewhere and its');
      console.error('  committed digest is frozen, so DO NOT regenerate it — ship the correction as a new');
      console.error('  forward migration and leave the applied file byte-identical (see 0043 for the pattern)');
      process.exit(1);
    }
    console.log(`library-seed: OK ${relative} matches its source`);
    for (const line of summary) console.log(`  ${line}`);
    process.exit(0);
  }
  writeFileSync(target, sql);
  console.log(`library-seed: wrote ${relative}`);
  for (const line of summary) console.log(`  ${line}`);
}
