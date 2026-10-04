#!/usr/bin/env node
/**
 * LISTENING-01 checkpoint 2 — the importable telc Deutsch B1 listening package.
 *
 * WHY THIS EXISTS. The nine HV sets are authored once, in
 * `server/migrations/0010-objective-catalogue.sql`, together with their true/false keys and German
 * explanations. The nine recordings are described once, in
 * `content/exams/telc-deutsch-b1/listening-media.json`, by `tools/listening-tts-build.mjs`. The
 * package below is the third artefact the importer needs (`tools/import-exam-package.mjs`), and it is
 * GENERATED from those two so the questions are never re-typed: a second authored copy of the same
 * text is how the transcript and the question drift apart.
 *
 * SHAPE (frozen by `docs/contracts/EXAM-S5.md` line 11). A `fixed_audio` payload is exactly
 * `{recordings:[{id,mediaId,mediaVersion,label,questions:[{n,question,options}]}]}`, contains no
 * script/transcript/answer/explanation, and each recording pins one exact media identity. The authored
 * `statement` becomes the public `question`; the authored boolean key becomes the `richtig`/`falsch`
 * option, because the option keys are the marked vocabulary.
 *
 * VERSIONS. The v1 payloads are immutable and carry no recordings, so the listening sets are new `v2`
 * sets beside them, and the blueprint is a new `v2` that adds the pinned playback allowance to the HV
 * parts (`EXAM-S5.md` line 13: telc 1/2/2 — one play in practice, one for HV1 and two for HV2/HV3 in a
 * mock attempt). The v1 blueprint and the reading/language forms keep their exact bytes and hashes.
 *
 * REVIEW STATE. Everything here is `unreviewed`/`generated`: machine speech from machine-drafted
 * transcripts. No agent may mark content approved; the package says so in its own source strings.
 *
 * Deterministic: no clock, no network, no provider. Run it, then import the result.
 *
 * Usage: node tools/listening-package-build.mjs
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAM = 'telc-deutsch-b1';
const MIGRATION = path.join(ROOT, 'server', 'migrations', '0010-objective-catalogue.sql');
const MEDIA_PATH = path.join(ROOT, 'content', 'exams', EXAM, 'listening-media.json');
const MANIFEST_PATH = path.join(ROOT, 'content', 'exams', EXAM, 'manifest.json');
const OUT_PATH = path.join(ROOT, 'content', 'exams', EXAM, 'listening-package.json');

/** True/false is the authored telc HV format; the option keys are the marked vocabulary. */
const OPTIONS = Object.freeze({ richtig: 'Richtig', falsch: 'Falsch' });
/** `EXAM-S5.md` line 13: "its telc allowance 1/2/2 respectively". */
const PLAYBACK = Object.freeze({
  HV1: Object.freeze({ practice: 1, mock: 1 }),
  HV2: Object.freeze({ practice: 1, mock: 2 }),
  HV3: Object.freeze({ practice: 1, mock: 2 }),
});
const SET_VERSION = 'v2';
const BLUEPRINT_VERSION = 'v2';
const RELEASE_VERSION = 'v2';
/** One listening test is 5 + 10 + 5 items; the blueprint allots the section ~30 minutes. */
const MOCK_SECONDS = 1800;

/** Every `'{...}'` JSON literal on one SQL line, in order. Doubled SQL quotes and JSON escapes survive. */
function jsonLiterals(line) {
  const out = [];
  let cursor = 0;
  for (;;) {
    const at = line.indexOf("'{", cursor);
    if (at < 0) return out;
    const start = at + 1;
    let index = start, inString = false;
    for (; index < line.length; index++) {
      const character = line[index];
      if (character === '\\') { index++; continue; }
      if (character === '"') inString = !inString;
      if (character === "'" && !inString) break;
    }
    if (index >= line.length) return out;
    try { out.push(JSON.parse(line.slice(start, index))); } catch { /* not a JSON literal we own */ }
    cursor = index + 1;
  }
}

/** The authored HV sets, their keys and their explanations, read out of the migration. */
function readAuthored(source) {
  const sets = new Map();
  const keys = new Map();
  for (const line of source.split(/\r?\n/)) {
    const setRow = line.match(/^\s*\('(telc-deutsch-b1\.hv([123])\.(\d\d))',\s*'([^']+)',\s*'telc-deutsch-b1',\s*'(HV[123])',\s*'HV',\s*(\d+),/);
    if (setRow) {
      const [literal] = jsonLiterals(line);
      if (!literal || !Array.isArray(literal.items)) throw new Error(`authored HV set ${setRow[1]} has no usable payload`);
      sets.set(setRow[1], { setId: setRow[1], part: Number(setRow[2]), version: setRow[4], family: setRow[5], title: literal.title, items: literal.items });
      continue;
    }
    const keyRow = line.match(/^\s*\('(telc-deutsch-b1\.hv[123]\.\d\d)',\s*'([^']+)',\s*'\{/);
    if (keyRow) {
      const [answers, explanations] = jsonLiterals(line);
      if (!answers || !explanations) throw new Error(`authored HV keys ${keyRow[1]} are unreadable`);
      keys.set(keyRow[1], { answers, explanations });
    }
  }
  return { sets, keys };
}

