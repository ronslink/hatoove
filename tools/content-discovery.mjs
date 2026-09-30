#!/usr/bin/env node
/**
 * content-discovery.mjs — read-only inventory of the existing Hatoove B1 sources.
 *
 * Task C-01 (discovery slice). This command only READS tracked files and prints
 * deterministic counts. It never writes, never calls a network or provider, never
 * requests `.env`, never runs a browser and never prints complete question/answer
 * text (identifiers and counts only). It makes no judgement about exam fidelity,
 * rights or review status.
 *
 * Usage:
 *   node tools/content-discovery.mjs            # human-readable report
 *   node tools/content-discovery.mjs --json     # same data as stable JSON
 *
 * COUNTING UNITS (each unit is counted once, from one named place)
 *   1. source file       one tracked JSON under data/ (the shipped content corpus).
 *   2. task family       one top-level key of data/seed.json (LV1..HV3) = one exam
 *                        task format.
 *   3. set               one array element of a task family = one playable instance
 *                        (a "pack"). 24 sets exist; the plan warns not to assume them.
 *   4. answer slot       one graded position inside a set: a text (LV1), question
 *                        (LV2), situation (LV3), gap (SB1/SB2) or item (HV1..HV3).
 *   5. complete set      a set whose every answer slot carries a stored key AND the
 *                        set carries all fields the family schema requires.
 *   6. option container  one slot that itself offers selectable choices (LV2
 *                        question, SB1 gap): the slot is the container.
 *   7. option entry      one selectable choice inside an option container
 *                        (a/b/c inside one LV2 question or SB1 gap).
 *   8. pool entry        one entry of a set-level pool array that is not attached to
 *                        a single slot (LV1 headlines, LV3 ads, SB2 bank).
 *   9. writing prompt    one offline writing task in public/js/ai.js (source fact,
 *                        distinct from live provider generation, which is not source).
 *  10. guide unit        one element of a named reference/teaching block in a guide
 *                        file (section, topic, rule, table, checklist line, ...).
 *  11. lexicon entry     one vocabulary item (vocab.json words, noun-lexicon nouns).
 *  12. media/TTS match   one regex match in a tracked text file: a fixed audio file
 *                        path (extension search) or a browser TTS call site
 *                        (speechSynthesis / SpeechSynthesisUtterance). ALL matches in a
 *                        file are counted. Runtime scope (public code + server.js) is
 *                        reported separately from tests/docs prose, because prose that
 *                        mentions mp3 or speechSynthesis is not an application
 *                        dependency. This command's own file is excluded from the text
 *                        scan because it holds the matching patterns as literals; the
 *                        exclusion is printed in the report.
 *
 * FILE INVENTORY: exactly one read-only `git ls-files -z` call (execFileSync, no
 * shell). Tracked files only: ignored, untracked and private files are never
 * enumerated or read. Byte sizes and hashes describe the bytes of THIS checkout
 * (a Git checkout with CRLF line endings would differ); the `contentSha12` field is
 * computed over line-ending-normalised content and all count columns are
 * checkout-independent.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const json = process.argv.includes('--json');
const readText = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(readText(rel));
const sha12 = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

/* ----------------------------------------------- 0. tracked file inventory -- */

// The single deterministic inventory: read-only, no shell, sorted. Git decides
// what is tracked; the filesystem is never walked.
function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out.split('\0').filter(Boolean).sort();
}

/* ------------------------------------------------------------------ 1. files */

function sourceFiles(tracked) {
  return tracked
    .filter((f) => /^data\/[^/]+\.json$/.test(f))
    .map((f) => {
      const raw = fs.readFileSync(path.join(ROOT, f));
      const parsed = JSON.parse(raw.toString('utf8'));
      const blocks = Object.keys(parsed)
        .filter((k) => Array.isArray(parsed[k]))
        .map((k) => k + '[' + parsed[k].length + ']');
      return {
        file: f,
        bytesLinuxCheckout: raw.length,
        contentSha12: sha12(raw.toString('utf8').replace(/\r\n/g, '\n')),
        blocks,
      };
    });
}

