#!/usr/bin/env node
/**
 * LIBRARY-I18N-01 (F2) — import the uk/ar/tr reference-library translations.
 *
 *     node tools/import-library-translations.mjs [--dry-run]
 *
 * Reads the tracked bundle `content/library-translations/hatoove-library-translations-uk-ar-tr.json`
 * (737 guide strings + 240 noun rows), proves its sha256 against the pin in the README next to it,
 * proves the strings still match the frozen German/English source, and writes every row as
 * `machine_unreviewed` into `guide_translation` / `noun_translation` (migration 0042).
 *
 * This is an OPERATOR command, not a runtime route, and it is the ONLY writer of these tables. It
 * runs inside ONE transaction as the schema-owner role (`<prefix>_migration`), exactly like
 * `tools/import-exam-package.mjs`: no runtime role holds INSERT on a catalogue table, and the running
 * server never imports, never migrates and never marks a translation approved.
 *
 * SAFETY. `OWNAPI_PG_ALLOW=1` is required, so it can never be pointed at a database by accident, and
 * `postgres`/`template0`/`template1` are refused by `persistentConfig`. A second run inserts nothing,
 * changes no row bytes and cannot un-approve a reviewed row; a row that disagrees with the bundle is a
 * conflict that fails the whole transaction rather than an overwrite.
 *
 * Usage:
 *   OWNAPI_PG_ALLOW=1 OWNAPI_PG_DATABASE=<disposable> node tools/import-library-translations.mjs [--dry-run]
 */
import { pathToFileURL } from 'node:url';
import { persistentConfig, persistentRolePool } from '../server/owned-postgres/provision.mjs';
import { importLibraryTranslations, loadVerifiedBundle, LibraryTranslationError } from '../server/library-translations.mjs';

export async function main(args = process.argv.slice(2)) {
  const unknown = args.filter((argument) => argument !== '--dry-run');
  if (unknown.length) throw new Error(`usage: node tools/import-library-translations.mjs [--dry-run] (unknown: ${unknown.join(' ')})`);
  const dryRun = args.includes('--dry-run');
  if (process.env.OWNAPI_PG_ALLOW !== '1') throw new Error('OWNAPI_PG_ALLOW=1 required for the selected database');
  const { bundle, digest } = await loadVerifiedBundle();
  const config = persistentConfig();
  const pool = persistentRolePool(config, 'migration', { max: 1 });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const summary = await importLibraryTranslations(client, { bundle, digest, dryRun });
    // A dry run proves the whole plan and then leaves the database exactly as it found it.
    await client.query(dryRun ? 'ROLLBACK' : 'COMMIT');
    return { ...summary, schema: config.schema };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await main(), null, 2));
  } catch (error) {
    const code = error instanceof LibraryTranslationError ? `${error.code}: ` : '';
    console.error(`library translation import failed: ${code}${error.message}`);
    process.exitCode = 1;
  }
}
