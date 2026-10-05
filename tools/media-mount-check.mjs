#!/usr/bin/env node
/**
 * MEDIA-MOUNT-01 — the listening recordings must resolve under a MOUNTED, verified root.
 *
 * WHY THIS EXISTS. The nine telc B1 listening WAVs referenced by
 * `content/exams/telc-deutsch-b1/listening-package.json` are ~44 MB of generated audio. Until this slice they
 * lived ONLY in the deployed image layer (a `COPY content/exams/` at build time) and in `.qa/` recovery
 * material that the workspace rules keep out of commits. Nothing verified them before a learner pressed play:
 * a missing or shadowed root answered `media_unavailable`/404 at that moment and nowhere earlier. `compose.yaml`
 * now mounts the recordings read-only at the path `readMediaBytes` expects, and this check is the loud signal —
 * `docker compose up` runs it as the `media` service and the API does not start unless it exits 0.
 *
 * WHAT IT PROVES, against whatever root it is given:
 *   1. every recording referenced by a tracked exam package resolves through the SHIPPED reader
 *      (`readMediaBytes`: symlink refusal, path confinement, byte length, sha256, PCM duration) — real bytes,
 *      not a fixture;
 *   2. the shipped framing answers correctly for those bytes (`mediaResponse`: 200 `audio/wav`, sha-pinned
 *      etag, `accept-ranges`, `content-length`, a 206 range, HEAD, and a 416 for an unsatisfiable range);
 *   3. a root that does NOT hold a referenced recording answers `media_unavailable` through the same reader —
 *      the missing-file half, and it names the file;
 *   4. `--require-recordings` exits 1 and names every missing file, which is the startup gate;
 *   5. a **git-LFS pointer file** is reported AS a pointer ("run `git lfs pull`"), never as `media_integrity`:
 *      the file is intact, the bytes were simply never fetched, and the two need different operator actions;
 *   6. it PRINTS the physical root it used, so "where do the bytes come from" is answered by running it.
 *
 * Usage:
 *   node tools/media-mount-check.mjs                      # verify the default/overridden root, print the root
 *   node tools/media-mount-check.mjs --require-recordings  # the startup gate: any missing file => exit 1
 *   node tools/media-mount-check.mjs --media-root /srv/hatoove/media/telc-deutsch-b1/audio
 *
 * It reads the filesystem only: no database, no network, no server. That is deliberate — it must be runnable
 * inside the built image (the `media` compose service does exactly that) before any service is up.
 */
import assert from 'node:assert/strict';
import { readFile, readdir, realpath, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultMediaRoot, readMediaBytes } from '../server/media-contract.mjs';
import { mediaResponse } from '../server/media-route.mjs';

const args = process.argv.slice(2);
const flagOf = (name) => args.includes(name);
const valueOf = (name) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const known = new Set(['--require-recordings', '--media-root', '--help']);
for (const argument of args) {
  if (argument.startsWith('--') && !known.has(argument)) throw new Error(`usage: node tools/media-mount-check.mjs [--require-recordings] [--media-root <dir>] (unknown: ${argument})`);
}
if (flagOf('--help')) { console.log('usage: node tools/media-mount-check.mjs [--require-recordings] [--media-root <dir>]'); process.exit(0); }

/*
 * The root under test is THE ONE THE API WILL USE: `defaultMediaRoot()` is the same function
 * `readMediaBytes` calls, so this gate cannot check a different directory than the server reads. It resolves
 * `B1PREP_MEDIA_ROOT` per call, falling back to `<repo>/content/exams/`.
 */
const REPO = fileURLToPath(new URL('../', import.meta.url));
const mediaRoot = valueOf('--media-root') ? path.resolve(valueOf('--media-root')) : defaultMediaRoot();
const requireRecordings = flagOf('--require-recordings');

const results = [];
const check = async (name, run) => {
  try { const detail = await run(); results.push(true); console.log(`PASS ${name}${detail ? `  [${detail}]` : ''}`); }
  catch (error) { results.push(false); console.log(`FAIL ${name}: ${error.message}`); }
};

/** Every media descriptor in every tracked exam JSON, de-duplicated by the FILE it names. */
async function referencedRecordings() {
  const examDir = path.join(REPO, 'content', 'exams');
  const byPath = new Map();
  let descriptors = 0;
  const walk = async (dir) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const location = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(location); continue; }
      if (!entry.name.endsWith('.json')) continue;
      let parsed;
      try { parsed = JSON.parse(await readFile(location, 'utf8')); } catch { continue; }
      const rows = Array.isArray(parsed?.media) ? parsed.media : [];
      for (const row of rows) {
        if (!row || typeof row.path !== 'string') continue;
        descriptors += 1;
        // `listening-package.json` and `listening-media.json` both describe the same nine files; read each once.
        if (!byPath.has(row.path)) byPath.set(row.path, { row, packagePath: path.relative(REPO, location) });
      }
    }
  };
  await walk(examDir);
  return { recordings: [...byPath.values()], descriptors };
}

const { recordings, descriptors } = await referencedRecordings();
if (!recordings.length) throw new Error(`no media descriptors found under ${path.relative(REPO, path.join(REPO, 'content', 'exams'))}`);

console.log(`Media root under test: ${mediaRoot}`);
console.log(`  rule: ${valueOf('--media-root') ? '--media-root' : process.env.B1PREP_MEDIA_ROOT ? 'B1PREP_MEDIA_ROOT' : 'default <repo>/content/exams'}`);
let rootDetail = 'absent';
try { rootDetail = `${await realpath(mediaRoot)}`; } catch { /* reported as absent below */ }
console.log(`  resolved: ${rootDetail}`);
console.log(`  referenced recordings: ${recordings.length} distinct file(s) from ${descriptors} descriptor(s)`);