/* ---------------------------------------------------- 2/3/4/5/6. seed corpus */

// Per family: which array holds the graded slots, required set fields, set-level
// option-pool arrays.
const FAMILY_SCHEMA = {
  LV1: { slots: 'texts', required: ['title', 'headlines', 'texts', 'why'], pools: ['headlines'] },
  LV2: { slots: 'questions', required: ['title', 'text', 'questions'], pools: [] },
  LV3: { slots: 'situations', required: ['ads', 'situations'], pools: ['ads'] },
  SB1: { slots: 'gaps', required: ['letter', 'gaps'], pools: [] },
  SB2: { slots: 'gaps', required: ['letter', 'bank', 'gaps'], pools: ['bank'] },
  HV1: { slots: 'items', required: ['title', 'script', 'items'], pools: [] },
  HV2: { slots: 'items', required: ['title', 'script', 'items'], pools: [] },
  HV3: { slots: 'items', required: ['title', 'script', 'items'], pools: [] },
};

// A slot's own choices: an `options` object keyed a/b/c (LV2 questions, SB1 gaps),
// an array, or absent. The slot is the CONTAINER; its keys/entries are the ENTRIES.
// SB1's "10" is therefore 10 containers (one per gap), not 10 selectable options:
// each container holds one entry per key (a/b/c -> 3). SB2 gaps carry no options at
// all because the set-level `bank` array carries every choice.
const optionShape = (slot) => {
  const o = slot ? slot.options : null;
  if (Array.isArray(o)) return { containers: 1, entries: o.length };
  if (o && typeof o === 'object') return { containers: 1, entries: Object.keys(o).length };
  return { containers: 0, entries: 0 };
};

function corpus() {
  const seed = readJson('data/seed.json');
  const families = Object.keys(seed).map((fam) => {
    const spec = FAMILY_SCHEMA[fam] || { slots: null, required: [], pools: [] };
    const sets = seed[fam];
    const perSet = sets.map((set) => {
      const slots = spec.slots ? (set[spec.slots] || []) : [];
      const withAnswer = slots.filter((s) => s && Object.prototype.hasOwnProperty.call(s, 'answer')).length;
      // Explanation may sit on the slot itself (why) or, as in LV1, in a set-level
      // map keyed by slot id/number. Count a slot as explained when either applies.
      const whyMap = set.why && typeof set.why === 'object' && !Array.isArray(set.why) ? set.why : null;
      const withWhy = slots.filter((s) => {
        if (!s) return false;
        if (Object.prototype.hasOwnProperty.call(s, 'why')) return true;
        if (whyMap) return Object.prototype.hasOwnProperty.call(whyMap, String(s.id ?? s.n));
        return false;
      }).length;
      const missing = spec.required.filter((k) => !Object.prototype.hasOwnProperty.call(set, k));
      const pools = {};
      for (const p of spec.pools) pools[p] = Array.isArray(set[p]) ? set[p].length : 0;
      const opt = slots.reduce((a, s) => {
        const sh = optionShape(s);
        return { containers: a.containers + sh.containers, entries: a.entries + sh.entries };
      }, { containers: 0, entries: 0 });
      return {
        slots: slots.length,
        withAnswer,
        withWhy,
        pools,
        optionContainers: opt.containers,
        optionEntries: opt.entries,
        missingFields: missing,
      };
    });
    const perSetSlots = perSet.map((s) => s.slots);
    const totals = {
      sets: sets.length,
      slots: perSetSlots.reduce((a, b) => a + b, 0),
      slotsWithAnswer: perSet.reduce((a, s) => a + s.withAnswer, 0),
      slotsWithWhy: perSet.reduce((a, s) => a + s.withWhy, 0),
      optionContainers: perSet.reduce((a, s) => a + s.optionContainers, 0),
      optionEntries: perSet.reduce((a, s) => a + s.optionEntries, 0),
      poolEntries: Object.fromEntries(
        spec.pools.map((p) => [p, perSet.reduce((a, s) => a + (s.pools[p] || 0), 0)]),
      ),
    };
    const completeSets = perSet.filter(
      (s) => s.slots > 0 && s.withAnswer === s.slots && s.withWhy === s.slots && s.missingFields.length === 0,
    ).length;
    const governedSets = sets.filter(
      (s) => ['source', 'rights', 'license', 'review', 'reviewStatus', 'version'].some((k) => k in s),
    ).length;
    return { family: fam, slotArray: spec.slots, ...totals, completeSets, governedSets, perSet };
  });

  const totals = {
    families: families.length,
    sets: families.reduce((a, f) => a + f.sets, 0),
    slots: families.reduce((a, f) => a + f.slots, 0),
    slotsWithAnswer: families.reduce((a, f) => a + f.slotsWithAnswer, 0),
    slotsWithWhy: families.reduce((a, f) => a + f.slotsWithWhy, 0),
    optionContainers: families.reduce((a, f) => a + f.optionContainers, 0),
    optionEntries: families.reduce((a, f) => a + f.optionEntries, 0),
    completeSets: families.reduce((a, f) => a + f.completeSets, 0),
    governedSets: families.reduce((a, f) => a + f.governedSets, 0),
  };
  return { families, totals };
}

