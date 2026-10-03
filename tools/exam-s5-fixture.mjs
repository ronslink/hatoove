/** S5 technical audio fixtures, never learner material or educational/rights approval. */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const S5_FIXTURE_NOTICE = 'Interne Technikprobe: künstliche Signaltöne, keine geprüften Hörtexte.';
export const S5_EXAMS = Object.freeze(['telc-deutsch-b1', 'dtz-a2-b1']);

/** Deterministic 8 kHz mono PCM signal, with a short fade to avoid clicking. No speech/voice/provider. */
export function s5AudioBytes({ durationMs = 2000, frequency = 440 } = {}) {
  if (!Number.isInteger(durationMs) || durationMs < 250 || durationMs > 30000) throw new TypeError('Invalid synthetic duration');
  const sampleRate = 8000, count = durationMs * 8;
  const bytes = Buffer.alloc(44 + count * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) {
    const fade = Math.min(1, i / 160, (count - 1 - i) / 160);
    bytes.writeInt16LE(Math.round(900 * fade * Math.sin(2 * Math.PI * frequency * i / sampleRate)), 44 + i * 2);
  }
  return bytes;
}

/** Writes only a caller-owned synthetic media root and returns the strict package input. */
export async function createListeningFixture({ examId = 'dtz-a2-b1', mediaRoot, version = 'v1',
  releaseVersion = 'v9001', blueprintVersion = 'v9000', durationMs = 2000 } = {}) {
  if (!S5_EXAMS.includes(examId) || typeof mediaRoot !== 'string' || !path.isAbsolute(mediaRoot)) throw new TypeError('Explicit synthetic exam/media root required');
  if (![version, releaseVersion, blueprintVersion].every(v => /^v\d{1,4}$/.test(v))) throw new TypeError('Invalid fixture version');
  const dtz = examId === 'dtz-a2-b1';
  const counts = dtz ? [4, 5, 8, 3] : [5, 10, 5];
  const recordingCounts = dtz ? [4, 5, 4, 3] : [5, 1, 5];
  const media = [], sets = [];
  let questionNumber = 1;
  for (let part = 1; part <= counts.length; part++) {
    const recordings = [], answers = {};
    for (let r = 1; r <= recordingCounts[part - 1]; r++) {
      const mediaId = `s5.${examId}.hv${part}.signal${r}`;
      const relative = `${examId}/s5-technical/${version}/hv${part}-${r}.wav`;
      const bytes = s5AudioBytes({ durationMs, frequency: 330 + part * 40 + r * 13 });
      const target = path.resolve(mediaRoot, ...relative.split('/'));
      if (!target.startsWith(path.resolve(mediaRoot) + path.sep)) throw new Error('Unsafe synthetic audio target');
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
      media.push({ mediaId, version, examId, path: `content/exams/${relative}`,
        sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, durationMs,
        mimeType: 'audio/wav', reviewStatus: 'unreviewed', rightsStatus: 'generated',
        source: 'synthetic:exam-s5-fixture; original deterministic PCM signal; no spoken content or human review' });
      const questions = [];
      const perRecording = counts[part - 1] / recordingCounts[part - 1];
      for (let q = 0; q < perRecording; q++) {
        const n = questionNumber++;
        const mixedBoolean = !dtz || (part === 3 && q === 0);
        const options = mixedBoolean ? { richtig: 'Richtig', falsch: 'Falsch' }
          : part === 4 ? { a: 'Aussage A', b: 'Aussage B', c: 'Aussage C', d: 'Aussage D', e: 'Aussage E', f: 'Aussage F' }
            : { a: 'Antwort A', b: 'Antwort B', c: 'Antwort C' };
        questions.push({ n, question: `Technikprobe ${n}: Bitte wählen Sie eine Testantwort.`, options });
        answers[String(n)] = Object.keys(options)[(n - 1) % Object.keys(options).length];
      }
      recordings.push({ id: `recording-${part}-${r}`, mediaId, mediaVersion: version,
        label: `Technisches Testsignal ${part}.${r}`, questions });
    }
    sets.push({ setId: `s5.${examId}.hv${part}`, version, examId, family: `HV${part}`, section: 'HV', part,
      title: `Hören Teil ${part} · interne Technikprobe`, payload: { recordings }, itemCount: counts[part - 1],
      interaction: 'fixed_audio', answers,
      explanations: Object.fromEntries(Object.keys(answers).map(id => [id, 'Nur eine technische Testantwort, keine sprachliche Bewertung.'])),
      reviewStatus: 'unreviewed', rightsStatus: 'generated', source: 'synthetic:exam-s5-fixture; no educational approval' });
  }
  const members = sets.map(s => ({ setId: s.setId, version: s.version, interaction: s.interaction, itemCount: s.itemCount }));
  return { schemaVersion: 1,
    exam: { id: examId, title: dtz ? 'Deutsch-Test für Zuwanderer (DTZ), A2–B1' : 'Zertifikat Deutsch / telc Deutsch B1',
      language: 'de', levelModel: { type: 'cefr', levels: dtz ? ['A2', 'B1'] : ['B1'] } },
    blueprint: { version: blueprintVersion, sections: [{ id: 'HV', title: 'Hörverstehen',
      parts: sets.map((s, i) => ({ family: s.family, itemCount: s.itemCount, interaction: 'fixed_audio', mediaRequired: true,
        playback: { practice: dtz || i === 0 ? 1 : 2, mock: dtz || i === 0 ? 1 : 2 } })) }],
      assessment: { policy: 'objective-count-v1', correct: 1, incorrect: 0 } },
    release: { version: releaseVersion, state: 'internal', resumeBlockedReleases: [] },
    forms: ['practice', 'mock'].map(attemptMode => ({ id: `s5.${examId}.listening.${attemptMode}`, version,
      title: `Hören · interne Technikprobe (${attemptMode === 'practice' ? 'Übung' : 'Prüfungsmodus'})`,
      scope: 'section', sections: ['HV'], mode: attemptMode === 'practice' ? 'untimed' : 'timed',
      timeLimitSeconds: attemptMode === 'practice' ? null : dtz ? 1500 : 1800,
      attemptMode, feedback: 'finalise', members })), sets, media };
}
