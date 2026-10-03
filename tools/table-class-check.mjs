/**
 * MFP-14 — the table-class catalogue check.
 *
 * Classifies EVERY table in the app schema into exactly one class and fails on any
 * unclassified table:
 *
 *   auth            Better Auth's tables (user, session, account, verification)
 *                   no RLS; the auth role only (no learner/worker grant)
 *   auth support    auth-seam state outside Better Auth's schema (auth_throttle, 0019)
 *                   no RLS; the auth role only (nothing for learner/worker/deletion/provisioner)
 *   owned           account rows: has owner_id/user_id, or is owned through one (drafts)
 *                   FORCE ROW LEVEL SECURITY; an owner policy for the learner role; an
 *                   owner-scoped policy plus SELECT/DELETE for the deletion role (or the
 *                   deletion read-back is vacuous); an FK path to "user"; in ACCOUNT_TABLES
 *   shared content  append-only content records (content_version, rubric_version, task_version,
 *                   content_rights) - no runtime INSERT/UPDATE/DELETE grant; an immutability trigger
 *   private editorial review authority, decisions and compatibility baseline - no runtime/PUBLIC
 *                   table or column privilege, including SELECT; enabled immutability triggers
 *   private-owned telemetry function-only worker writes, safe owner export only; exact composite
 *                   ownership, owner-scoped hard deletion, immutable observations and deferred acceptance
 *   catalogue       migration-seeded reference data (exam_package, objective_set, vocab_entry,
 *                   noun_entry, guide, guide_section) - SELECT for the learner; no runtime DML;
 *                   nothing for auth/deletion/provisioner; no owner column; no key column
 *   answer key      objective_key - NO runtime role holds ANY privilege; marking goes through a
 *                   SECURITY DEFINER function owned by the migration role
 *
 * It also asserts, because these are cheap and they are the failure modes that hurt:
 *   - no key-bearing table grants SELECT to a runtime role (asserted even with zero such tables,
 *     so the day `task_key` is added it is caught);
 *   - no runtime role holds BYPASSRLS or SUPERUSER;
 *   - every SECURITY DEFINER function pins search_path and is not executable by PUBLIC;
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
  AUTH_TABLES, AUTH_SUPPORT_TABLES, CATALOGUE_TABLES, CONTENT_TABLES, PRIVATE_REVIEW_TABLES, PRIVATE_TELEMETRY_TABLES, PROTECTED_EXPLANATION_TABLES, INFRASTRUCTURE_TABLES, KEY_TABLES, OWNER_COLUMNS,
  accountTableNames, bare, columnsOf, policiesFor, privilegesFor, isKeyBearing, readCatalogue,
} from './lib/catalogue.mjs';

const DML = ['INSERT', 'UPDATE', 'DELETE'];

/** Roles that may hold BYPASSRLS/SUPERUSER without it being a violation. None: every role here is restricted. */
const OWNER_COL_RE = /owner_id|user_id|hatoove\.owner_id/;