/* ------------------------------------------------------- 7. writing prompts */

function writingPrompts() {
  const src = readText('public/js/ai.js');
  const start = src.indexOf('const OFFLINE_WRITING_TASKS = {');
  const end = src.indexOf('export function offlineWritingTask');
  if (start < 0 || end < 0 || end < start) throw new Error('ai.js writing task block not found');
  const block = src.slice(start, end);
  const groups = [...block.matchAll(/\n {2}(du|Sie):\s*\[/g)];
  const perRegister = {};
  groups.forEach((g, i) => {
    const stop = i + 1 < groups.length ? groups[i + 1].index : block.length;
    perRegister[g[1]] = (block.slice(g.index, stop).match(/\btopic:/g) || []).length;
  });
  const prompts = (block.match(/\btopic:/g) || []).length;
  const arrays = [...block.matchAll(/leitpunkte:\s*\[([^\]]*)\]/gs)];
  const points = arrays.map((m) => (m[1].match(/'[^']*'/g) || []).length);
  const cs = src.indexOf('const WRITING_CRITERIA = [');
  const ce = src.indexOf('];', cs);
  const criteriaBlock = cs >= 0 && ce > cs ? src.slice(cs, ce) : '';
  const criteria = [...criteriaBlock.matchAll(/key:\s*'([a-z_]+)'[\s\S]*?max:\s*(\d+)/g)]
    .map((m) => ({ key: m[1], max: Number(m[2]) }));
  return {
    offlinePrompts: prompts,
    promptsPerRegister: perRegister,
    leitpunktArrays: arrays.length,
    leitpunktTotal: points.reduce((a, b) => a + b, 0),
    leitpunktePerPrompt: points,
    liveGenerationPath: /function genWritingTask/.test(src),
    rubricCriteria: criteria.length,
    rubricCriteriaKeys: criteria.map((c) => c.key),
    rubricMaxSum: criteria.reduce((a, c) => a + c.max, 0),
  };
}

/* ---------------------------------------------- 8/9. guides and lexicons ---- */

// topKey -> nested array key whose lengths are summed over the block's elements.
const NESTED = {
  'core-grammar.json:tiers': 'items',
  'core-phrases.json:tiers': 'items',
  'gender-rules.json:rules': 'items',
  'cases-guide.json:tables': 'rows',
  'speaking-guide.json:parts': 'approach',
  'writing-guide.json:sections': 'points',
  'grammar-guide.json:topics': 'examples',
};

const LEXICON = { 'vocab.json': 'words', 'noun-lexicon.json': 'nouns' };
const GUIDE_FILES = [
  'cases-guide.json', 'core-grammar.json', 'core-phrases.json', 'gender-rules.json',
  'grammar-guide.json', 'speaking-guide.json', 'writing-guide.json',
];

function guides(files) {
  const out = [];
  for (const f of files.filter((x) => GUIDE_FILES.includes(x.file.replace('data/', '')))) {
    const name = f.file.replace('data/', '');
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, f.file), 'utf8'));
    const blocks = {};
    for (const k of Object.keys(parsed)) {
      if (!Array.isArray(parsed[k])) continue;
      blocks[k] = parsed[k].length;
      const nestedKey = NESTED[name + ':' + k];
      if (nestedKey) {
        const n = parsed[k].reduce(
          (a, el) => a + (el && Array.isArray(el[nestedKey]) ? el[nestedKey].length : 0), 0);
        blocks[k + '.' + nestedKey] = n;
      }
    }
    out.push({ file: f.file, blocks });
  }
  return out;
}

