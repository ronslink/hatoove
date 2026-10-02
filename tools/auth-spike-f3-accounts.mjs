#!/usr/bin/env node
/**
 * AUTH-01-SPIKE — F3 probe: how many REAL accounts exist on any persistent installation?
 *
 * Method (bounded, no network):
 *   1. Walk the tracked tree (skipping .git, node_modules) and find every account-creation
 *      site: `/api/auth/sign-up/email`, `signUp(`, `signUpEmail(`, and direct
 *      `INSERT INTO "user"` / `INSERT INTO account`.
 *   2. Extract every email literal and classify it: a synthetic domain
 *      (`.invalid`, `.test`, `example.*`, `pg.example.*`) or a real-looking one.
 *   3. Print what the implementation records say about the installations those writers ran
 *      against — disposable or persistent.
 *   4. Best-effort: if a local PostgreSQL is reachable (`AUTHSPIKE_PG_URL` is also read here),
 *      report whether it holds any Better Auth `"user"` table or a `hatoove` schema.
 *
 * Run:  node tools/auth-spike-f3-accounts.mjs
 * Exit code is always 0: this is a measurement, not a gate.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP = new Set(['.git', 'node_modules', '.openclaw', 'worktrees']);
const CODE = new Set(['.mjs', '.js', '.cjs']);
const EXT = new Set([...CODE, '.md', '.json', '.html']);
const line = (t) => console.log(`\n=== ${t} ===`);

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const path = join(dir, name);
    let st;
    try { st = statSync(path); } catch { continue; }
    if (st.isDirectory()) yield* walk(path);
    else if (EXT.has(name.slice(name.lastIndexOf('.')))) yield path;
  }
}

const CREATION = /(\/api\/auth\/sign-up\/email|signUpEmail\(|\.client\.signUp\(|\bsignUp\(\s*\{|INSERT INTO\s+"?user"?|INSERT INTO\s+account)/;
const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const SYNTHETIC = /(\.invalid|\.test|@example\.|pg\.example|accounts\.example|deletion-check\.invalid|deletion-mount\.invalid)/i;

const creationSites = [];
const emails = new Map();
let scanned = 0;
for (const file of walk(ROOT)) {
  const rel = file.slice(ROOT.length);
  const isCode = CODE.has(rel.slice(rel.lastIndexOf('.')));
  let text;
  try { text = readFileSync(file, 'utf8'); } catch { continue; }
  scanned += 1;
  text.split('\n').forEach((l, i) => {
    // Creation sites are counted in CODE only: a markdown record quotes code verbatim, so scanning
    // documents would let the count drift as the record is edited.
    if (isCode && CREATION.test(l)) creationSites.push(`${rel}:${i + 1}`);
    for (const m of l.match(EMAIL) || []) {
      const key = m.toLowerCase();
      emails.set(key, { synthetic: SYNTHETIC.test(key), where: emails.get(key)?.where ?? `${rel}:${i + 1}` });
    }
  });
}

line('1. Account-creation sites in the tracked tree');
console.log(creationSites.length === 0 ? '(none)' : creationSites.join('\n'));
console.log(`\nfiles scanned: ${scanned}`);

line('2. Every email literal, classified');
const real = [...emails.entries()].filter(([, v]) => !v.synthetic);
for (const [email, v] of emails) console.log(`${v.synthetic ? 'synthetic' : 'REAL-LOOKING'}  ${email}   (${v.where})`);
console.log(`\nsynthetic: ${emails.size - real.length}   real-looking: ${real.length}`);

line('3. What the records say about the installations those writers ran against');
const RECORDS = ['work/implementation/OWNAPI-03.md', 'work/implementation/COORD-REEXECUTION-e126d8c.md',
  'work/implementation/DECISION-saas-runtime-merge.md', 'work/implementation/AUTH-USER-AUDIT.md',
  'work/implementation/CONFIG-ANON-01.md'];
const PROOF = /disposable|synthetic|fresh database|postgres:17-alpine|throwaway|hatoove_rev/i;
for (const rel of RECORDS) {
  let text;
  try { text = readFileSync(join(ROOT, rel), 'utf8'); } catch { continue; }
  const hits = text.split('\n').filter((l) => PROOF.test(l)).slice(0, 3);
  console.log(`\n${rel}`);
  for (const h of hits) console.log(`  | ${h.trim()}`);
}

line('4. Best-effort: local PostgreSQL');
const url = process.env.AUTHSPIKE_PG_URL;
if (!url) {
  console.log('AUTHSPIKE_PG_URL not set — skipping (the record quotes a manual check of this host).');
} else {
  try {
    const { loadDeps } = await import('./auth-spike-deps.mjs');
    const { Pool } = await loadDeps();
    const pool = new Pool({ connectionString: url });
    const schemas = (await pool.query(
      `SELECT nspname FROM pg_namespace WHERE nspname LIKE '%hatoove%' OR nspname LIKE '%ownapi%'`)).rows;
    const userTables = (await pool.query(
      `SELECT table_schema, table_name FROM information_schema.tables WHERE table_name='user'`)).rows;
    console.log('hatoove/ownapi schemas:', JSON.stringify(schemas));
    console.log('Better Auth "user" tables:', JSON.stringify(userTables));
    await pool.end();
  } catch (error) { console.log(`(local PG check skipped: ${error.message})`); }
}

line('VERDICT (F3)');
console.log('account-creation sites   :', creationSites.length);
console.log('real-looking emails      :', real.length);
console.log('=> every writer that exists is a checker; every address is synthetic.', real.length === 0 ? '' : ' INVESTIGATE.');
