/**
 * MFP-14 — the table-class catalogue check.
 *
 * Classifies EVERY table in the app schema into exactly one of three classes and fails on any
 * unclassified table:
 *
 *   auth            Better Auth's tables (user, session, account, verification)
 *                   no RLS; the auth role only (no learner/worker grant)
 *   owned           account rows: has owner_id/user_id, or is owned through one (drafts)
 *                   FORCE ROW LEVEL SECURITY; an owner policy for the learner role;
 *                   an FK path to "user"; present in ACCOUNT_TABLES
 *   shared content  the versioned content records (content_version, rubric_version, task_version)
 *                   no runtime INSERT/UPDATE/DELETE grant; an immutability trigger
 *
 * It also asserts, because these are cheap and they are the failure modes that hurt:
 *   - no key-bearing table grants SELECT to a runtime role (asserted even with zero such tables,
 *     so the day `task_key` is added it is caught);
 *   - no runtime role holds BYPASSRLS or SUPERUSER;
 *   - the migration ledger records a checksum (reported as a FINDING, not a class failure —
 *     MFP-01 owns the fix).
 *
 * WHY IT EXISTS. Round-1's "most dangerous #2" is deletion/RLS drift: `ACCOUNT_TABLES`
 * (`server/owned-postgres/adapter.mjs`) is a hand-maintained list, so a new owned table is
 * covered by the deletion read-back only if someone remembers to add it — and `deletion-check`
 * 18/18 would still pass while an account's rows survived in it. This check is the thing that
 * fails when that happens.
 *
 * PRIVILEGES: read-only catalog SELECTs; it never writes. It may run against a disposable
 * installation, a scratch schema, or (read only) a real one.
 *
 * Usage: node tools/table-class-check.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ACCOUNT_TABLES } from '../server/owned-postgres/adapter.mjs';
import {
  AUTH_TABLES, CONTENT_TABLES, INFRASTRUCTURE_TABLES, OWNER_COLUMNS,
  accountTableNames, bare, columnsOf, policiesFor, privilegesFor, isKeyBearing, readCatalogue,
} from './lib/catalogue.mjs';

const DML = ['INSERT', 'UPDATE', 'DELETE'];

/** Roles that may hold BYPASSRLS/SUPERUSER without it being a violation. None: every role here is restricted. */
const OWNER_COL_RE = /owner_id|user_id|hatoove\.owner_id/;

/* --------------------------------------------------------------- anchors */

/** A comma-joined column list (from `array_to_string`) to an array. */
const colsOf = (value) => (Array.isArray(value) ? value : String(value || '').split(',').filter(Boolean));

/** Foreign keys normalised to bare table names. */
const normaliseFks = (catalogue) => catalogue.foreignKeys.map((fk) => ({
  table: bare(fk.table),
  refTable: bare(fk.ref_table),
  columns: colsOf(fk.columns),
  refColumns: colsOf(fk.ref_columns),
}));

/** Is `refColumns` a primary key or unique constraint of `refTable`? Only then is an FK an ownership link. */
function isKeyOf(catalogue, refTable, refColumns) {
  const want = [...refColumns].sort().join(',');
  return catalogue.uniqueKeys.some((k) => bare(k.table) === refTable
    && colsOf(k.columns).slice().sort().join(',') === want);
}

/**
 * The ownership anchor of every owned table: a direct FK to `"user"`, or a chain of FKs through
 * real keys to a table that has one. Returns a Map name -> {kind, via}.
 */
export function anchorToUser(catalogue, candidates) {
  const fks = normaliseFks(catalogue);
  const anchor = new Map();
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of candidates) {
      if (anchor.has(name)) continue;
      const mine = fks.filter((fk) => fk.table === name && fk.refTable !== name);
      if (mine.some((fk) => fk.refTable === 'user')) { anchor.set(name, { kind: 'direct', via: 'user' }); changed = true; continue; }
      const hop = mine.find((fk) => anchor.has(fk.refTable) && isKeyOf(catalogue, fk.refTable, fk.refColumns));
      if (hop) { anchor.set(name, { kind: 'transitive', via: hop.refTable }); changed = true; }
    }
  }
  return anchor;
}

/* ----------------------------------------------------------- classifier */

/**
 * Classify a catalogue. Pure: it only reads the object `readCatalogue` produced.
 * @param {object} catalogue
 * @param {{roles: object, accountTables?: Array}} options `roles` is the `{migration,auth,learner,worker,deletion}` map.
 * @returns {{rows: Array, findings: Array, failures: Array, ok: boolean}}
 */
