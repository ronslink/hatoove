/**
 * The shared catalogue reader (MFP-14).
 *
 * One place that turns a provisioned PostgreSQL app schema into the facts a checker needs:
 * every table, its owner column, its policies, its grants (table and column level), its
 * foreign keys, its triggers, the roles that hold anything in the schema, and whether the
 * migration ledger records a checksum.
 *
 * It is deliberately **read-only**: it issues catalog SELECTs and nothing else, so it can be
 * pointed at a disposable installation, a scratch schema built by `bootstrap.mjs`, or (read
 * only) a real one. It never imports `pg`; the caller passes any object with a
 * `query(sql, params)` method (a `pg` Pool or Client).
 *
 * `tools/table-class-check.mjs` consumes it today. MFP-09's export leg reuses it so the export
 * route and the class check agree on what "an owned table" is: if a migration adds an owned
 * table that the export forgets, the same catalogue tells both.
 */

/** Better Auth's tables (the pinned library's schema). No RLS; the auth role only. */
export const AUTH_TABLES = Object.freeze(['user', 'session', 'account', 'verification']);

/** Auth-seam state that is not Better Auth's own schema: the sign-in/sign-up throttle (`0019`).
 *  Its bucket keys can carry an email address, so it is held to the auth rule — the auth role
 *  only — and additionally nothing for the deletion or provisioner roles. */
export const AUTH_SUPPORT_TABLES = Object.freeze(['auth_throttle']);

/**
 * The append-only shared content records: the versioned records (#82 migration `0006`) and the
 * rights DECISIONS about them (`0020`, guarded by the same `content_immutable` function).
 * Immutable by trigger; no runtime DML.
 */
export const CONTENT_TABLES = Object.freeze(['content_version', 'rubric_version', 'task_version', 'content_rights',
  'exam_media','exam_blueprint','exam_release','exam_form','exam_form_member','exam_release_form']);

/** Private editorial facts: immutable review identities/evidence, never readable by runtime roles. */
export const PRIVATE_REVIEW_TABLES = Object.freeze([
  'content_review_authority', 'content_review_decision', 'content_review_baseline',
]);

/** Private account-owned operational facts: safe export goes through a definer projection. */
export const PRIVATE_TELEMETRY_TABLES = Object.freeze([
  'provider_attempt', 'provider_attempt_observation',
]);

/**
 * The migration-seeded reference catalogue (`0009`-`0014`): exam packages, objective sets (the
 * LEARNER side — answers live in `objective_key`), vocabulary, nouns and guides. Written only by
 * migrations, served to learners: SELECT for the learner role, no runtime DML, nothing for the
 * auth/deletion/provisioner roles, no owner column and no key-shaped column.
 */
export const CATALOGUE_TABLES = Object.freeze([
  'exam_package', 'objective_set', 'vocab_entry', 'noun_entry', 'guide', 'guide_section',
  'exam_release_head',
  'payment_product', 'payment_price',
]);

/**
 * Answer-key tables (`0010`). NO runtime role holds ANY privilege on them; marking reads the key
 * inside the SECURITY DEFINER `mark_objective_item` (`0015`), which runs as the table owner.
 */
export const KEY_TABLES = Object.freeze(['objective_key']);

/** Shared saved explanations are reachable only through context-authorized definer readers. */
export const PROTECTED_EXPLANATION_TABLES = Object.freeze([
  'objective_explanation_representation', 'objective_explanation_head',
]);

/**
 * Tables that are neither account rows nor shared content: the migration ledger itself.
 * Named explicitly so "an unclassified table fails" stays true for every *other* table, while
 * the ledger (which no learner row ever lives in) is checked on its own terms.
 */
export const INFRASTRUCTURE_TABLES = Object.freeze(['hatoove_migrations']);

/** A table name is normalised by stripping the double quotes `ACCOUNT_TABLES` uses for `"user"`. */
export const bare = (name) => String(name).replaceAll('"', '');

/** Normalise `ACCOUNT_TABLES` (entries `[table, predicate, bind]`) into a Set of bare names. */
export function accountTableNames(accountTables) {
  return new Set(accountTables.map(([table]) => bare(table)));
}

/** Columns that make a table account-owned by itself. */
export const OWNER_COLUMNS = Object.freeze(['owner_id', 'user_id']);

/**
 * A table name that holds answer keys. The rule ("no SELECT to a runtime role") is asserted
 * even when zero such tables exist, so the day one is added it is caught. `task_key` is the
 * table MFP-13 will add; the rest are the shapes an answer-key table takes.
 */