export async function buildListeningPackage() {
  const [migration, mediaDocument, manifestSource] = await Promise.all([
    readFile(MIGRATION, 'utf8'),
    readFile(MEDIA_PATH, 'utf8').then(JSON.parse),
    readFile(MANIFEST_PATH, 'utf8').then(JSON.parse),
  ]);
  const authored = readAuthored(migration);
  const descriptors = new Map((mediaDocument.media || []).map(media => [media.mediaId, media]));

  if (authored.sets.size !== 9) throw new Error(`expected 9 authored HV sets, found ${authored.sets.size}`);
  if (descriptors.size !== authored.sets.size) throw new Error(`expected one media descriptor per set, found ${descriptors.size}`);

  const sets = [];
  for (const set of [...authored.sets.values()].sort((a, b) => a.setId.localeCompare(b.setId))) {
    const keyed = authored.keys.get(set.setId);
    if (!keyed) throw new Error(`authored HV set ${set.setId} has no key row`);
    const mediaId = `${EXAM}.${set.setId.replace(`${EXAM}.`, '')}.audio`;
    const descriptor = descriptors.get(mediaId);
    if (!descriptor) throw new Error(`no media descriptor for ${mediaId}`);

    const questions = [], answers = {}, explanations = {};
    for (const item of set.items) {
      const id = String(item.n);
      if (typeof item.statement !== 'string' || !item.statement.trim()) throw new Error(`${set.setId}: item ${id} has no statement`);
      const marked = keyed.answers[id];
      if (typeof marked !== 'boolean') throw new Error(`${set.setId}: item ${id} has no boolean key`);
      const explanation = keyed.explanations[id];
      if (typeof explanation !== 'string' || !explanation.trim()) throw new Error(`${set.setId}: item ${id} has no explanation`);
      questions.push({ n: item.n, question: item.statement, options: { ...OPTIONS } });
      answers[id] = marked ? 'richtig' : 'falsch';
      explanations[id] = explanation;
    }
    if (questions.length !== set.items.length) throw new Error(`${set.setId}: question loss`);

    sets.push({
      setId: set.setId,
      version: SET_VERSION,
      examId: EXAM,
      family: set.family,
      section: 'HV',
      part: set.part,
      title: set.title,
      payload: { recordings: [{ id: `${set.setId.replace(`${EXAM}.`, '')}-recording`, mediaId, mediaVersion: descriptor.version, label: set.title, questions }] },
      itemCount: questions.length,
      interaction: 'fixed_audio',
      answers,
      explanations,
      reviewStatus: 'unreviewed',
      rightsStatus: 'generated',
      source: `authored in server/migrations/0010-objective-catalogue.sql#${set.setId}; audio built by tools/listening-tts-build.mjs (Google Cloud TTS, de-DE-Standard-G/H) and pinned in content/exams/${EXAM}/listening-media.json`,
    });
  }

  // The published blueprint is the manifest's, with the HV parts gaining the contract's allowance.
  const sections = manifestSource.blueprint.sections.map(section => ({
    ...section,
    parts: section.parts.map(part => (part.mediaRequired ? { ...part, playback: { ...PLAYBACK[part.family] } } : { ...part })),
  }));
  const members = sets
    .filter(set => set.setId.endsWith('.01'))
    .map(set => ({ setId: set.setId, version: set.version, interaction: set.interaction, itemCount: set.itemCount }));
  if (members.length !== 3) throw new Error(`expected three .01 listening sets for the section forms, found ${members.length}`);

  return {
    schemaVersion: 1,
    exam: { ...manifestSource.exam },
    blueprint: { ...manifestSource.blueprint, version: BLUEPRINT_VERSION, sections },
    release: { version: RELEASE_VERSION, state: 'internal', resumeBlockedReleases: [] },
    /*
     * THE EXISTING FORMS ARE CARRIED OVER, and this is not cosmetic. Activating a release REPLACES
     * that release's `exam_release_form` rows with exactly the forms in this package, and the practice
     * and mock cards are listed from the head release (`listReleasedForms`). A listening-only form list
     * would therefore delete reading practice from the learner's list while adding listening - the
     * worst kind of change, because the deploy would look successful.
     *
     * THEY ARE RE-VERSIONED, not reused at v1. A form's identity hash is
     * `packageHash({blueprintVersion, form})`, so the same form under the v2 blueprint is a DIFFERENT
     * record: resubmitting v1 here is rejected as "changed form under existing version". The payload is
     * copied verbatim; only the version moves with the blueprint it is resolved against. The v1 rows
     * stay untouched, so historical runs still resolve.
     */
    forms: [
      ...manifestSource.forms.map(form => ({ ...form, version: SET_VERSION })),
      {
        id: `${EXAM}.listening.practice`, version: SET_VERSION, title: 'Hörverstehen – Übung',
        scope: 'section', sections: ['HV'], mode: 'untimed', timeLimitSeconds: null, feedback: 'finalise',
        attemptMode: 'practice', members: members.map(member => ({ ...member })),
      },
      {
        id: `${EXAM}.listening.mock`, version: SET_VERSION, title: 'Hörverstehen – Prüfungsmodus',
        scope: 'section', sections: ['HV'], mode: 'timed', timeLimitSeconds: MOCK_SECONDS, feedback: 'finalise',
        attemptMode: 'mock', members: members.map(member => ({ ...member })),
      },
    ],
    sets,
    media: [...(mediaDocument.media || [])],
  };
}

async function main() {
  const pkg = await buildListeningPackage();
  await writeFile(OUT_PATH, `${JSON.stringify(pkg, null, 2)}\n`);
  const items = pkg.sets.reduce((total, set) => total + set.itemCount, 0);
  console.log(`${pkg.sets.length} sets, ${pkg.media.length} media, ${items} items in the listening forms' families`);
  console.log(`playback: ${pkg.blueprint.sections.find(s => s.id === 'HV').parts.map(p => `${p.family} ${p.playback.practice}/${p.playback.mock}`).join(', ')}`);
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`listening package build failed: ${error.message}`); process.exitCode = 1; });
}