export function classifyCatalogue(catalogue, { roles, accountTables = ACCOUNT_TABLES } = {}) {
  const { auth, learner, worker, migration, deletion } = roles;
  const restrictedTo = [learner, worker]; // the roles that must never reach an auth table
  const accountSet = accountTableNames(accountTables);

  // A table is account-owned if it has an owner column, or if it is named in ACCOUNT_TABLES
  // (this is how `drafts`, which has no owner column, is recognised).
  const candidates = catalogue.tables
    .map((t) => t.name)
    .filter((name) => !AUTH_TABLES.includes(name) && !CONTENT_TABLES.includes(name)
      && !INFRASTRUCTURE_TABLES.includes(name))
    .filter((name) => columnsOf(catalogue, name).some((c) => OWNER_COLUMNS.includes(c)) || accountSet.has(name));

  const anchors = anchorToUser(catalogue, candidates);
  const rows = [];
  const findings = [];

  const note = (failures) => (failures.length ? 'FAIL' : 'OK');

  for (const table of catalogue.tables) {
    const name = table.name;
    const cols = columnsOf(catalogue, name);
    const fail = [];

    if (AUTH_TABLES.includes(name)) {
      if (table.rls || table.force_rls) fail.push(`auth table must have RLS off (rls=${table.rls}, force=${table.force_rls})`);
      const granted = privilegesFor(catalogue, name, auth);
      if (!granted.length) fail.push('the auth role holds no privilege on this auth table');
      for (const role of restrictedTo) {
        const p = privilegesFor(catalogue, name, role);
        if (p.length) fail.push(`auth table grants ${p.join('/')} to ${role}`);
      }
      rows.push({ table: name, cls: 'auth', verdict: note(fail), detail: fail.length ? fail.join('; ') : `no RLS; ${auth} only` });
      continue;
    }

    if (CONTENT_TABLES.includes(name)) {
      // Runtime roles only. `migration` OWNS the schema and every table, so PostgreSQL always
      // reports it holding a/r/w/d — the owner's implicit privileges are not a runtime grant.
      // `provision.mjs` says it plainly: the migration role "has no runtime route".
      const runtime = [auth, learner, worker, deletion].filter(Boolean);
      for (const role of runtime) {
        const p = privilegesFor(catalogue, name, role).filter((x) => DML.includes(x));
        if (p.length) fail.push(`shared content grants ${p.join('/')} to ${role}`);
      }
      const immutable = catalogue.triggers.some((t) => bare(t.table) === name
        && /BEFORE/i.test(t.def) && /(UPDATE|DELETE|INSERT)/i.test(t.def) && /immutable/i.test(t.def));
      if (!immutable) fail.push('no immutability trigger (BEFORE UPDATE/DELETE)');
      rows.push({ table: name, cls: 'shared content', verdict: note(fail), detail: fail.length ? fail.join('; ') : `no runtime DML grant (runtime roles: ${runtime.join('/')}); immutability trigger present; owner ${migration} holds the usual owner privileges` });
      continue;
    }

    if (INFRASTRUCTURE_TABLES.includes(name)) {
      const ledger = catalogue.ledger && catalogue.ledger.checksumColumn;
      if (!ledger) findings.push(`${name}: the migration ledger records no checksum (fix owner: MFP-01)`);
      rows.push({
        table: name, cls: 'infrastructure',
        verdict: ledger ? 'OK' : 'FINDING',
        detail: ledger ? `ledger records checksum in "${ledger}"` : 'no checksum column — reported as a finding, not a class failure (MFP-01)',
      });
      continue;
    }

    const ownerCol = cols.find((c) => OWNER_COLUMNS.includes(c));
    if (ownerCol || accountSet.has(name)) {
      if (!table.force_rls) fail.push('owned table must FORCE ROW LEVEL SECURITY');
      if (!table.rls) fail.push('owned table must ENABLE ROW LEVEL SECURITY');
      const ownerPolicies = policiesFor(catalogue, name, learner)
        .filter((p) => OWNER_COL_RE.test(`${p.using_expr || ''} ${p.check_expr || ''}`));
      if (!ownerPolicies.length) fail.push(`no owner policy for the learner role (${learner})`);
      if (!accountSet.has(name)) fail.push('owned table is absent from ACCOUNT_TABLES (the deletion read-back would skip it)');
      const anchor = anchors.get(name);
      if (!anchor) fail.push('owned table has no FK path to "user"');
      const anchorNote = anchor ? `anchor: ${anchor.kind} FK to "user"${anchor.kind === 'transitive' ? ` via ${anchor.via}` : ''}` : 'anchor: none';
      rows.push({
        table: name, cls: 'owned',
        verdict: note(fail),
        detail: fail.length ? fail.join('; ') : `FORCE RLS; learner owner policy; in ACCOUNT_TABLES; ${anchorNote}; owner column ${ownerCol || '(through a parent key)'}`,
      });
      continue;
    }

    fail.push('unclassified table: it is not auth, owned, shared content or the ledger');
    rows.push({ table: name, cls: 'unclassified', verdict: 'FAIL', detail: fail.join('; ') });
  }

  /* ---- global rules that are not per-table ---- */

  for (const role of catalogue.roleAttributes) {
    const bad = [];
    if (role.rolsuper) bad.push('SUPERUSER');
    if (role.rolbypassrls) bad.push('BYPASSRLS');
    if (bad.length) rows.push({ table: `role:${role.role}`, cls: 'role', verdict: 'FAIL', detail: `runtime role holds ${bad.join(' and ')}` });
  }
  const roleRows = rows.filter((r) => r.cls === 'role');
  if (!roleRows.length && catalogue.roleAttributes.length) {
    rows.push({ table: '(all schema roles)', cls: 'role', verdict: 'OK', detail: `${catalogue.roleAttributes.length} role(s) hold no SUPERUSER/BYPASSRLS: ${catalogue.roleAttributes.map((r) => r.role).join(', ')}` });
  }

  /* ---- answer-key rule: asserted even with zero key-bearing tables ---- */
  for (const table of catalogue.tables) {
    const name = table.name;
    if (!isKeyBearing(name, columnsOf(catalogue, name))) continue;
    for (const role of [learner, auth, worker]) {
      const p = privilegesFor(catalogue, name, role);
      if (p.includes('SELECT')) {
        rows.push({ table: name, cls: 'answer key', verdict: 'FAIL', detail: `key-bearing table grants SELECT to ${role}` });
      }
    }
  }
  const keyTables = catalogue.tables.filter((t) => isKeyBearing(t.name, columnsOf(catalogue, t.name)));
  if (!keyTables.length) {
    rows.push({ table: '(answer-key tables)', cls: 'answer key', verdict: 'OK', detail: 'none exist yet; the no-SELECT rule is asserted and would fail the day one is added' });
  }

  const failures = rows.filter((r) => r.verdict === 'FAIL');
  // `ok` is the CLASS check: a ledger-checksum finding does not fail it (MFP-01 owns that fix).
  return { rows, findings, failures, ok: failures.length === 0 };
}