const KEY_TABLE_RE = /(^|_)(task_key|answer_key|answer_keys|keys?)$/i;
const keyTable = (name) => KEY_TABLE_RE.test(name);

/** Is a table (or column) key-bearing, by name or by column? Used for the no-SELECT rule. */
export function isKeyBearing(table, columns = []) {
  if (keyTable(table)) return true;
  return columns.some((c) => /^(answer_key|correct_answer|answers|solution)$/i.test(c));
}

/* ------------------------------------------------------------------ queries */

const q = async (db, sql, params = []) => (await db.query(sql, params)).rows;

/** Every base table in the schema with its RLS flags. */
export async function readTables(db, schema) {
  return q(db, `
    SELECT c.relname AS name, c.relrowsecurity AS rls, c.relforcerowsecurity AS force_rls
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND c.relkind = 'r'
    ORDER BY c.relname`, [schema]);
}

/** Every column of every base table (name + type). */
export async function readColumns(db, schema) {
  return q(db, `
    SELECT c.relname AS table, a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type,
           NOT a.attnotnull AS nullable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE n.nspname = $1 AND c.relkind = 'r'
    ORDER BY c.relname, a.attnum`, [schema]);
}

/** Policies with their roles flattened to a comma string (node-pg returns `name[]` awkwardly). */
export async function readPolicies(db, schema) {
  return q(db, `
    SELECT tablename AS table, policyname AS policy, array_to_string(roles, ',') AS roles, cmd, permissive,
           qual AS using_expr, with_check AS check_expr
    FROM pg_policies WHERE schemaname = $1 ORDER BY tablename, policyname`, [schema]);
}

/** Table-level grants, including PUBLIC (role_table_grants omits those). */
export async function readTableGrants(db, schema) {
  return q(db, `
    SELECT table_name AS table, grantee, privilege_type AS privilege
    FROM information_schema.table_privileges WHERE table_schema = $1
    ORDER BY table_name, grantee, privilege_type`, [schema]);
}

/** Column-level grants, including PUBLIC and details such as `GRANT UPDATE(deleted_at) …`. */
export async function readColumnGrants(db, schema) {
  return q(db, `
    SELECT table_name AS table, column_name AS column, grantee, privilege_type AS privilege
    FROM information_schema.column_privileges WHERE table_schema = $1
    ORDER BY table_name, column_name, grantee, privilege_type`, [schema]);
}

/** Foreign keys, with the constrained and referenced column lists. */
export async function readForeignKeys(db, schema) {
  return q(db, `
    SELECT c.relname AS table, con.conname AS name,
           array_to_string((SELECT array_agg(att.attname ORDER BY k.ord)
              FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum), ',') AS columns,
           rc.relname AS ref_table, rn.nspname AS ref_schema,
           con.convalidated AS validated,
           array_to_string((SELECT array_agg(att.attname ORDER BY k.ord)
              FROM unnest(con.confkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute att ON att.attrelid = con.confrelid AND att.attnum = k.attnum), ',') AS ref_columns
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_class rc ON rc.oid = con.confrelid
    JOIN pg_namespace rn ON rn.oid = rc.relnamespace
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype = 'f' AND n.nspname = $1
    ORDER BY c.relname, con.conname`, [schema]);
}

/** Primary-key and unique constraint column sets, so an FK can be checked against a real key. */
export async function readUniqueKeys(db, schema) {
  return q(db, `
    SELECT c.relname AS table, con.contype AS kind,
           array_to_string((SELECT array_agg(att.attname ORDER BY k.ord)
              FROM unnest(con.conkey) WITH ORDINALITY k(attnum, ord)
              JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = k.attnum), ',') AS columns
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE con.contype IN ('p', 'u') AND n.nspname = $1
    ORDER BY c.relname, con.conname`, [schema]);
}

/** Non-internal triggers with their full definition. */
export async function readTriggers(db, schema) {
  return q(db, `
    SELECT c.relname AS table, t.tgname AS name, pg_get_triggerdef(t.oid) AS def,
           t.tgenabled AS enabled, t.tgtype::integer AS type,
           t.tgattr::text AS update_columns, t.tgqual IS NULL AS unconditional,
           p.proname AS function_name, pn.nspname AS function_schema,
           t.tgdeferrable AS deferrable, t.tginitdeferred AS initially_deferred,
           t.tgconstraint <> 0 AS constraint_trigger
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    JOIN pg_namespace pn ON pn.oid = p.pronamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal
    ORDER BY c.relname, t.tgname`, [schema]);
}

