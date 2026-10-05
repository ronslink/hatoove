#!/usr/bin/env node
/**
 * EOL-HASH-AUDIT-01 — a file whose digest is recorded anywhere must check out identically on every
 * platform.
 *
 * WHY THIS EXISTS. Two gates passed on Windows and failed on the ubuntu runner because a recorded
 * sha256 was taken over a source file's bytes, and those bytes are CRLF in a Windows working tree
 * (`core.autocrlf=true`, no `eol` attribute) and LF everywhere else:
 *
 *   - POOL-01-CI-01: `0010` recorded `data/seed.json`, `0047` recorded `content/pool-01/batch-1.json`;
 *   - EOL-HASH-AUDIT-01 found the same shape in `0011` (`data/vocab.json`), `0012`
 *     (`data/noun-lexicon.json`) and `0013`/`0014` (the seven `data/*-guide.json` sources).
 *
 * WHAT IT CLAIMS — AND WHAT IT DOES NOT. The claim is about PLATFORM STABILITY, never about
 * freshness. `0014`'s digest for `data/speaking-guide.json` and `0012`'s for `data/noun-lexicon.json`
 * are deliberately stale: migration `0043` corrected those sources in place and patched the database
 * forward, so the recorded digest pins the pre-correction bytes on purpose. A stale-but-packed record
 * is correct here; an UNPINNED record is not, and that is all this tool fails on.
 *
 * THE THREE LEGS
 *   1. INVENTORY: every `createHash(` site under `tools/` and `server/` is classified as hashing
 *      file bytes, hashing a value, or `unclassified`. An unclassified site FAILS by name — so a new
 *      direct file hash cannot be added without someone deciding what it implies.
 *   2. RECORDED PATHS ARE PINNED: the paths whose digest is recorded in a committed artifact (a
 *      migration's `-- Source:` line, a pin map in the code, the design manifest, the translation
 *      bundle's README pin) must resolve through `git check-attr` to a stable form: `-text`/`binary`
 *      (no conversion at all) or `text` with an explicit `eol`. `unspecified` fails by name.
 *   3. MUTATION: the attributes text with one pin removed must make leg 2 fail naming that path.
 *
 * `git check-attr` is the authority for the real evaluation. The mutation needs to evaluate a
 * MODIFIED attributes text, which git has no flag for, so the tool carries a small last-match-wins
 * matcher — and cross-validates it against git for every recorded path on every run, so the matcher
 * can never quietly disagree with the real thing.
 *
 * Usage:
 *   node tools/eol-hash-check.mjs
 *   node tools/eol-hash-check.mjs --list          the recorded paths and the inventory
 *   node tools/eol-hash-check.mjs --attributes <file>   evaluate a different attributes file
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ATTRIBUTES = '--attributes';
const attributesFile = (() => {
  const index = process.argv.indexOf(ATTRIBUTES);
  if (index < 0) return path.join(ROOT, '.gitattributes');
  const next = process.argv[index + 1];
  if (!next) throw new Error(`${ATTRIBUTES} needs a file`);
  return path.resolve(next);
})();
const listOnly = process.argv.includes('--list');

const failures = [];
const notes = [];
const fail = (leg, detail) => failures.push(`${leg}: ${detail}`);

/* ------------------------------------------------------------------ reading the tree */

