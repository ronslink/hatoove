/** Inspect tracked/staged Git blobs without printing possible secret values. */
import { execFileSync } from 'node:child_process';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const entries = git('ls-files', '--stage', '-z').split('\0').filter(Boolean);
const failures = [];
let inspected = 0;
const deniedPath = /(?:^|\/)(?:\.qa|node_modules|\.git|\.ssh|\.hermes|\.openai|\.sites-runtime|\.worktrees|_backup_[^/]*)(?:\/|$)|(?:^|\/)(?:progress(?:-[^/]*)?\.json[^/]*|\.progress-[^/]*|sync-home\.json|\.sync-home-complete[^/]*|\.b1prep-sync-home\.lock)$|^research\/[^/]+\/runs\/|\.(?:pem|key|p12|pfx|db|sqlite\w*|exe|dll|zip|tar\.gz|bundle)$/i;
const patterns = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{24,})\b/],
  ['provider key', /\bsk-[A-Za-z0-9_-]{24,}\b/],
  ['Google API key', /\bAIza[A-Za-z0-9_-]{30,}\b/],
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['credential URL', /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/],
];

for (const entry of entries) {
  const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(entry);
  if (!match) throw new Error('Unexpected Git index entry');
  const [, mode, oid, stage, name] = match;
  if (stage !== '0') failures.push(`${name}: unresolved merge stage`);
  if (mode === '160000') { failures.push(`${name}: embedded repository omits source files`); continue; }
  if (deniedPath.test(name) || /(?:^|\/)\.env(?:\.|$)/i.test(name) && name !== '.env.example') {
    failures.push(`${name}: excluded local/runtime file`);
    continue;
  }
  const bytes = execFileSync('git', ['cat-file', 'blob', oid], { maxBuffer: 16 * 1024 * 1024 });
  if (name === '.env.example' && bytes.includes(0)) {
    failures.push(`${name}: template must be plain UTF-8 text`);
    continue;
  }
  if (bytes.includes(0)) continue;
  const body = bytes.toString('utf8');
  inspected++;
  for (const [label, pattern] of patterns) {
    if (pattern.test(body)) failures.push(`${name}: possible ${label} (value withheld)`);
  }
  if (name === '.env.example') {
    for (const line of body.split(/\r?\n/)) {
      const setting = /^([A-Z][A-Z_0-9]*(?:KEY|TOKEN|SECRET|PASSWORD))=(.*)$/.exec(line);
      if (setting && setting[2].trim()) failures.push(`${name}: ${setting[1]} must be empty`);
    }
  }
}

if (!entries.length) failures.push('No tracked files: stage the curated source before checking.');

/*
 * NO package.json SCRIPT MAY POINT AT A FILE THAT DOES NOT EXIST.
 *
 * A real defect, found by an independent review after the SPA retirement: deleting 22 tool files left six
 * npm scripts pointing at them, so `npm run check` died with MODULE_NOT_FOUND and — worse — `npm run tts`
 * advertised a speech diagnostic that no longer existed. A script name is a CLAIM about what the project
 * can do, and a stale one is a false signal rather than a harmless leftover. It belongs here rather than in
 * a one-off command because the next deletion will do exactly the same thing.
 */
try {
  const pkg = JSON.parse(git('show', ':package.json'));
  const scripts = pkg.scripts || {};
  for (const [name, command] of Object.entries(scripts)) {
    for (const match of String(command).matchAll(/node\s+((?:tools|server)\/[\w./-]+)/g)) {
      const target = match[1];
      if (!entries.some((entry) => entry.split('\t').pop().trim() === target)) {
        failures.push(`package.json script "${name}" runs ${target}, which is not a tracked file`);
      }
    }
  }
} catch { /* no package.json in this tree: nothing to check */ }

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Repository check passed: ${entries.length} tracked files; ${inspected} text blobs screened. This is not a complete secret audit.`);
}
