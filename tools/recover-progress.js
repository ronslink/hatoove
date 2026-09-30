/**
 * Recover learner progress by merging a backup into the live file.
 *
 * A plain last-write-wins save once let a stale tab overwrite newer answers: the live
 * progress.json ended up with 68 fewer attempts than the generation before it. The
 * merge is monotonic, so folding a backup back in restores what was lost and can never
 * remove anything.
 *
 * Safe to run at any time; it writes a `.pre-recovery` copy first. That copy sits beside
 * the record, so a full "delete everything" in the app removes it too. A copy on removable
 * media is outside that path and is only disclosed, never claimed deleted (finding F-5;
 * see work/implementation/F5-DELETION-01.md).
 *
 * Usage:
 *   node tools/recover-progress.js --dry-run     # show what would change
 *   node tools/recover-progress.js               # do it
 *   node tools/recover-progress.js --source other.json --target progress.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { mergeProgress } from '../public/js/progress-merge.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const dryRun = process.argv.includes('--dry-run');
const target = path.resolve(arg('target', 'progress.json'));
const source = path.resolve(arg('source', `${target}.bak`));

function load(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function summarise(label, s) {
  if (!s) {
    console.log(`${label.padEnd(10)} (missing)`);
    return;
  }
  const hist = Array.isArray(s.history) ? s.history.length : 0;
  console.log(
    `${label.padEnd(10)} attempts=${String(s.counters?.attempts ?? '?').padStart(4)}  ` +
      `history=${String(hist).padStart(4)}  errors=${String((s.errors || []).length).padStart(3)}  ` +
      `nodes=${String(Object.keys(s.nodes || {}).length).padStart(3)}  ` +
      `updated=${s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '-'}`
  );
}

const live = load(target);
const backup = load(source);

if (!live && !backup) {
  console.error(`Nothing to recover: neither ${target} nor ${source} could be read.`);
  process.exit(1);
}
if (!backup) {
  console.error(`No backup at ${source} - nothing to merge in.`);
  process.exit(1);
}

console.log(`\ntarget: ${target}`);
console.log(`source: ${source}\n`);
summarise('before', live);
summarise('backup', backup);

const merged = mergeProgress(live, backup);
console.log('');
summarise('merged', merged);

const gained = (merged.counters?.attempts || 0) - (live?.counters?.attempts || 0);
const gainedHistory = (merged.history?.length || 0) - (live?.history?.length || 0);
const gainedErrors = (merged.errors?.length || 0) - (live?.errors?.length || 0);

console.log('');
console.log(`recovered: +${gained} attempts, +${gainedHistory} history entries, +${gainedErrors} notebook entries`);

if (gained === 0 && gainedHistory === 0 && gainedErrors === 0) {
  console.log('\nNothing was missing - the live file already contains everything. No write needed.');
  process.exit(0);
}

if (dryRun) {
  console.log('\nDry run: nothing written. Re-run without --dry-run to apply.');
  process.exit(0);
}

const safety = `${target}.pre-recovery`;
fs.copyFileSync(target, safety);
fs.writeFileSync(target, JSON.stringify(merged));
console.log(`\nWrote ${target}`);
console.log(`Safety copy of the previous file: ${safety}`);
console.log('That copy sits beside the record, so the app\'s full delete removes it too.');
console.log('A copy on removable media is out of that delete path (finding F-5).');