function tracked(pattern) {
  const result = spawnSync('git', ['ls-files', '-z', ...(pattern ? [pattern] : [])], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`git ls-files failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout.split('\0').filter(Boolean);
}
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

/* ------------------------------------------------------------------ leg 1: the hashing inventory */

/** `path.join(ROOT, 'data', 'seed.json')` -> `data/seed.json`; `new URL('../x', import.meta.url)` -> resolved. */
function resolveJoinArgument(argument, fromDir) {
  const joined = /path\.join\(\s*ROOT\s*,([^)]*)\)/.exec(argument);
  if (joined) {
    const parts = [...joined[1].matchAll(/['"`]([^'"`]+)['"`]/g)].map((match) => match[1]);
    return parts.length ? parts.join('/') : null;
  }
  const url = /new URL\(\s*['"`]([^'"`]+)['"`]\s*,\s*import\.meta\.url\s*\)/.exec(argument);
  if (url) return path.relative(ROOT, path.resolve(fromDir, url[1])).replaceAll('\\', '/');
  const literal = /^\s*['"`]([^'"`]+)['"`]\s*$/.exec(argument);
  if (literal) {
    const value = literal[1];
    if (value.startsWith('.') || value.includes('/')) return path.relative(ROOT, path.resolve(fromDir, value)).replaceAll('\\', '/');
    return null;
  }
  return null;
}

/** The argument of a call, balanced over parentheses, starting after `open` (index of the `(`). */
function callArgument(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '(') depth += 1;
    else if (text[index] === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return '';
}

/** The first bare identifier inside an expression, e.g. `path` from `new URL(path, import.meta.url)`. */
function firstIdentifier(expression) {
  const match = /[A-Za-z_$][\w$]*/.exec(expression.replace(/^[\s(]*/, ''));
  return match ? match[0] : null;
}

/**
 * Classify every `createHash(...)` site. A site that reads a file it cannot resolve is
 * `unclassified` and fails: that is the one shape a human must look at.
 */
function hashingInventory() {
  const sites = [];
  const files = [...tracked('tools'), ...tracked('server')].filter((file) => file.endsWith('.mjs'));
  for (const file of files) {
    const text = read(file);
    if (!text.includes('createHash(')) continue;
    const lines = text.split('\n');
    const fromDir = path.dirname(path.join(ROOT, file));

    /*
     * Two binding passes. First the path-shaped constants (`SOURCE = path.join(ROOT, 'data', …)`,
     * `= new URL('../x', import.meta.url)`, `= 'content/x.json'`), then the file-read constants
     * (`raw = readFileSync(SOURCE)`), so `update(raw)` resolves to a real path.
     */
    const paths = new Map();
    for (const match of text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]+)/g)) {
      const resolved = resolveJoinArgument(match[2], fromDir);
      if (resolved) paths.set(match[1], resolved);
    }
    const fileVars = new Map();
    for (const match of text.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:fs\.)?readFile(?:Sync)?\(([^)]*)\)/g)) {
      const inner = match[2].trim();
      const resolved = paths.get(inner) ?? resolveJoinArgument(inner, fromDir);
      if (resolved) fileVars.set(match[1], resolved);
    }
    const loopSets = new Map();
    for (const match of text.matchAll(/for\s*\(\s*const\s+([A-Za-z_$][\w$]*)\s+of\s+\[([^\]]*)\]\s*\)/g)) {
      loopSets.set(match[1], [...match[2].matchAll(/['"`]([^'"`]+)['"`]/g)].map((entry) => entry[1]));
    }

    lines.forEach((line, index) => {
      if (!line.includes('createHash(')) return;
      const window = lines.slice(index, index + 5).join(' ');
      const updateAt = window.indexOf('.update(');
      const argument = updateAt < 0 ? '' : callArgument(window, updateAt + '.update'.length).trim();
      const site = { file, line: index + 1, argument: argument.slice(0, 60), kind: 'value', paths: [] };

      const readAt = /(?:await\s+)?(?:fs\.)?readFile(?:Sync)?\(/.exec(argument);
      if (readAt) {
        const inner = callArgument(argument, readAt.index + readAt[0].length - 1).trim();
        // The identifier actually bound to a path, rather than the first token (which may be `new`).
        const names = [...inner.matchAll(/[A-Za-z_$][\w$]*/g)].map((match) => match[0]);
        const bound = names.find((name) => paths.has(name) || fileVars.has(name) || loopSets.has(name));
        const resolved = paths.get(inner)
          ?? resolveJoinArgument(inner, fromDir)
          ?? fileVars.get(inner)
          ?? (bound ? fileVars.get(bound) ?? paths.get(bound) : null);
        const loop = bound ? loopSets.get(bound) : null;
        if (typeof resolved === 'string' && resolved && fs.existsSync(path.join(ROOT, resolved))) { site.kind = 'file'; site.paths = [resolved]; }
        else if (loop) { site.kind = 'file'; site.paths = loop.map((entry) => path.relative(ROOT, path.resolve(fromDir, entry)).replaceAll('\\', '/')); }
        else if (/^[A-Za-z_$][\w$]*$/.test(inner) || /(?:path\.(?:join|resolve)|new URL)\(/.test(inner)) {
          // The path is supplied by the caller (`readFileSync(file)` in a helper, `readFileSync(batchPath)`),
          // so this site is a file hash whose paths come from elsewhere; reported, not failed.
          site.kind = 'parameter';
        } else site.kind = 'unclassified';
      } else if (fileVars.has(argument) || paths.has(argument)) {
        site.kind = 'file';
        site.paths = [fileVars.get(argument) ?? paths.get(argument)];
      } else if (loopSets.has(argument)) {
        site.kind = 'file';
        site.paths = loopSets.get(argument).map((entry) => path.relative(ROOT, path.resolve(fromDir, entry)).replaceAll('\\', '/'));
      } else {
        // A helper that hashes the file its parameter names: find the helper, then its call site.
        const context = lines.slice(Math.max(0, index - 5), index + 2).join(' ');
        const helper = /(?:const|function)\s+([A-Za-z_$][\w$]*)\s*=?\s*\(?\s*([A-Za-z_$][\w$]*)\s*\)?\s*(?:=>|\{)/.exec(context);
        if (helper && helper[2] === argument) {
          const call = new RegExp(`${helper[1].replace(/\$/g, '\\$')}\\(\\s*['"\`]([^'"\`]+)['"\`]`).exec(text);
          const resolved = call ? resolveJoinArgument(`'${call[1]}'`, fromDir) ?? call[1] : null;
          if (resolved && fs.existsSync(path.join(ROOT, resolved))) { site.kind = 'file'; site.paths = [resolved]; }
          else site.kind = 'parameter';
        } else if (/JSON\.stringify|canonicalJson|String\(|JSON\.parse|Buffer\.from|to_jsonb|\.map\(/.test(argument)) {
          site.kind = 'value';
        } else if (/^(bytes|buffer|raw|wav|exact|body|value|canonical|row|text)$/.test(argument) || firstIdentifier(argument) === argument) {
          site.kind = 'parameter';
        }
      }
      sites.push(site);
    });
  }
  /*
   * SELF-CHECK. A `file` classification must name a real tracked path; anything else is a resolution
   * this analysis got wrong, so it degrades to `parameter` (printed for a human) rather than claiming
   * a path it cannot substantiate. Without this a mis-resolved helper reported an empty path and
   * looked like a fact.
   */
  for (const site of sites) {
    if (site.kind !== 'file') continue;
    if (site.paths.length && site.paths.every((entry) => entry && trackedSet.has(entry))) continue;
    site.kind = 'parameter';
    site.paths = [];
  }
  return sites;
}

/* ------------------------------------------------------------------ leg 2: recorded digests */

/** `-- Source: <path> (sha256 <hex>)` in a migration, with the migration that records it. */
function recordedInMigrations() {
  const found = new Map();
  for (const file of tracked('server/migrations').filter((name) => name.endsWith('.sql'))) {
    for (const match of read(file).matchAll(/--\s*Source:\s*([A-Za-z0-9_./-]+\.[a-z]+)\s*\(sha256 ([0-9a-f]{64})\)/g)) {
      if (!found.has(match[1])) found.set(match[1], []);
      found.get(match[1]).push(`${path.basename(file)} header`);
    }
    // `content_sha256` literals name their source in the same row's `source_path` column.
    for (const match of read(file).matchAll(/'([A-Za-z0-9_./-]+\.[a-z]+)',\s*'unreviewed',\s*'unknown',\s*'([0-9a-f]{64})'/g)) {
      if (!found.has(match[1])) found.set(match[1], []);
      found.get(match[1]).push(`${path.basename(file)} content_sha256`);
    }
  }
  return found;
}

/** Pin maps written in code: `'<tracked path>': '<hex>'` or `['<tracked path>', '<hex>']`. */
function recordedInCode(trackedSet) {
  const found = new Map();
  for (const file of [...tracked('tools'), ...tracked('server')].filter((name) => name.endsWith('.mjs'))) {
    const text = read(file);
    const add = (target) => {
      if (!trackedSet.has(target)) return;
      if (!found.has(target)) found.set(target, []);
      found.get(target).push(`${file} pin`);
    };
    for (const match of text.matchAll(/['"]([A-Za-z0-9_./-]+\.[a-z]+)['"]\s*:\s*'([0-9a-f]{64})'/g)) add(match[1]);
    for (const match of text.matchAll(/\[\s*'([A-Za-z0-9_./-]+\.[a-z]+)'\s*,\s*'([0-9a-f]{64})'\s*\]/g)) add(match[1]);
  }
  return found;
}

/** The design manifest pins curated assets under two `-text` roots; the README pins the bundle. */
function recordedElsewhere(trackedSet) {
  const found = new Map();
  const manifestFile = 'work/implementation/DESIGN-REFERENCE-MANIFEST.json';
  if (trackedSet.has(manifestFile)) {
    for (const entry of JSON.parse(read(manifestFile)).files ?? []) {
      for (const root of ['public/assets/design', 'work/design-reference']) {
        const candidate = `${root}/${entry.path}`.replaceAll('//', '/');
        if (!trackedSet.has(candidate)) continue;
        if (!found.has(candidate)) found.set(candidate, []);
        found.get(candidate).push('DESIGN-REFERENCE-MANIFEST.json');
      }
    }
  }
  const readme = 'content/library-translations/README.md';
  const bundle = 'content/library-translations/hatoove-library-translations-uk-ar-tr.json';
  if (trackedSet.has(bundle) && /sha256[^\n]*`([0-9a-f]{64})`/.test(read(readme))) {
    found.set(bundle, [`${readme} pin`]);
  }
  return found;
}

/* ------------------------------------------------------------------ attribute evaluation */

/** The authoritative verdict, from git itself. */
function gitVerdict(relative) {
  const result = spawnSync('git', ['check-attr', 'text', 'eol', 'binary', '--', relative], { cwd: ROOT, encoding: 'utf8' });
  if (result.error || result.status !== 0) throw new Error(`git check-attr failed for ${relative}: ${result.error?.message ?? result.stderr}`);
  const values = Object.fromEntries(result.stdout.trim().split('\n').map((line) => {
    const at = line.lastIndexOf(': ');
    return [line.slice(line.indexOf(': ') + 2, at), line.slice(at + 2)];
  }));
  return { text: values.text ?? 'unspecified', eol: values.eol ?? 'unspecified', binary: values.binary ?? 'unspecified' };
}

/** A form that is the same on every platform: no conversion at all, or an explicit eol. */
function stableForm(verdict) {
  if (verdict.binary === 'set') return 'binary (never converted)';
  if (verdict.text === 'unset') return '-text (never converted)';
  if (verdict.text === 'set' && (verdict.eol === 'lf' || verdict.eol === 'crlf')) return `text eol=${verdict.eol}`;
  return null;
}

/**
 * A last-match-wins matcher for the patterns this repository uses, so a MUTATED attributes text can be
 * evaluated. It is cross-validated against `git check-attr` for every recorded path on every run:
 * a disagreement fails the run, so the matcher can never quietly diverge from git.
 */
function attributeRules(text) {
  return text.split('\n')
    // A CRLF line ends with `\r`, and `.` does not match `\r`, so the `#`-comment strip needs it gone first.
    .map((line) => line.replace(/\r/g, '').replace(/#.*$/, '').trim())
    .filter(Boolean)
    .map((line) => {
      const [pattern, ...attributes] = line.split(/\s+/);
      const set = new Map(attributes.map((attribute) => {
        // gitattributes syntax: `attr`, `-attr` (unset), `!attr` (unspecified), `attr=value`.
        const name = attribute.replace(/^[-!]/, '').split('=')[0];
        const value = attribute.startsWith('-') ? 'unset' : attribute.startsWith('!') ? 'unspecified' : (attribute.split('=')[1] ?? 'set');
        return [name, value];
      }));
      return { pattern, set };
    });
}

function globToRegExp(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      const slash = pattern[index + 2] === '/' ? (index += 2, '/') : '';
      source += slash ? '(?:.*/)?' : '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

function evaluate(attributesText, relative) {
  const rules = attributeRules(attributesText);
  const values = { text: 'unspecified', eol: 'unspecified', binary: 'unspecified' };
  for (const { pattern, set } of rules) {
    const negative = pattern.startsWith('!');
    const body = negative ? pattern.slice(1) : pattern;
    if (!globToRegExp(body).test(relative)) continue;
    for (const name of ['text', 'eol', 'binary']) {
      if (negative) values[name] = 'unspecified';
      else if (set.has(name)) values[name] = negative ? 'unspecified' : set.get(name);
    }
  }
  return values;
}

/* ------------------------------------------------------------------ run */

const trackedSet = new Set(tracked());
const attributesText = fs.readFileSync(attributesFile, 'utf8');
/*
 * `--attributes <file>` exists so the mutation proof can be run end to end against a modified rules
 * file. That overridden file IS the authority for that run, so git's in-tree verdict is not
 * consulted (and the cross-validation below is skipped): the point of the override is to see what a
 * different rule set would do.
 */
const overriding = path.resolve(attributesFile) !== path.join(ROOT, '.gitattributes');
const verdictFor = (relative) => {
  if (!overriding) return gitVerdict(relative);
  const mine = evaluate(attributesText, relative);
  return { text: mine.text, eol: mine.eol, binary: mine.binary };
};

// leg 1
const sites = hashingInventory();
const unclassified = sites.filter((site) => site.kind === 'unclassified');
for (const site of unclassified) {
  fail('1 hashing-site inventory', `${site.file}:${site.line} hashes a file whose path this analysis cannot resolve (update(${site.argument})); teach tools/eol-hash-check.mjs about it or make the path literal`);
}
const fileSites = sites.filter((site) => site.kind === 'file');
const parameterSites = sites.filter((site) => site.kind === 'parameter');

// leg 2
const recorded = new Map([...recordedInMigrations(), ...recordedInCode(trackedSet), ...recordedElsewhere(trackedSet)]);
const recordedPaths = [...recorded.keys()].sort();
for (const relative of recordedPaths) {
  if (!trackedSet.has(relative)) { fail('2 recorded path', `${relative} (recorded by ${recorded.get(relative).join(', ')}) is not a tracked file`); continue; }
  const verdict = verdictFor(relative);
  const stable = stableForm(verdict);
  if (!stable) {
    fail('2 recorded path', `${relative} (recorded by ${recorded.get(relative).join(', ')}) is not pinned: text=${verdict.text} eol=${verdict.eol} binary=${verdict.binary} — add an eol rule in .gitattributes`);
  }
  // The matcher must agree with git, or the mutation proof below means nothing.
  if (!overriding) {
    const mine = evaluate(attributesText, relative);
    const myStable = stableForm({ text: mine.text, eol: mine.eol, binary: mine.binary });
    if (Boolean(myStable) !== Boolean(stable)) {
      fail('2 recorded path', `${relative}: this tool's matcher says ${JSON.stringify(mine)} but git says ${JSON.stringify(verdict)}`);
    }
  }
}

// The intersection, stated positively: a file that is hashed as bytes AND recorded must be pinned.
for (const site of fileSites) {
  for (const target of site.paths) {
    if (!recorded.has(target)) continue;
    const stable = stableForm(gitVerdict(target));
    if (!stable) fail('2 intersection', `${site.file}:${site.line} hashes ${target}, whose digest is recorded by ${recorded.get(target).join(', ')}, and it is not pinned`);
  }
}

// Informational: a pin can only affect the next checkout, so a stale working copy is reported, not failed.
const drift = spawnSync('git', ['ls-files', '--eol'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).stdout
  .split('\n').filter(Boolean).map((line) => {
    const [prefix, ...rest] = line.split('\t');
    const match = /^(i\/\S+)\s+(w\/\S+)\s+attr\/(.*?)\s*$/.exec(prefix);
    return { index: match?.[1], worktree: match?.[2], attr: (match?.[3] ?? '').trim(), path: rest.join('\t') };
  })
  .filter((entry) => entry.worktree === 'w/crlf' && /eol=lf|-text|binary/.test(entry.attr) && trackedSet.has(entry.path));
for (const entry of drift.slice(0, 30)) {
  notes.push(`${entry.path} is CRLF in THIS working tree while its attribute pins ${entry.attr}; a fresh checkout is correct (re-check it out to refresh the local copy)`);
}
if (drift.length > 30) notes.push(`…and ${drift.length - 30} more stale working copies`);

// leg 3 — the mutation proof, on the matcher that was just cross-validated against git.
const mutationTarget = recordedPaths.find((relative) => stableForm(gitVerdict(relative)) && /\.json$/.test(relative)) ?? recordedPaths[0];
let mutationName = null;
if (mutationTarget) {
  const pinning = attributeRules(attributesText)
    .filter(({ set }) => set.get('eol') || set.get('text') === 'unset' || set.get('binary') === 'set')
    .filter(({ pattern }) => globToRegExp(pattern).test(mutationTarget));
  const last = pinning[pinning.length - 1];
  if (!last) {
    fail('3 mutation', `no rule pins ${mutationTarget}, so the mutation proof cannot run`);
  } else {
    const mutated = attributeRules(attributesText)
      .map(({ pattern, set }) => (pattern === last.pattern ? pattern : `${pattern} ${[...set].map(([name, value]) => (value === 'set' ? name : value === 'unset' ? `!${name}` : `${name}=${value}`)).join(' ')}`))
      .filter((line) => !line.startsWith(last.pattern))
      .join('\n');
    const after = evaluate(mutated, mutationTarget);
    if (stableForm({ text: after.text, eol: after.eol, binary: after.binary })) {
      fail('3 mutation', `removing \`${last.pattern}\` left ${mutationTarget} stable (${JSON.stringify(after)}); the proof is not proving anything`);
    } else {
      mutationName = `${mutationTarget} becomes text=${after.text} eol=${after.eol} when \`${last.pattern}\` is removed`;
    }
  }
}

/* ------------------------------------------------------------------ report */

if (listOnly) {
  console.log('Recorded digests and the path each one pins:');
  for (const relative of recordedPaths) console.log(`  ${relative}  <- ${recorded.get(relative).join(', ')}`);
  console.log(`\nHashing sites: ${sites.length} (${fileSites.length} over file bytes, ${parameterSites.length} parameter-sourced, ${sites.length - fileSites.length - parameterSites.length} over values, ${unclassified.length} unclassified)`);
  for (const site of fileSites) console.log(`  file  ${site.file}:${site.line} -> ${site.paths.join(', ')}`);
  for (const site of parameterSites) console.log(`  param ${site.file}:${site.line} update(${site.argument})`);
}

for (const note of notes) console.log(`NOTE ${note}`);
console.log(`recorded digests: ${recordedPaths.length} path(s) pinned to a stable form; hashing sites: ${sites.length} (${fileSites.length} file, ${unclassified.length} unclassified)`);
if (mutationName) console.log(`MUTATION ${mutationName}`);
console.log(`${failures.length} failed`);
for (const failure of failures) console.log(`FAIL ${failure}`);
process.exitCode = failures.length ? 1 : 0;
