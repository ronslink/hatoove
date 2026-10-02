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

/*
 * NO WORKFLOW STEP MAY RUN A FILE THAT DOES NOT EXIST EITHER — the same defect as the stale npm scripts
 * above, in a place that rots even more quietly.
 *
 * A renamed or deleted checker leaves the workflow referring to it, and the failure then appears as a red CI
 * job on somebody else's pull request, or worse: a step inside a job whose earlier step is skipped reports
 * green for having run nothing (this file has already recorded that failure mode once, in the SPA retirement).
 * The package.json leg above catches the same class for npm; this catches it for `.github/workflows/*.yml`,
 * which is where the rendered gate now lives.
 *
 * Text-level on purpose: the alternative is a YAML dependency in a checker whose whole value is that it has
 * none, and the pattern being matched (`node tools/<file>`) is a convention this repository already enforces
 * by hand everywhere else.
 */
const workflowPattern = /^\.github\/workflows\/.*\.ya?ml$/;
const workflowRefs = [];
for (const entry of entries) {
  const file = entry.split('\t').pop().trim();
  if (!workflowPattern.test(file)) continue;
  /*
   * THE STAGED BLOB, through `git show :path` — the same mechanism the package.json leg above uses, and the
   * snapshot this whole checker is written against.
   *
   * THE FIRST VERSION OF THIS LEG USED `fs.readFileSync` AND DID NOTHING AT ALL: this file imports no `fs`, so
   * the call threw `ReferenceError`, my own `catch { continue; }` swallowed it, and the leg reported nothing
   * while looking like it passed. What exposed it was running the discrimination test PROPERLY — rename a
   * checker in the workflow and require a failure. A check that cannot fail is decoration, which is why the
   * test comes with the leg rather than after it.
   *
   * A workflow that cannot be read is a failure rather than a skip: it is a tracked file, and the reference it
   * contains is exactly what this leg exists to verify.
   */
  let text = '';
  try {
    text = git('show', `:${file}`);
  } catch (error) {
    failures.push(`${file} is tracked but could not be read from the staged snapshot: ${error.message.split('\n')[0]}`);
    continue;
  }
  for (const match of text.matchAll(/node\s+((?:tools|server)\/[\w./-]+\.mjs)/g)) {
    workflowRefs.push({ file, target: match[1] });
  }
}
for (const { file, target } of workflowRefs) {
  if (!entries.some((entry) => entry.split('\t').pop().trim() === target)) {
    failures.push(`${file} runs ${target}, which is not a tracked file`);
  }
}
// A workflow that runs nothing is not a gate either: the rendered job must name at least one checker.
const renderedWorkflow = workflowRefs.filter((ref) => ref.file === '.github/workflows/ci.yml');
if (workflowRefs.length && !renderedWorkflow.length) {
  failures.push('ci.yml references no node checker, so the legs it claims to run cannot be verified here');
}

/*
 * AND THE STRUCTURE OF THE WORKFLOW ITSELF, which is the other half of the same class — and the one that had
 * already happened: an unquoted colon-space in a step name made `.github/workflows/ci.yml` INVALID YAML, so
 * every job would have failed to start, and reading the file did not show it. `tools/workflow-shape.mjs`
 * carries the three rules and the reasoning; `tools/workflow-shape.test.mjs` proves each rule can fail
 * (including the block-scalar exemption, without which the check would flag every shell body in the file).
 */
const { workflowShapeProblems } = await import('./workflow-shape.mjs');
for (const entry of entries) {
  const file = entry.split('\t').pop().trim();
  if (!workflowPattern.test(file)) continue;
  let text = '';
  try {
    text = git('show', `:${file}`);
  } catch {
    continue; // already reported above when it mattered
  }
  for (const problem of workflowShapeProblems(text)) failures.push(`${file} ${problem}`);
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
} else {
  console.log(`Repository check passed: ${entries.length} tracked files; ${inspected} text blobs screened. This is not a complete secret audit.`);
}
