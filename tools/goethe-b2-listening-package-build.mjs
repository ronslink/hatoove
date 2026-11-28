#!/usr/bin/env node
/**
 * GOETHE-B2-LISTENING-01 — deterministic builder for `content/exams/goethe-zertifikat-b2/listening-package.json`.
 * Emits blueprint `v2` / release `v2` (`state: "internal"`) containing:
 *   1. `goethe-zertifikat-b2.complete.original01@v1` (LV 3900s + HV 2400s + SA 4500s = 10800s)
 *   2. `goethe-zertifikat-b2.listening.practice@v1`  (untimed HV section practice)
 *   3. `goethe-zertifikat-b2.listening.mock@v1`      (timed 2400s HV section mock)
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePackage } from '../server/package-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAM = 'goethe-zertifikat-b2';
const DIR = path.join(ROOT, 'content', 'exams', EXAM);
const SOURCE_PATH = path.join(DIR, 'listening-source.json');
const MEDIA_PATH = path.join(DIR, 'listening-media.json');
const MANIFEST_PATH = path.join(DIR, 'manifest.json');
const OUT_PATH = path.join(DIR, 'listening-package.json');

const BLUEPRINT_VERSION = 'v4';
const RELEASE_VERSION = 'v4';
const LV_SECONDS = 3900;
const HV_SECONDS = 2400;
const SA_SECONDS = 4500;

export async function buildGoetheB2ListeningPackage() {
  const [source, mediaDoc, manifest] = await Promise.all([
    readFile(SOURCE_PATH, 'utf8').then(JSON.parse),
    readFile(MEDIA_PATH, 'utf8').then(JSON.parse),
    readFile(MANIFEST_PATH, 'utf8').then(JSON.parse),
  ]);

  const descriptors = new Map((mediaDoc.media || []).map((m) => [m.mediaId, m]));
  const hvSets = [];
  const hvParts = [];

  for (const part of source.parts) {
    const recordings = [];
    const answers = {};
    const explanations = {};
    let itemCount = 0;

    for (const rec of part.recordings) {
      const desc = descriptors.get(rec.mediaId);
      if (!desc) throw new Error(`missing media descriptor for ${rec.mediaId}`);
      const questions = [];
      for (const q of rec.questions) {
        questions.push({ n: q.n, question: q.question, options: q.options });
        answers[String(q.n)] = q.answer;
        explanations[String(q.n)] = q.explanation;
        itemCount += 1;
      }
      recordings.push({
        id: rec.id,
        mediaId: desc.mediaId,
        mediaVersion: desc.version,
        label: rec.label,
        questions,
      });
    }

    hvParts.push({
      family: part.family,
      itemCount,
      interaction: 'fixed_audio',
      mediaRequired: true,
      playback: structuredClone(part.playback),
    });

    hvSets.push({
      setId: `${EXAM}.${part.family.toLowerCase()}.original01`,
      version: 'v1',
      examId: EXAM,
      family: part.family,
      section: 'HV',
      part: part.part,
      title: part.title,
      payload: { recordings },
      itemCount,
      interaction: 'fixed_audio',
      answers,
      explanations,
      reviewStatus: 'unreviewed',
      rightsStatus: 'generated',
      source: source.source,
    });
  }

  const lvSection = structuredClone(manifest.blueprint.sections.find((s) => s.id === 'LV'));
  const saSection = structuredClone(manifest.blueprint.sections.find((s) => s.id === 'SA'));
  lvSection.timeGroup = 'goethe-b2-lv-65';
  saSection.timeGroup = 'goethe-b2-sa-75';

  const hvSection = {
    id: 'HV',
    title: 'Hören',
    timeGroup: 'goethe-b2-hv-40',
    parts: hvParts,
  };

  const lvMembers = structuredClone(manifest.forms[0].members);
  const hvMembers = hvSets.map((s) => ({
    setId: s.setId,
    version: s.version,
    interaction: s.interaction,
    itemCount: s.itemCount,
  }));
  const writingTasks = structuredClone(manifest.forms[1].writingTasks);

  const pkg = {
    schemaVersion: 1,
    exam: structuredClone(manifest.exam),
    blueprint: {
      version: BLUEPRINT_VERSION,
      timeGroups: [
        { id: 'goethe-b2-lv-65', seconds: LV_SECONDS, sections: ['LV'] },
        { id: 'goethe-b2-hv-40', seconds: HV_SECONDS, sections: ['HV'] },
        { id: 'goethe-b2-sa-75', seconds: SA_SECONDS, sections: ['SA'] },
      ],
      sections: [lvSection, hvSection, saSection],
      assessment: structuredClone(manifest.blueprint.assessment),
      sources: structuredClone(manifest.blueprint.sources),
    },
    release: {
      version: RELEASE_VERSION,
      state: 'internal',
      resumeBlockedReleases: [],
    },
    forms: [
      {
        id: `${EXAM}.complete.original01`,
        version: 'v2',
        title: 'Schriftliche Prüfung · Goethe-Zertifikat B2 (Lesen, Hören, Schreiben)',
        scope: 'complete_supported_written',
        sections: ['LV', 'HV', 'SA'],
        mode: 'timed',
        timeLimitSeconds: LV_SECONDS + HV_SECONDS + SA_SECONDS,
        attemptMode: 'mock',
        timingPolicy: 'ordered-fixed-v1',
        feedback: 'finalise',
        members: [...lvMembers, ...hvMembers],
        writingTasks,
      },
      {
        id: `${EXAM}.listening.practice`,
        version: 'v2',
        title: 'Hören · Übung (Goethe-Zertifikat B2)',
        scope: 'section',
        sections: ['HV'],
        mode: 'untimed',
        timeLimitSeconds: null,
        attemptMode: 'practice',
        feedback: 'finalise',
        members: hvMembers,
      },
      {
        id: `${EXAM}.listening.mock`,
        version: 'v2',
        title: 'Hören · Prüfungsmodus (Goethe-Zertifikat B2)',
        scope: 'section',
        sections: ['HV'],
        mode: 'timed',
        timeLimitSeconds: HV_SECONDS,
        attemptMode: 'mock',
        feedback: 'finalise',
        members: hvMembers,
      },
    ],
    sets: [...structuredClone(manifest.sets), ...hvSets],
    media: structuredClone(mediaDoc.media),
    writingTasks: structuredClone(manifest.writingTasks),
    rubrics: structuredClone(manifest.rubrics),
  };

  validatePackage(pkg);
  return pkg;
}

async function main() {
  const pkg = await buildGoetheB2ListeningPackage();
  await writeFile(OUT_PATH, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${path.relative(ROOT, OUT_PATH)} (${pkg.forms.length} forms, ${pkg.sets.length} sets, ${pkg.media.length} media, ${pkg.writingTasks.length} writing tasks)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('FAILED: ' + error.message); process.exitCode = 1; });
}