/* --------------------------------------------------- 10. audio vs browser TTS */

// Extension search over FILE NAMES (any tracked path) + match counting over the
// text of tracked text files. Two scopes are reported separately:
//   runtime : public client code + server.js — what the shipped app can load.
//   other   : tests, research, docs, work reports, prose — not an app dependency.
const AUDIO_EXT = /\.(mp3|ogg|wav|m4a|opus|aac|flac)\b/i;
const AUDIO_EXT_ALL = /\.(mp3|ogg|wav|m4a|opus|aac|flac)\b/gi;
const TTS_ALL = /speechSynthesis|SpeechSynthesisUtterance/g;
const TEXT_EXT = /\.(js|mjs|cjs|json|md|html|css|txt|yml|yaml|ps1|cmd|sql|cs)$/;
const RUNTIME_CODE = /^public\/.*\.(js|mjs|html|css)$/;
// This command's own file holds the two patterns as literals, so it is neither a
// runtime nor a prose reference; it is excluded and the exclusion is reported.
const SELF = 'tools/content-discovery.mjs';

const isRuntimePath = (f) => RUNTIME_CODE.test(f) || f === 'server.js';
const allMatches = (text, re) => (text.match(re) || []).length; // re must be /g: counts every match
const matchTotal = (sites) => sites.reduce((a, s) => a + s.matches, 0);

function audio(tracked) {
  const fixedAudioFiles = tracked.filter((f) => AUDIO_EXT.test(f));
  const scanned = tracked.filter((f) => f !== SELF && TEXT_EXT.test(f));
  const runtime = { media: [], tts: [] };
  const other = { media: [], tts: [] };
  for (const f of scanned) {
    const text = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const bucket = isRuntimePath(f) ? runtime : other;
    const media = allMatches(text, AUDIO_EXT_ALL);
    if (media) bucket.media.push({ file: f, matches: media });
    const tts = allMatches(text, TTS_ALL);
    if (tts) bucket.tts.push({ file: f, matches: tts });
  }
  const byFile = (a, b) => a.file.localeCompare(b.file);
  return {
    inventory: 'git ls-files -z — every tracked path, all directories',
    trackedFilesScanned: tracked.length,
    textExtensionsScanned: ['js', 'mjs', 'cjs', 'json', 'md', 'html', 'css', 'txt', 'yml', 'yaml', 'ps1', 'cmd', 'sql', 'cs'],
    fixedAudioFileCount: fixedAudioFiles.length,
    fixedAudioFiles,
    runtimeScope: 'public/**/*.{js,mjs,html,css} + server.js',
    runtimeAudioMatches: {
      files: runtime.media.sort(byFile),
      sites: runtime.media.length,
      matches: matchTotal(runtime.media),
    },
    runtimeTtsMatches: {
      files: runtime.tts.sort(byFile),
      sites: runtime.tts.length,
      matches: matchTotal(runtime.tts),
    },
    outsideRuntimeAudioMatches: {
      files: other.media.sort(byFile),
      sites: other.media.length,
      matches: matchTotal(other.media),
    },
    outsideRuntimeTtsMatches: {
      files: other.tts.sort(byFile),
      sites: other.tts.length,
      matches: matchTotal(other.tts),
    },
    selfFileExcluded: SELF,
    limits: [
      'the file search is an extension search on tracked file names; audio served through an extensionless path, a query string, a remote URL or a file generated at runtime would not appear',
      'only tracked files are read: audio in ignored, untracked or private trees is out of scope and was not read, so "0 fixed audio files" means "0 in the tracked tree", not "0 anywhere"',
      'prose that mentions mp3 or speechSynthesis in tests, research or reports is not an application dependency and is therefore reported outside the runtime scope',
    ],
  };
}

