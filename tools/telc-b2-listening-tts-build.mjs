#!/usr/bin/env node
/**
 * TELC-B2-LISTENING-01 — synthesise fixed PCM WAV recordings from
 * `content/exams/telc-deutsch-b2/listening-source.json`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePcmWav } from '../server/media-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAM = 'telc-deutsch-b2';
const SOURCE_PATH = path.join(ROOT, 'content', 'exams', EXAM, 'listening-source.json');
const MEDIA_OUT = path.join(ROOT, 'content', 'exams', EXAM, 'listening-media.json');
const SAMPLE_RATE = 24000;
const GAP_MS = 700;

export const TELC_B2_VOICES = Object.freeze({
  'Nachrichtensprecherin': 'de-DE-Standard-G',
  'Nachrichtensprecher': 'de-DE-Standard-H',
  'Moderator': 'de-DE-Standard-H',
  'Dr. Vogt': 'de-DE-Standard-G',
  'Durchsage': 'de-DE-Standard-H',
  'Anrufbeantworter': 'de-DE-Standard-G',
});
const NARRATOR = 'de-DE-Standard-G';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

export function segmentTranscript(transcript) {
  const parts = [];
  const marker = /\[([^\]]+)\]\s*:/g;
  let last = 0, speaker = null, match;
  while ((match = marker.exec(transcript)) !== null) {
    const body = transcript.slice(last, match.index).trim();
    if (body) parts.push({ speaker, text: body });
    speaker = match[1].trim();
    last = marker.lastIndex;
  }
  const tail = transcript.slice(last).trim();
  if (tail) parts.push({ speaker, text: tail });
  for (const part of parts) {
    if (part.speaker !== null && !(part.speaker in TELC_B2_VOICES)) throw new Error('unmapped speaker label: ' + part.speaker);
    if (!part.text) throw new Error('empty speaker turn');
    if (part.text.length > 4500) throw new Error('turn exceeds provider limit');
  }
  return parts.map((part) => ({ voice: part.speaker === null ? NARRATOR : TELC_B2_VOICES[part.speaker], text: part.text }));
}

async function synthesize(part, key, attempt = 1) {
  const response = await fetch('https://texttospeech.googleapis.com/v1/text:synthesize?key=' + encodeURIComponent(key), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      input: { text: part.text },
      voice: { languageCode: 'de-DE', name: part.voice },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: SAMPLE_RATE, speakingRate: 1.0, pitch: 0.0 },
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.audioContent) {
    const message = body?.error?.message ?? ('HTTP ' + response.status);
    if (attempt < 3 && (response.status === 429 || response.status >= 500)) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      return synthesize(part, key, attempt + 1);
    }
    throw new Error('synthesis failed (' + response.status + '): ' + String(message).slice(0, 200));
  }
  const wav = Buffer.from(body.audioContent, 'base64');
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') throw new Error('provider did not return WAV');
  let offset = 12, fmt = null, data = null;
  while (offset + 8 <= wav.length) {
    const type = wav.toString('ascii', offset, offset + 4);
    const size = wav.readUInt32LE(offset + 4);
    const begin = offset + 8;
    if (type === 'fmt ') {
      fmt = { channels: wav.readUInt16LE(begin + 2), sampleRate: wav.readUInt32LE(begin + 4), bits: wav.readUInt16LE(begin + 14) };
    }
    if (type === 'data') data = wav.subarray(begin, begin + size);
    offset = begin + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('provider WAV has no fmt/data chunk');
  if (fmt.channels !== 1 || fmt.bits !== 16 || fmt.sampleRate !== SAMPLE_RATE) {
    throw new Error('unexpected provider format ' + JSON.stringify(fmt));
  }
  return data;
}

function assemble(segments) {
  const silence = Buffer.alloc((SAMPLE_RATE * GAP_MS) / 1000 * 2);
  const chunks = [];
  segments.forEach((s, i) => { if (i) chunks.push(silence); chunks.push(s); });
  const pcm = Buffer.concat(chunks);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function main() {
  const mediaRoot = arg('media-root');
  const keyFile = arg('key-file');
  const only = arg('only');
  if (!mediaRoot || !path.isAbsolute(mediaRoot)) throw new Error('--media-root must be an absolute path');
  const key = (process.env.GOOGLE_TTS_API_KEY || (keyFile ? fs.readFileSync(keyFile, 'utf8') : '')).trim();
  if (!key) throw new Error('missing GOOGLE_TTS_API_KEY or --key-file');

  const source = JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf8'));
  const outDir = path.join(mediaRoot, 'content', 'exams', EXAM, 'audio');
  fs.mkdirSync(outDir, { recursive: true });
  const descriptors = [];

  for (const part of source.parts) {
    for (const rec of part.recordings) {
      if (only && rec.id !== only) continue;
      const turns = segmentTranscript(rec.transcript);
      const pcmList = [];
      for (const turn of turns) pcmList.push(await synthesize(turn, key));
      const wav = assemble(pcmList);
      const parsed = parsePcmWav(wav);
      const filename = rec.id.replace('-', '.') + '-' + rec.mediaVersion + '.wav';
      const relPath = `content/exams/${EXAM}/audio/${filename}`;
      fs.writeFileSync(path.join(outDir, filename), wav);
      const sha256 = createHash('sha256').update(wav).digest('hex');
      descriptors.push({
        mediaId: rec.mediaId,
        version: rec.mediaVersion,
        examId: EXAM,
        path: relPath,
        sha256,
        byteLength: wav.length,
        durationMs: parsed.durationMs,
        mimeType: 'audio/wav',
        reviewStatus: 'unreviewed',
        rightsStatus: 'generated',
        source: `Google Cloud Text-to-Speech, de-DE-Standard-G/H (machine speech); script authored in content/exams/${EXAM}/listening-source.json#${rec.id}`,
      });
      console.log(`SYNTH ${rec.id} -> ${relPath} (${wav.length} bytes, ${parsed.durationMs} ms)`);
    }
  }
  if (!only) fs.writeFileSync(MEDIA_OUT, JSON.stringify({ schemaVersion: 1, examId: EXAM, generatedBy: 'tools/telc-b2-listening-tts-build.mjs', media: descriptors }, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exitCode = 1; });
}