// Compare the installed, fixed policy expression; a mention of owner_id alone is not an owner fence.
const policyShape = value => String(value || '').replace(/\bNULLIF(?=\()/g, 'nullif').replaceAll('::text', '').replace(/[\s()]/g, '');
const TELEMETRY_OWNER_POLICY = policyShape("owner_id = nullif(current_setting('hatoove.owner_id', true), '')");
const TELEMETRY_IDENTITY = ['attempt_id', 'owner_id', 'exam_id', 'job_id', 'submission_id', 'claim_number'];

function telemetryRules(catalogue, table, roles, accountSet, anchors) {
  const fail = [], name = table.name;
  const {worker, deletion, migration, learner} = roles;
  const runtime = Object.entries(roles).filter(([kind]) => kind !== 'migration').map(([,role]) => role).filter(Boolean);
  const sameColumns = (actual, expected) => colsOf(actual).join(',') === expected.join(',');
  const hasKey = (target, columns) => catalogue.uniqueKeys.some(key => bare(key.table) === target
    && sameColumns(key.columns, columns));
  const hasFk = (columns, target, referenced) => catalogue.foreignKeys.some(fk => bare(fk.table) === name
    && fk.ref_schema === catalogue.schema && fk.validated === true && bare(fk.ref_table) === target
    && sameColumns(fk.columns, columns) && sameColumns(fk.ref_columns, referenced) && hasKey(target, referenced));
  const primaryId = name === 'provider_attempt' ? 'attempt_id' : 'event_id';
  if (!hasKey(name, [primaryId])) fail.push(`private telemetry lacks globally unique ${primaryId}`);
  for (const column of new Set([...TELEMETRY_IDENTITY, primaryId])) {
    if (!catalogue.columns.some(c => c.table === name && c.column === column && c.nullable === false)) {
      fail.push(`private telemetry identity ${column} must exist and be NOT NULL`);
    }
  }
  if (!table.rls || !table.force_rls) fail.push('private telemetry must ENABLE and FORCE ROW LEVEL SECURITY');
  if (!accountSet.has(name)) fail.push('private telemetry absent from ACCOUNT_TABLES');
  if (!anchors.has(name)) fail.push('private telemetry has no FK path to "user"');
  const grantees = new Set([...runtime, 'PUBLIC', ...catalogue.tableGrants, ...catalogue.columnGrants]
    .map(value => typeof value === 'string' ? value : value.table === name ? value.grantee : null).filter(Boolean));
  grantees.delete(migration); // Schema-owner authority is not a runtime grant.
  for (const role of grantees) {
    const allowed = role === worker ? ['SELECT'] : role === deletion ? ['SELECT', 'DELETE'] : [];
    const unexpected = privilegesFor(catalogue, name, role).filter(p => !allowed.includes(p));
    if (unexpected.length) fail.push(`private telemetry grants unexpected ${unexpected.join('/')} to ${role}`);
  }
  // Whole-table grants are required here: a column-only SELECT cannot prove deletion read-back.
  for (const [role, required] of [[worker, ['SELECT']], [deletion, ['SELECT', 'DELETE']]]) {
    for (const privilege of required) if (!role || !catalogue.tableGrants.some(g => g.table === name && g.grantee === role && g.privilege === privilege)) {
      fail.push(`private telemetry lacks ${privilege} for ${role || 'required role'}`);
    }
  }
  const mine = catalogue.policies.filter(p => p.table === name);
  for (const command of ['SELECT', 'DELETE']) {
    const policies = policiesFor(catalogue, name, deletion).filter(p => p.cmd === 'ALL' || p.cmd === command);
    if (!policies.some(p => p.permissive === 'PERMISSIVE' && policyShape(p.using_expr) === TELEMETRY_OWNER_POLICY)) {
      fail.push(`private telemetry lacks exact deletion owner policy for ${command}`);
    }
    if (policies.some(p => policyShape(p.using_expr) !== TELEMETRY_OWNER_POLICY)) {
      fail.push(`private telemetry deletion ${command} policy widens owner scope`);
    }
  }
  if (!policiesFor(catalogue, name, worker).some(p => p.cmd === 'SELECT' && p.permissive === 'PERMISSIVE' && policyShape(p.using_expr) === 'true')) {
    fail.push('private telemetry lacks worker SELECT policy');
  }
  if (!policiesFor(catalogue, name, migration).some(p => p.cmd === 'ALL' && p.permissive === 'PERMISSIVE'
    && policyShape(p.using_expr) === 'true' && policyShape(p.check_expr) === 'true')) {
    fail.push('private telemetry lacks function-owner policy');
  }
  for (const policy of mine) {
    const assigned = policy.roles.split(',').map(x => x.trim());
    if (assigned.some(role => ![migration, worker, deletion].includes(role))) fail.push('private telemetry policy grants an unexpected role');
    if (assigned.includes(worker) && policy.cmd !== 'SELECT') fail.push('private telemetry worker policy is not SELECT-only');
  }
  const guard = (mask, row, fn) => catalogue.triggers.some(t => bare(t.table) === name
    && ['O','A'].includes(t.enabled) && (t.type & 2) && Boolean(t.type & 1) === row
    && (t.type & mask) && t.unconditional && !t.update_columns
    && t.function_schema === catalogue.schema && t.function_name === fn);
  const fn = name === 'provider_attempt' ? 'guard_provider_attempt' : 'guard_provider_observation';
  for (const [event, mask] of [['INSERT',4], ['UPDATE',16], ['DELETE',8]]) {
    if (!guard(mask, true, fn)) fail.push(`private telemetry lacks enabled BEFORE ${event} row guard`);
  }
  if (!guard(32, false, 'guard_provider_truncate')) fail.push('private telemetry lacks enabled BEFORE TRUNCATE statement guard');
  if (name === 'provider_attempt') {
    if (!hasKey(name, ['job_id','claim_number'])) fail.push('private telemetry lacks unique job/claim identity');
    if (!hasKey(name, TELEMETRY_IDENTITY)) fail.push('private telemetry lacks unique complete intent identity');
    if (!hasFk(['job_id','owner_id','exam_id','submission_id'], 'jobs', ['id','owner_id','exam_id','submission_id'])) fail.push('private telemetry lacks validated exact job identity FK');
    if (!hasFk(['submission_id','owner_id'], 'submissions', ['id','owner_id'])) fail.push('private telemetry lacks validated exact submission owner FK');
  } else {
    if (!hasFk(TELEMETRY_IDENTITY, 'provider_attempt', TELEMETRY_IDENTITY)) fail.push('private telemetry lacks validated exact intent identity FK');
    if (!hasKey(name, ['attempt_id','revision'])) fail.push('private telemetry lacks unique observation revision');
    const prior = catalogue.foreignKeys.some(fk => bare(fk.table) === name && fk.ref_schema === catalogue.schema
      && fk.validated === true && bare(fk.ref_table) === name
      && colsOf(fk.columns).includes('previous_event_id') && colsOf(fk.columns).includes('attempt_id')
      && colsOf(fk.columns).map((col,index) => col === 'previous_event_id' ? colsOf(fk.ref_columns)[index] === 'event_id'
        : col === colsOf(fk.ref_columns)[index]).every(Boolean)
      && hasKey(name, colsOf(fk.ref_columns)));
    if (!prior) fail.push('private telemetry lacks validated same-intent previous-event FK');
    if (!catalogue.triggers.some(t => bare(t.table) === name && t.name === 'provider_observation_accepted'
      && ['O','A'].includes(t.enabled) && t.type === 5 && t.unconditional && !t.update_columns
      && t.constraint_trigger && t.deferrable && t.initially_deferred
      && t.function_schema === catalogue.schema && t.function_name === 'guard_provider_accepted')) {
      fail.push('private telemetry lacks enabled initially-deferred accepted constraint trigger');
    }
  }
  const access = catalogue.functionAccess || [];
  const fixedPath = f => f.config.split(/,(?=[a-z_]+=)/)
    .some(setting => setting.replace(/["\s]/g, '') === `search_path=pg_catalog,${catalogue.schema}`);
  const requiredFunctions = [
    ['begin_provider_attempt', 'uuid, uuid, jsonb', worker, true],
    ['append_provider_observation', 'uuid, uuid, integer, jsonb, uuid', worker, true],
    ['export_owned_provider_attempts', '', learner, true],
    [fn, '', null, false], ['guard_provider_truncate', '', null, false],
    ...(name === 'provider_attempt_observation' ? [['guard_provider_accepted', '', null, true]] : []),
  ];
  for (const [functionName, args, caller, definer] of requiredFunctions) {
    const records = access.filter(f => f.name === functionName && f.argument_types === args);
    if (!records.length) { fail.push(`private telemetry missing function ${functionName}(${args})`); continue; }
    if (records.some(f => f.owner !== migration)) fail.push(`private telemetry function ${functionName} has wrong owner`);
    if (records.some(f => f.security_definer !== definer)) fail.push(`private telemetry function ${functionName} has wrong security mode`);
    if (definer && records.some(f => !fixedPath(f))) {
      fail.push(`private telemetry function ${functionName} lacks fixed definer authority`);
    }
    if (functionName !== 'export_owned_provider_attempts' && records.some(f => f.volatility !== 'v')) {
      fail.push(`private telemetry function ${functionName} must be VOLATILE`);
    }
    if (caller && !records.some(f => f.grantee === caller && f.privilege === 'EXECUTE')) fail.push(`private telemetry function ${functionName} lacks required EXECUTE`);
  }
  for (const record of access.filter(f => /(^|_)provider_/.test(f.name))) {
    const expected = requiredFunctions.find(([functionName, args]) => record.name === functionName && record.argument_types === args);
    const allowed = [migration, expected?.[2]].filter(Boolean);
    if (!allowed.includes(record.grantee)) fail.push(`private telemetry function ${record.name} grants unexpected EXECUTE to ${record.grantee}`);
    if (record.owner !== migration || (record.security_definer && !fixedPath(record))) fail.push(`private telemetry helper ${record.name} has unsafe authority`);
  }
  return fail;
}

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
 * @param {{roles: object, accountTables?: Array}} options `roles` is the `{migration,auth,learner,worker,deletion[,provisioner]}` map.
 * @returns {{rows: Array, findings: Array, failures: Array, ok: boolean}}
 */
export function classifyCatalogue(catalogue, { roles, accountTables = ACCOUNT_TABLES } = {}) {
  const { auth, learner, worker, migration, deletion, provisioner, payments } = roles;
  const restrictedTo = [learner, worker]; // the roles that must never reach an auth table
  // Every role a running process connects as. `migration` OWNS the schema (implicit owner
  // privileges) and has no runtime route; the fixture has no provisioner, hence filter(Boolean).
  const runtimeRoles = [auth, learner, worker, deletion, provisioner, payments].filter(Boolean);
  const accountSet = accountTableNames(accountTables);
  const classified = new Set([...AUTH_TABLES, ...AUTH_SUPPORT_TABLES, ...CONTENT_TABLES, ...PRIVATE_REVIEW_TABLES, ...CATALOGUE_TABLES,
    ...KEY_TABLES, ...PROTECTED_EXPLANATION_TABLES, ...INFRASTRUCTURE_TABLES]);

  // Private telemetry stays in this ownership graph despite its separate privilege classification.
  // A table is account-owned if it has an owner column, or if it is named in ACCOUNT_TABLES
  // (this is how `drafts`, which has no owner column, is recognised).
  const candidates = catalogue.tables
    .map((t) => t.name)
    .filter((name) => !classified.has(name))
    .filter((name) => columnsOf(catalogue, name).some((c) => OWNER_COLUMNS.includes(c)) || accountSet.has(name));

  const anchors = anchorToUser(catalogue, candidates);
  const rows = [];
  const findings = [];

  const note = (failures) => (failures.length ? 'FAIL' : 'OK');

  if (catalogue.tables.some(table => PRIVATE_TELEMETRY_TABLES.includes(table.name))) {
    for (const name of PRIVATE_TELEMETRY_TABLES) if (!catalogue.tables.some(table => table.name === name)) {
      rows.push({table:name, cls:'private-owned telemetry', verdict:'FAIL', detail:'private telemetry table is missing from the installed pair'});
    }
  }

  for (const table of catalogue.tables) {
    const name = table.name;
    const cols = columnsOf(catalogue, name);
    const fail = [];
    if (PRIVATE_TELEMETRY_TABLES.includes(name)) {
      fail.push(...telemetryRules(catalogue, table, roles, accountSet, anchors));
      rows.push({table:name, cls:'private-owned telemetry', verdict:note(fail),
        detail:fail.length ? fail.join('; ') : 'private worker function writes; exact ownership; owner-scoped deletion; immutable observations'});
      continue;
    }
    if (payments) {
      const allowed = ['payment_product','payment_price','payment_order','payment_checkout_event','payment_event','payment_grant','entitlements','exam_package','user'];
      const granted = privilegesFor(catalogue,name,payments);
      if (!allowed.includes(name) && granted.length) fail.push(`payments role has unexpected access to ${name}`);
      if (name === 'user' && granted.some(p => p !== 'SELECT')) fail.push('payments may only check user existence');
      if (name === 'user' && catalogue.columnGrants.some(g => bare(g.table) === name && g.grantee === payments && g.column !== 'id')) fail.push('payments role may read only user.id');
      if (name === 'entitlements' && catalogue.columnGrants.some(g => bare(g.table) === name && g.grantee === payments && g.privilege === 'UPDATE' && !['allowance','expires_at'].includes(g.column))) fail.push('payments role may update only allowance and expiry');
    }

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

    if (AUTH_SUPPORT_TABLES.includes(name)) {
      // Same shape as the auth rule, but nothing at all outside the auth role: the bucket key can
      // carry an email address (0019), so not even the deletion role may read who tried to sign in.
      if (table.rls || table.force_rls) fail.push(`auth support table must have RLS off (rls=${table.rls}, force=${table.force_rls})`);
      if (!privilegesFor(catalogue, name, auth).length) fail.push('the auth role holds no privilege on this auth support table');
      for (const role of runtimeRoles.filter((r) => r !== auth)) {
        const p = privilegesFor(catalogue, name, role);
        if (p.length) fail.push(`auth support table grants ${p.join('/')} to ${role}`);
      }
      if (cols.some((c) => OWNER_COLUMNS.includes(c))) fail.push('auth support table carries an owner column (that would make it account data)');
      rows.push({ table: name, cls: 'auth support', verdict: note(fail), detail: fail.length ? fail.join('; ') : `no RLS; ${auth} only; no owner column` });
      continue;
    }

    if (PROTECTED_EXPLANATION_TABLES.includes(name)) {
      for (const role of [...runtimeRoles, 'PUBLIC']) {
        const granted = privilegesFor(catalogue, name, role);
        if (granted.length) fail.push(`protected explanation grants ${granted.join('/')} to ${role}`);
      }
      if (name === 'objective_explanation_representation') {
        for (const [event, mask, row] of [['UPDATE', 16, true], ['DELETE', 8, true], ['TRUNCATE', 32, false]]) {
          const guarded = catalogue.triggers.some(t => bare(t.table) === name
            && ['O', 'A'].includes(t.enabled) && (t.type & 2) && Boolean(t.type & 1) === row
            && (t.type & mask) && t.unconditional && !t.update_columns
            && t.function_schema === catalogue.schema
            && t.function_name === (mask === 32 ? 'guard_explanation_truncate' : 'guard_explanation_representation'));
          if (!guarded) fail.push(`no enabled explanation immutability trigger (BEFORE ${event})`);
        }
      }
      if (name === 'objective_explanation_head' && !catalogue.triggers.some(t => bare(t.table) === name
        && ['O','A'].includes(t.enabled) && (t.type & 2) && !(t.type & 1) && (t.type & 32)
        && t.unconditional && t.function_schema === catalogue.schema && t.function_name === 'guard_explanation_truncate')) {
        fail.push('no enabled explanation immutability trigger (BEFORE TRUNCATE)');
      }
      rows.push({ table: name, cls: 'protected explanation', verdict: note(fail),
        detail: fail.length ? fail.join('; ') : 'no runtime/PUBLIC table or column privileges; authorized saved-context reader only' });
      continue;
    }

    if (KEY_TABLES.includes(name)) {
      // The strictest class: no runtime role may hold ANY privilege, SELECT included. Marking reads
      // the key inside a SECURITY DEFINER function owned by the migration role (checked below).
      for (const role of runtimeRoles) {
        const p = privilegesFor(catalogue, name, role);
        if (p.length) fail.push(`answer-key table grants ${p.join('/')} to ${role}`);
      }
      rows.push({ table: name, cls: 'answer key', verdict: note(fail), detail: fail.length ? fail.join('; ') : `no privilege for any runtime role (${runtimeRoles.join('/')}); read only by a SECURITY DEFINER function` });
      continue;
    }

    if (CATALOGUE_TABLES.includes(name)) {
      // Written by migrations only, read by learners. Not account data (no owner column), never a
      // key carrier (no key-shaped column), and no role outside learner/worker reads it.
      for (const role of runtimeRoles) {
        const p = privilegesFor(catalogue, name, role).filter((x) => DML.includes(x));
        if (p.length) fail.push(`catalogue grants ${p.join('/')} to ${role}`);
      }
      const outsiders = [auth, deletion, provisioner].filter(Boolean);
      for (const role of outsiders) {
        const p = privilegesFor(catalogue, name, role).filter((x) => !DML.includes(x));
        if (p.length) fail.push(`catalogue grants ${p.join('/')} to ${role}`);
      }
      if (!privilegesFor(catalogue, name, learner).includes('SELECT')) fail.push(`catalogue is not readable by the learner role (${learner})`);
      if (cols.some((c) => OWNER_COLUMNS.includes(c))) fail.push('catalogue table carries an owner column (that would make it account data)');
      if (isKeyBearing(name, cols)) fail.push('catalogue table carries a key-shaped column (keys belong in an answer-key table)');
      rows.push({ table: name, cls: 'catalogue', verdict: note(fail), detail: fail.length ? fail.join('; ') : `SELECT for ${learner}; no runtime DML; nothing for ${outsiders.join('/')}; no owner or key column` });
      continue;
    }

    if (PRIVATE_REVIEW_TABLES.includes(name)) {
      for (const role of [...runtimeRoles, 'PUBLIC']) {
        const granted = privilegesFor(catalogue, name, role);
        if (granted.length) fail.push(`private editorial grants ${granted.join('/')} to ${role}`);
      }
      // PostgreSQL tgtype bits: ROW=1, BEFORE=2, INSERT=4, DELETE=8, UPDATE=16, TRUNCATE=32.
      // A disabled/replica-only trigger or a similarly named function is not an append-only guard.
      const guard = (event, row, fn) => catalogue.triggers.some(t => bare(t.table) === name
        && ['O', 'A'].includes(t.enabled) && (t.type & 2) && Boolean(t.type & 1) === row
        && (t.type & event) && t.unconditional && !t.update_columns
        && t.function_schema === catalogue.schema && t.function_name === fn);
      for (const [event, mask, row] of [['UPDATE', 16, true], ['DELETE', 8, true], ['TRUNCATE', 32, false]]) {
        if (!guard(mask, row, 'content_immutable')) fail.push(`no enabled immutability trigger (BEFORE ${event})`);
      }
      if (name === 'content_review_baseline' && !guard(4, true, 'sealed_review_baseline')) {
        fail.push('no enabled baseline seal (BEFORE INSERT)');
      }
      rows.push({ table: name, cls: 'private editorial', verdict: note(fail),
        detail: fail.length ? fail.join('; ') : 'no runtime/PUBLIC table or column privileges; enabled UPDATE/DELETE/TRUNCATE immutability' + (name === 'content_review_baseline' ? '; baseline INSERT sealed' : '') });
      continue;
    }

    if (CONTENT_TABLES.includes(name)) {
      // Runtime roles only. `migration` OWNS the schema and every table, so PostgreSQL always
      // reports it holding a/r/w/d — the owner's implicit privileges are not a runtime grant.
      // `provision.mjs` says it plainly: the migration role "has no runtime route".
      const runtime = runtimeRoles;
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
      if (['writing_explanation_representation', 'writing_explanation_head'].includes(name)) {
        for (const [event, mask, row] of [['UPDATE',16,true],['TRUNCATE',32,false]]) {
          const fn = mask === 32 ? 'guard_explanation_truncate' : name.endsWith('_head') ? 'guard_explanation_head' : 'guard_explanation_representation';
          if (!catalogue.triggers.some(t => bare(t.table) === name && ['O','A'].includes(t.enabled)
            && (t.type & 2) && Boolean(t.type & 1) === row && (t.type & mask) && t.unconditional
            && !t.update_columns && t.function_schema === catalogue.schema && t.function_name === fn)) {
            fail.push(`no enabled explanation immutability trigger (BEFORE ${event})`);
          }
        }
        for (const role of [...runtimeRoles, 'PUBLIC']) {
          const allowed = role === learner ? ['SELECT'] : role === worker ? ['SELECT', 'INSERT']
            : role === deletion ? ['SELECT', 'DELETE'] : [];
          const unexpected = privilegesFor(catalogue, name, role).filter(p => !allowed.includes(p));
          if (unexpected.length) fail.push(`owned explanation grants unexpected ${unexpected.join('/')} to ${role}`);
        }
        for (const [role, required] of [[learner, ['SELECT']], [worker, ['SELECT', 'INSERT']]]) {
          for (const privilege of required) if (!privilegesFor(catalogue, name, role).includes(privilege)) {
            fail.push(`owned explanation lacks ${privilege} for ${role}`);
          }
        }
      }
      if (name.startsWith('payment_')) {
        if (name === 'payment_order' && payments && catalogue.columnGrants.some(g => bare(g.table) === name && g.grantee === payments && g.privilege === 'UPDATE' && ['owner_id','exam_id','product_id','market','currency','amount_minor','allowance','term_days','stripe_price_id'].includes(g.column))) fail.push('payments role may not change order identity or terms');
        for (const role of [learner,worker,auth,provisioner].filter(Boolean)) {
          if (privilegesFor(catalogue,name,role).some(p => DML.includes(p))) fail.push(`payment ledger grants mutation to ${role}`);
        }
        if (payments && !privilegesFor(catalogue,name,payments).includes('INSERT')) fail.push('payments role lacks ledger INSERT');
      }
      if (!table.force_rls) fail.push('owned table must FORCE ROW LEVEL SECURITY');
      if (!table.rls) fail.push('owned table must ENABLE ROW LEVEL SECURITY');
      const ownerPolicies = policiesFor(catalogue, name, learner)
        .filter((p) => OWNER_COL_RE.test(`${p.using_expr || ''} ${p.check_expr || ''}`));
      if (!ownerPolicies.length) fail.push(`no owner policy for the learner role (${learner})`);
      if (!accountSet.has(name)) fail.push('owned table is absent from ACCOUNT_TABLES (the deletion read-back would skip it)');
      if (deletion) {
        // The deletion port reads every owned table back as the deletion role. Under FORCE RLS a role
        // with no policy sees zero rows, so without this the read-back passes whether or not rows remain.
        const granted = privilegesFor(catalogue, name, deletion);
        for (const p of ['SELECT', 'DELETE']) if (!granted.includes(p)) fail.push(`the deletion role (${deletion}) lacks ${p}`);
        const deletionPolicies = policiesFor(catalogue, name, deletion)
          .filter((p) => OWNER_COL_RE.test(`${p.using_expr || ''} ${p.check_expr || ''}`));
        if (!deletionPolicies.length) fail.push(`no owner-scoped policy for the deletion role (${deletion}); its read-back would be vacuous`);
      }
      const anchor = anchors.get(name);
      if (!anchor) fail.push('owned table has no FK path to "user"');
      const anchorNote = anchor ? `anchor: ${anchor.kind} FK to "user"${anchor.kind === 'transitive' ? ` via ${anchor.via}` : ''}` : 'anchor: none';
      rows.push({
        table: name, cls: 'owned',
        verdict: note(fail),
        detail: fail.length ? fail.join('; ') : `FORCE RLS; learner owner policy;${deletion ? ' deletion policy + SELECT/DELETE;' : ''} in ACCOUNT_TABLES; ${anchorNote}; owner column ${ownerCol || '(through a parent key)'}`,
      });
      continue;
    }

    fail.push('unclassified table: it is not auth, auth support, owned, shared content, private editorial, catalogue, answer key or the ledger');
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

  /* ---- SECURITY DEFINER functions: the only door to a key table, so the door must be narrow ---- */
  for (const fn of catalogue.definerFunctions || []) {
    const bad = [];
    if (!/(^|,)search_path=/.test(fn.config)) bad.push('search_path is not pinned');
    if (fn.public_execute) bad.push('PUBLIC may execute it');
    rows.push({ table: `function:${fn.name}`, cls: 'definer', verdict: bad.length ? 'FAIL' : 'OK',
      detail: `(${fn.args}) ${bad.length ? bad.join('; ') : `SECURITY DEFINER; ${fn.config}; not executable by PUBLIC`}` });
  }

  /* ---- answer-key rule: asserted even with zero key-bearing tables ---- */
  for (const table of catalogue.tables) {
    const name = table.name;
    if (!isKeyBearing(name, columnsOf(catalogue, name))) continue;
    for (const role of runtimeRoles) {
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
