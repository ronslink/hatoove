#!/usr/bin/env node
/**
 * MFP-01 — the only thing that changes the schema.
 *
 *     node server/migrate.mjs
 *
 * It applies every pending frozen migration in `server/migrations/` (in order, each in one
 * transaction with its ledger row and its sha256), backfills a checksum for any migration an
 * older installation applied before the ledger carried one, prints a one-line summary, and
 * **exits**. It is not imported by the runtime, and the runtime never runs it: a web process
 * holding migration credentials is the wrong shape, and a runtime that migrates at start hides
 * a schema that is behind.
 *
 * Exit status: `0` when the database is at the expected head (whether or not anything was
 * applied), non-zero on any failure — including a checksum mismatch, which names the migration
 * and both digests and applies nothing.
 *
 * Credentials: the bootstrap connection (`OWNAPI_PG_USER`) is used only to create the schema
 * and the least-privilege roles when they are missing; every statement that changes the schema
 * runs as the `_migration` role. `OWNAPI_PG_ALLOW=1` is required, so the command can never be
 * pointed at a database by accident.
 *
 * Safety: synthetic data only. It never DROPs a schema, a role or a row, never deletes applied
 * history, and never touches a database named `postgres`, `template0` or `template1`.
 */

import { migrate, persistentConfig } from './owned-postgres/provision.mjs';

const FORBIDDEN = new Set(['postgres', 'template0', 'template1']);

function guard() {
  const database = process.env.OWNAPI_PG_DATABASE || '';
  if (!database) throw new Error('OWNAPI_PG_DATABASE must name the installation database');
  if (FORBIDDEN.has(database)) {
    throw new Error(`refusing to migrate ${database}; set OWNAPI_PG_DATABASE to the installation database`);
  }
  if (process.env.OWNAPI_PG_ALLOW !== '1') {
    throw new Error('set OWNAPI_PG_ALLOW=1 to confirm you may change this database');
  }
  // Validate the identifiers before anything connects, so a typo fails before a connection.
  persistentConfig();
}

const invokedDirectly = process.argv[1] && process.argv[1].endsWith('migrate.mjs');

if (invokedDirectly) {
  try {
    guard();
    const summary = await migrate();
    console.log(`migrate: schema=${summary.schema} applied=${summary.applied.length} skipped=${summary.skipped.length} backfilled=${summary.backfilled}`);
    console.log(`  applied: ${summary.applied.length ? summary.applied.join(', ') : '(none)'}`);
    if (summary.backfilled) console.log(`  backfilled checksums: ${summary.backfilled} row(s) from the frozen files`);
    console.log(summary.applied.length || summary.backfilled ? 'migrate: OK' : 'migrate: already at the expected head');
    process.exit(0);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    console.error(`migrate: FAILED ${message}`);
    process.exit(1);
  }
}

export { guard as migrateGuard };