/* ---------------------------------------------------------------- 1. every referenced recording resolves */

const missing = [];
const served = [];

/**
 * MEDIA-MOUNT-01 — THE GIT-LFS POINTER GUARD (Ron's decision, 5 Oct 2026: the recordings are tracked plain).
 *
 * If the recordings were ever moved to Git LFS, a checkout WITHOUT `git-lfs` produces ~130-byte pointer files
 * instead of audio. Those fail the reader's byte-length check, i.e. they surface as `media_integrity` —
 * "invalid media", a corrupted-audio story — when the truth is "the bytes were never fetched". The two need
 * different operator actions, so this recognises the pointer BEFORE the reader and says exactly what to do.
 */
async function lfsPointerAt(mediaPath) {
  const file = path.join(mediaRoot, ...mediaPath.slice('content/exams/'.length).split('/'));
  let handle;
  try {
    handle = await open(file, 'r');
    const head = Buffer.alloc(200);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const text = head.subarray(0, bytesRead).toString('utf8');
    return /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/.test(text) ? text.split(/\r?\n/)[0] : null;
  } catch { return null; } finally { await handle?.close().catch(() => {}); }
}

await check('every referenced recording resolves through the shipped reader on this root', async () => {
  for (const { row, packagePath } of recordings) {
    const pointer = await lfsPointerAt(row.path);
    if (pointer) {
      // Deliberately NOT `media_integrity`: the file is fine, the bytes were never fetched.
      missing.push({ row, packagePath, code: 'git_lfs_pointer', pointer,
        message: 'this is a git-LFS pointer file, not audio — run `git lfs pull` and re-run' });
      continue;
    }
    try {
      const bytes = await readMediaBytes(row, { mediaRoot });
      assert.equal(bytes.length, row.byteLength, `${row.mediaId} byte length`);
      served.push({ row, bytes, packagePath });
    } catch (error) {
      missing.push({ row, packagePath, code: error.code ?? 'error', message: error.message });
    }
  }
  assert.equal(missing.length, 0, `${missing.length} recording(s) unavailable: ${missing.map((entry) => `${entry.row.path} (${entry.code})`).join(', ')}`);
  return `${served.length} recording(s), ${Math.round(served.reduce((total, entry) => total + entry.bytes.length, 0) / 1048576)} MB read and checksum-verified`;
});

/* ---------------------------------------------------------------- 2. the shipped framing answers for them */

await check('the shipped framing serves those bytes (content-type, etag, range, HEAD, 416)', async () => {
  const { row, bytes } = served[0] ?? {};
  assert.ok(bytes, 'a served recording is needed for the framing leg');
  const full = mediaResponse(bytes, row);
  assert.equal(full.status, 200);
  assert.equal(full.headers['content-type'], 'audio/wav');
  assert.equal(full.headers.etag, `"sha256-${row.sha256}"`);
  assert.equal(full.headers['accept-ranges'], 'bytes');
  assert.equal(full.headers['content-length'], String(row.byteLength));
  assert.equal(full.body.length, row.byteLength);
  const ranged = mediaResponse(bytes, row, { range: 'bytes=0-1023' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-range'], `bytes 0-1023/${row.byteLength}`);
  assert.equal(ranged.body.length, 1024);
  const head = mediaResponse(bytes, row, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.body.length, 0);
  assert.equal(mediaResponse(bytes, row, { range: `bytes=${row.byteLength + 10}-` }).status, 416);
  return `${row.mediaId} 200/206/HEAD/416 as shipped`;
});

/* ---------------------------------------------------------------- 3. a root without the bytes refuses, loudly */

await check('a root that does not hold a referenced recording answers media_unavailable', async () => {
  const { row } = recordings[0];
  const empty = path.join(REPO, 'content', 'exams', '.media-mount-check-empty');
  await assert.rejects(
    () => readMediaBytes(row, { mediaRoot: empty }),
    (error) => error.code === 'media_unavailable',
    `${row.path} must fail as media_unavailable from a root without it`);
  return `${row.mediaId} -> media_unavailable (no bytes, no path disclosure)`;
});

/* ---------------------------------------------------------------- 4. the startup gate */

if (requireRecordings) {
  for (const entry of missing.filter((item) => item.code === 'git_lfs_pointer')) {
    console.log(`  GIT-LFS POINTER ${entry.row.path}\n    this is not audio (${JSON.stringify(entry.pointer)}) — run \`git lfs pull\`, then re-run this check. It is NOT a media_integrity failure.`);
  }
  for (const entry of missing.filter((item) => item.code !== 'git_lfs_pointer')) {
    console.log(`  MISSING ${entry.row.path}  [${entry.code}] ${entry.message}`);
  }
  for (const entry of missing) console.log(`  expected physical file: ${path.join(mediaRoot, entry.row.path.slice('content/exams/'.length))}`);
  if (missing.length) {
    const pointers = missing.filter((item) => item.code === 'git_lfs_pointer').length;
    console.log(`FAIL --require-recordings: ${missing.length} referenced recording(s) are not usable under ${mediaRoot}${pointers ? ` (${pointers} of them are git-LFS pointer files, not audio — run \`git lfs pull\`)` : ''} — the API must not start`);
    process.exit(1);
  }
  console.log(`PASS --require-recordings: all ${recordings.length} referenced recording(s) are present under ${mediaRoot}`);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed (media root: ${mediaRoot})`);
if (failed || missing.length) process.exitCode = 1;