/** Every role that holds a table, column or schema privilege here (the candidate "runtime roles"). */
export async function readGranteeRoles(db, schema) {
  return (await q(db, `
    SELECT DISTINCT grantee AS role FROM information_schema.role_table_grants
      WHERE table_schema = $1 AND grantee <> 'PUBLIC'
    UNION SELECT DISTINCT grantee FROM information_schema.role_column_grants
      WHERE table_schema = $1 AND grantee <> 'PUBLIC'
    UNION SELECT DISTINCT grantee FROM information_schema.role_usage_grants
      WHERE object_schema = $1 AND grantee <> 'PUBLIC'
    ORDER BY role`, [schema])).map((row) => row.role);
}

/**
 * SECURITY DEFINER functions in the schema: whether `search_path` is pinned, and whether PUBLIC
 * (grantee oid 0, including the implicit default ACL) may execute them.
 */
export async function readDefinerFunctions(db, schema) {
  return q(db, `
    SELECT p.proname AS name, pg_get_function_identity_arguments(p.oid) AS args,
           coalesce(array_to_string(p.proconfig, ','), '') AS config,
           EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                    WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_execute
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = $1 AND p.prosecdef
    ORDER BY p.proname`, [schema]);
}

/** Exact function identity and ACLs, including implicit PUBLIC EXECUTE and column-free helpers. */
export async function readFunctionAccess(db, schema) {
  return q(db, `
    SELECT p.proname AS name, oidvectortypes(p.proargtypes) AS argument_types,
           pg_get_userbyid(p.proowner) AS owner, p.prosecdef AS security_definer,
           p.provolatile AS volatility, coalesce(array_to_string(p.proconfig, ','), '') AS config,
           CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee,
           a.privilege_type AS privilege
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
    WHERE n.nspname = $1
    ORDER BY p.proname, argument_types, grantee`, [schema]);
}

/** Role attributes for the named roles (`rolsuper`, `rolbypassrls`, …). */
export async function readRoleAttributes(db, roles) {
  if (!roles.length) return [];
  return q(db, `
    SELECT rolname AS role, rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole
    FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname`, [roles]);
}

/** The migration ledger's columns, or null when the schema has no ledger (a disposable fixture). */
export async function readLedger(db, schema) {
  const columns = (await q(db, `
    SELECT column_name AS column FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'hatoove_migrations'`, [schema])).map((r) => r.column);
  if (!columns.length) return null;
  return { columns, checksumColumn: columns.find((c) => /(checksum|sha256|sha_256|hash)/i.test(c)) || null };
}

/* --------------------------------------------------------------- aggregate */

/** Read the whole catalogue in one call. */
export async function readCatalogue(db, { schema }) {
  const [tables, columns, policies, tableGrants, columnGrants, foreignKeys, uniqueKeys, triggers, granteeRoles, ledger, definerFunctions, functionAccess] =
    await Promise.all([
      readTables(db, schema), readColumns(db, schema), readPolicies(db, schema),
      readTableGrants(db, schema), readColumnGrants(db, schema), readForeignKeys(db, schema),
      readUniqueKeys(db, schema), readTriggers(db, schema), readGranteeRoles(db, schema), readLedger(db, schema),
      readDefinerFunctions(db, schema), readFunctionAccess(db, schema),
    ]);
  const roleAttributes = await readRoleAttributes(db, granteeRoles);
  return { schema, tables, columns, policies, tableGrants, columnGrants, foreignKeys, uniqueKeys, triggers, granteeRoles, roleAttributes, ledger, definerFunctions, functionAccess };
}

/* -------------------------------------------------------------- selectors */

/** Columns of a table, from the catalogue. */
export const columnsOf = (catalogue, table) =>
  catalogue.columns.filter((c) => c.table === table).map((c) => c.column);

/** Policies on a table whose roles include `role` or `public` (a policy TO public applies to all). */
export const policiesFor = (catalogue, table, role) =>
  catalogue.policies.filter((p) => p.table === table
    && (p.roles.split(',').map((r) => r.trim()).includes(role) || p.roles.split(',').map((r) => r.trim()).includes('public')));

/** All privileges (table- and column-level) held by `role` on `table`. */
export const privilegesFor = (catalogue, table, role) => {
  const tableLevel = catalogue.tableGrants.filter((g) => g.table === table && g.grantee === role).map((g) => g.privilege);
  const columnLevel = catalogue.columnGrants.filter((g) => g.table === table && g.grantee === role).map((g) => g.privilege);
  return [...new Set([...tableLevel, ...columnLevel])];
};

export { q as queryRows };