/* ------------------------------------ governance gaps (facts, not approvals) - */

const GOVERNANCE_FIELDS = ['version', 'rights', 'license', 'review', 'reviewStatus', 'reviewedBy', 'approvedBy', 'date'];

function gaps(files) {
  return files.map((f) => {
    const parsed = JSON.parse(fs.readFileSync(path.join(ROOT, f.file), 'utf8'));
    const present = GOVERNANCE_FIELDS.filter((k) => k in parsed);
    return { file: f.file, declaredSource: typeof parsed.source === 'string', level: parsed.level ?? null, governanceFieldsPresent: present };
  });
}

/* -------------------------------------------------------------- report ------ */

function collect() {
  const tracked = trackedFiles();
  const files = sourceFiles(tracked);
  return {
    root: '.',
    readOnly: true,
    inventory: 'git ls-files -z (read-only, no shell, sorted); tracked files only',
    hashScope: 'byte sizes and hashes describe the bytes of THIS Linux checkout (a CRLF checkout would differ); contentSha12 is over line-ending-normalised content and all counts are checkout-independent',
    counts: { trackedFiles: tracked.length, sourceFiles: files.length },
    files,
    writing: writingPrompts(),
    corpus: corpus(),
    guides: guides(files),
    lexicons: files.filter((f) => LEXICON[f.file.replace('data/', '')])
      .map((f) => ({ file: f.file, entries: JSON.parse(fs.readFileSync(path.join(ROOT, f.file), 'utf8'))[LEXICON[f.file.replace('data/', '')]].length })),
    audio: audio(tracked),
    governance: gaps(files),
  };
}