/* ------------------------------------------------------------------ run */

/** Read the catalogue from a database handle and classify it. */
export async function runTableClassCheck({ db, schema, roles, accountTables = ACCOUNT_TABLES }) {
  const catalogue = await readCatalogue(db, { schema });
  return { catalogue, ...classifyCatalogue(catalogue, { roles, accountTables }) };
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const { persistentConfig, provisionPersistent, closePersistent } = await import('../server/owned-postgres/provision.mjs');
  const config = persistentConfig();
  const pools = await provisionPersistent({ config });
  let report;
  try {
    report = await runTableClassCheck({ db: pools.admin, schema: config.schema, roles: config.roles });
  } finally {
    await closePersistent(pools);
  }

  const width = Math.max(8, ...report.rows.map((r) => r.table.length));
  console.log(`\n=== table-class-check: schema "${config.schema}" ===\n`);
  console.log(`${'TABLE'.padEnd(width)}  ${'CLASS'.padEnd(12)}  VERDICT  DETAIL`);
  console.log(`${'-'.repeat(width)}  ${'-'.repeat(12)}  -------  ------`);
  for (const row of report.rows) {
    console.log(`${row.table.padEnd(width)}  ${row.cls.padEnd(12)}  ${row.verdict.padEnd(7)}  ${row.detail}`);
  }
  console.log(`\n${report.rows.length} table row(s); ${report.failures.length} failure(s); ${report.findings.length} finding(s)`);
  for (const finding of report.findings) console.log(`FINDING ${finding}`);
  console.log(report.ok
    ? '\nOK: every table is classified and every class rule holds.'
    : `\nFAIL: ${report.failures.length} rule(s) broke (see the DETAIL column).`);
  // Only a broken CLASS rule exits non-zero; a finding is reported, not failed (MFP-01 owns it).
  process.exitCode = report.failures.length ? 1 : 0;
}
