/**
 * Frozen migration compatibility: only a complete LF <-> CRLF checkout conversion.
 * Offline byte discrimination: node tools/migration-eol-check.mjs
 * Real upgrade proof: add --postgres with explicit OWNAPI_PG_* and OWNAPI_PG_ALLOW=1.
 * PostgreSQL legs create unique eol_check_* schemas/roles and scratch migration copies,
 * never change a tracked SQL file or manually rewrite an applied ledger, then clean up.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checksumOf, migrationChecksumMatches, persistentConfig, createAdminPool } from '../server/owned-postgres/provision.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const lf = Buffer.from("-- Ä, العربية, українська\nSELECT 'preserved';\n");
const crlf = Buffer.from("-- Ä, العربية, українська\r\nSELECT 'preserved';\r\n");
const results = [];
async function check(name, run) {
  try { await run(); results.push(true); console.log(`PASS ${name}`); }
  catch (error) { results.push(false); console.log(`FAIL ${name}: ${error.message}`); }
}

await check('raw hashes stay byte-exact and LF/CRLF hashes remain distinct', () => {
  assert.equal(checksumOf(lf), sha(lf));
  assert.equal(checksumOf(crlf), sha(crlf));
  assert.notEqual(checksumOf(lf), checksumOf(crlf));
  assert.equal(migrationChecksumMatches(lf, sha(lf)), true);
  assert.equal(migrationChecksumMatches(crlf, sha(crlf)), true);
});
await check('legacy LF and legacy CRLF accept only the opposite complete checkout conversion', () => {
  assert.equal(migrationChecksumMatches(lf, sha(crlf)), true);
  assert.equal(migrationChecksumMatches(crlf, sha(lf)), true);
  assert.equal(migrationChecksumMatches(lf, '0'.repeat(64)), false);
});
await check('changed SQL, comment bytes, whitespace, BOM and final-newline changes are refused', () => {
  for (const changed of [
    lf.toString().replace('preserved', 'changed'),
    lf.toString().replace('-- ', '-- changed '),
    lf.toString().replace('SELECT ', 'SELECT  '),
    lf.toString().replace(';\n', '; \n'),
    '\ufeff' + lf.toString(),
    lf.toString().slice(0, -1),
    lf.toString() + '\n',
  ]) {
    assert.equal(migrationChecksumMatches(Buffer.from(changed), sha(lf)), false);
    assert.equal(migrationChecksumMatches(Buffer.from(changed.replaceAll('\n', '\r\n')), sha(lf)), false);
    assert.equal(migrationChecksumMatches(Buffer.from(changed), sha(crlf)), false);
  }
});
await check('mixed endings and bare CR are not accepted through compatibility', () => {
  const mixed = Buffer.from(lf.toString().replace('\n', '\r\n'));
  const bare = Buffer.from(lf.toString().replace('\n', '\r'));
  for (const bytes of [mixed, bare]) {
    assert.equal(migrationChecksumMatches(bytes, sha(lf)), false);
    assert.equal(migrationChecksumMatches(bytes, sha(crlf)), false);
    assert.equal(migrationChecksumMatches(lf, sha(bytes)), false);
    assert.equal(migrationChecksumMatches(crlf, sha(bytes)), false);
    assert.equal(migrationChecksumMatches(bytes, sha(bytes)), true, 'an exact raw match remains valid');
  }
});
await check('compatibility preserves arbitrary non-newline bytes without text decoding', () => {
  const a = Buffer.from([0xff, 0x80, 0x00, 0x0a, 0xfe]);
  const b = Buffer.from([0xff, 0x80, 0x00, 0x0d, 0x0a, 0xfe]);
  assert.equal(migrationChecksumMatches(a, sha(b)), true);
  assert.equal(migrationChecksumMatches(b, sha(a)), true);
  assert.equal(migrationChecksumMatches(Buffer.from(a.toString('utf8')), sha(b)), false);
});

function migrate(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server/migrate.mjs'], { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

async function upgradeProof(from, to) {
  const schema = `eol_check_${randomBytes(6).toString('hex')}`;
  const config = persistentConfig({ ...process.env, OWNAPI_PG_SCHEMA: schema, OWNAPI_PG_ROLE_PREFIX: schema });
  const admin = createAdminPool(config);
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'hatoove-eol-check-'));
  const legacyDir = path.join(scratch, 'legacy');
  const nextDir = path.join(scratch, 'next');
  const sourceDir = path.join(root, 'server', 'migrations');
  const env = { OWNAPI_PG_SCHEMA: schema, OWNAPI_PG_ROLE_PREFIX: schema };
  const ending = (bytes, kind) => {
    const text = bytes.toString('latin1').replaceAll('\r\n', '\n');
    assert.ok(!text.includes('\r'), 'fixture source must have no bare CR');
    return Buffer.from(kind === 'LF' ? text : text.replaceAll('\n', '\r\n'), 'latin1');
  };
  try {
    await fs.mkdir(legacyDir); await fs.mkdir(nextDir);
    const files = (await fs.readdir(sourceDir)).filter(name => /^\d{4}-.*\.sql$/.test(name)).sort();
    assert.ok(files.length > 1);
    const head = files.at(-1);
    for (const name of files) {
      const bytes = await fs.readFile(path.join(sourceDir, name));
      if (name !== head) await fs.writeFile(path.join(legacyDir, name), ending(bytes, from));
      await fs.writeFile(path.join(nextDir, name), ending(bytes, to));
    }
    const first = await migrate({ ...env, OWNAPI_MIGRATIONS_DIR: legacyDir });
    assert.equal(first.code, 0, `legacy install: ${first.output.slice(-1200)}`);
    const ledger = async () => (await admin.query(`SELECT id, checksum, applied_at FROM "${schema}".hatoove_migrations ORDER BY id`)).rows;
    const before = await ledger();
    assert.equal(before.length, files.length - 1);
    for (const row of before) assert.equal(row.checksum, sha(await fs.readFile(path.join(legacyDir, row.id + '.sql'))));
    await admin.query(`CREATE TABLE "${schema}".eol_keep (id integer PRIMARY KEY, payload text NOT NULL)`);
    await admin.query(`INSERT INTO "${schema}".eol_keep VALUES (1, $1)`, ['synthetic row: Ä / العربية / українська']);
    const saved = async () => (await admin.query(`SELECT * FROM "${schema}".eol_keep ORDER BY id`)).rows;
    const savedBefore = await saved();
    const next = await migrate({ ...env, OWNAPI_MIGRATIONS_DIR: nextDir });
    assert.equal(next.code, 0, `opposite checkout upgrade: ${next.output.slice(-1200)}`);
    assert.match(next.output, /applied=1\b/);
    const after = await ledger();
    assert.deepEqual(after.filter(row => row.id !== head.slice(0, -4)), before, 'old checksums and timestamps must stay untouched');
    assert.equal(after.find(row => row.id === head.slice(0, -4)).checksum, sha(await fs.readFile(path.join(nextDir, head))), 'new head records its actual raw bytes');
    assert.deepEqual(await saved(), savedBefore, 'saved rows survive the upgrade');

    const target = path.join(nextDir, '0009-exam-scope.sql');
    const original = await fs.readFile(target);
    const changed = Buffer.from(original);
    const at = changed.indexOf(Buffer.from('SELECT'));
    assert.ok(at >= 0, 'real SQL mutation anchor exists');
    changed[at] = 0x58; // SELECT -> XELECT: a substantive change must fail before execution
    await fs.writeFile(target, changed);
    const refused = await migrate({ ...env, OWNAPI_MIGRATIONS_DIR: nextDir });
    assert.notEqual(refused.code, 0);
    assert.match(refused.output, /checksum mismatch for migration 0009-exam-scope/);
    assert.deepEqual(await ledger(), after, 'refusal must not rewrite the ledger');
    assert.deepEqual(await saved(), savedBefore, 'refusal must preserve saved rows');
    await fs.writeFile(target, original);
    const restored = await migrate({ ...env, OWNAPI_MIGRATIONS_DIR: nextDir });
    assert.equal(restored.code, 0, `restored checkout: ${restored.output.slice(-1200)}`);
    assert.match(restored.output, /applied=0\b/);
    assert.deepEqual(await ledger(), after);
  } finally {
    // Only this run's random, identifier-validated schema/roles and temp directory are removed.
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    for (const role of Object.values(config.roles)) {
      const exists = (await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role])).rowCount;
      if (!exists) continue;
      await admin.query(`DROP OWNED BY "${role}"`);
      await admin.query(`DROP ROLE "${role}"`);
    }
    await admin.end();
    assert.equal(path.dirname(path.resolve(scratch)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(scratch).startsWith('hatoove-eol-check-'));
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv.includes('--postgres')) {
  assert.equal(process.env.OWNAPI_PG_ALLOW, '1', 'confirm an explicitly disposable database with OWNAPI_PG_ALLOW=1');
  for (const key of ['OWNAPI_PG_HOST', 'OWNAPI_PG_PORT', 'OWNAPI_PG_DATABASE', 'OWNAPI_PG_USER']) assert.ok(process.env[key], `${key} is required`);
  assert.ok(!['postgres', 'template0', 'template1'].includes(process.env.OWNAPI_PG_DATABASE));
  assert.notEqual(process.env.OWNAPI_PG_PORT, '55440', 'refuse the learner installation port');
  await check('PostgreSQL: legacy LF ledger upgrades from CRLF checkout; changed SQL refused, records preserved', () => upgradeProof('LF', 'CRLF'));
  await check('PostgreSQL: legacy CRLF ledger upgrades from LF checkout; changed SQL refused, records preserved', () => upgradeProof('CRLF', 'LF'));
}

const passed = results.filter(Boolean).length;
console.log(`\n${passed} passed, ${results.length - passed} failed`);
process.exitCode = passed === results.length ? 0 : 1;