function text(report) {
  const L = [];
  const p = (...a) => L.push(...a);
  p('CONTENT DISCOVERY — read-only inventory (C-01 discovery slice)');
  p('unit note: counts only; no question/answer text; no approval implied.');
  p('inventory: ' + report.inventory);
  p('hash scope: ' + report.hashScope);
  p('');
  p('[1] source files: ' + report.counts.sourceFiles + ' tracked data/*.json of ' +
    report.counts.trackedFiles + ' tracked files');
  for (const f of report.files) {
    p('    ' + f.file.padEnd(28) + String(f.bytesLinuxCheckout).padStart(7) + ' B (this checkout)  content-sha256:' +
      f.contentSha12 + '  ' + f.blocks.join(' '));
  }
  p('');
  const c = report.corpus.totals;
  p('    units: source file=1 tracked data/*.json | set=1 array element of a family |');
  p('           answer slot=1 graded position | option container=1 slot that offers choices |');
  p('           option entry=1 selectable choice inside a container | pool entry=1 entry of a set-level pool array');
  p('[2-6] seed corpus: families=' + c.families + '  sets=' + c.sets + '  answer slots=' + c.slots +
    '  keyed=' + c.slotsWithAnswer + '  explained=' + c.slotsWithWhy +
    '  complete sets=' + c.completeSets + '/' + c.sets + '  sets with governance fields=' + c.governedSets);
  p('      option containers (LV2 question / SB1 gap slots that hold choices)=' + c.optionContainers +
    '  selectable option entries inside them=' + c.optionEntries);
  p('      family  sets  slots  keyed  explained  complete  slotArray   optContainers  optEntries  poolEntries');
  for (const f of report.corpus.families) {
    const pools = JSON.stringify(f.poolEntries);
    p('      ' + f.family.padEnd(6) + String(f.sets).padStart(4) + String(f.slots).padStart(7) +
      String(f.slotsWithAnswer).padStart(7) + String(f.slotsWithWhy).padStart(11) + String(f.completeSets).padStart(10) +
      '  ' + String(f.slotArray).padEnd(11) + String(f.optionContainers).padStart(14) +
      String(f.optionEntries).padStart(11) + '  ' + pools);
  }
  p('');
  const w = report.writing;
  p('[7] writing: offline prompts=' + w.offlinePrompts + '  per register=' + JSON.stringify(w.promptsPerRegister) +
    '  leitpunkt arrays=' + w.leitpunktArrays + '  leitpunkte total=' + w.leitpunktTotal +
    '  per prompt=' + JSON.stringify(w.leitpunktePerPrompt));
  p('    live generation path present=' + w.liveGenerationPath + '  rubric criteria=' + w.rubricCriteria +
    ' ' + JSON.stringify(w.rubricCriteriaKeys) + '  rubric max sum=' + w.rubricMaxSum);
  p('');
  p('[8-9] guides / lexicons (named block -> element count):');
  for (const g of report.guides) p('    ' + g.file.padEnd(28) + JSON.stringify(g.blocks));
  for (const l of report.lexicons) p('    ' + l.file.padEnd(28) + 'entries=' + l.entries);
  p('');
  const a = report.audio;
  p('[10] audio / TTS — inventory: ' + a.inventory + ' (' + a.trackedFilesScanned + ' tracked files)');
  p('     fixed audio files anywhere in the tracked tree (extension search on path names)=' + a.fixedAudioFileCount +
    (a.fixedAudioFiles.length ? ' -> ' + a.fixedAudioFiles.join(', ') : ' -> none'));
  p('     RUNTIME scope (' + a.runtimeScope + '):');
  p('       fixed-audio extension matches=' + a.runtimeAudioMatches.matches + ' in ' + a.runtimeAudioMatches.sites + ' file(s)  ' +
    JSON.stringify(a.runtimeAudioMatches.files));
  p('       browser-TTS matches (speechSynthesis|SpeechSynthesisUtterance)=' + a.runtimeTtsMatches.matches +
    ' in ' + a.runtimeTtsMatches.sites + ' file(s)  ' + JSON.stringify(a.runtimeTtsMatches.files));
  p('     OUTSIDE runtime scope (tests, research, docs, work reports, prose — not an app dependency):');
  p('       fixed-audio extension matches=' + a.outsideRuntimeAudioMatches.matches + ' in ' + a.outsideRuntimeAudioMatches.sites + ' file(s)  ' +
    JSON.stringify(a.outsideRuntimeAudioMatches.files));
  p('       browser-TTS matches=' + a.outsideRuntimeTtsMatches.matches + ' in ' + a.outsideRuntimeTtsMatches.sites + ' file(s)  ' +
    JSON.stringify(a.outsideRuntimeTtsMatches.files));
  p('     text extensions scanned (grep scope): ' + JSON.stringify(a.textExtensionsScanned) +
    '  self excluded=' + a.selfFileExcluded);
  for (const l of a.limits) p('     limit: ' + l);
  p('');
  p('[gaps] governance fields present per source file (facts only; review/rights remain UNKNOWN):');
  for (const g of report.governance) {
    p('    ' + g.file.padEnd(28) + 'declaredSource=' + String(g.declaredSource).padEnd(5) +
      ' level=' + String(g.level).padEnd(5) + ' governance=' + JSON.stringify(g.governanceFieldsPresent));
  }
  return L.join('\n') + '\n';
}

const report = collect();
process.stdout.write(json ? JSON.stringify(report, null, 2) + '\n' : text(report));
