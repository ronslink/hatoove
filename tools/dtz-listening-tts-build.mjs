#!/usr/bin/env node
/**
 * DTZ-LISTENING-01 — synthesise fixed PCM WAV recordings from `content/exams/dtz-a2-b1/listening-source.json`.
 *
 * Uses Google Cloud Text-to-Speech Standard German voices (`de-DE-Standard-G` female, `de-DE-Standard-H` male),
 * matching `tools/listening-tts-build.mjs`. Output is 24 kHz mono 16-bit LINEAR16 RIFF/WAVE, re-parsed through
 * `server/media-contract.mjs#parsePcmWav` before writing descriptors to
 * `content/exams/dtz-a2-b1/listening-media.json`.
 *
 * The API key is read from `GOOGLE_TTS_API_KEY` or `--key-file`. Never passed as a CLI value, printed or stored.
 *
 * Usage:
 *   node tools/dtz-listening-tts-build.mjs --media-root <abs-dir> --key-file <path> [--only hv1-01]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePcmWav } from '../server/media-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAM = 'dtz-a2-b1';
const SOURCE_PATH = path.join(ROOT, 'content', 'exams', EXAM, 'listening-source.json');
const MEDIA_OUT = path.join(ROOT, 'content', 'exams', EXAM, 'listening-media.json');
const SAMPLE_RATE = 24000;
const GAP_MS = 700;

const VOICES = Object.freeze({
  'Durchsage': 'de-DE-Standard-H',
  'Anrufbeantworter': 'de-DE-Standard-G',
  'Moderator': 'de-DE-Standard-H',
  'Moderatorin': 'de-DE-Standard-G',
  'Mitarbeiter': 'de-DE-Standard-H',
  'Kundin': 'de-DE-Standard-G',
  'Sprecherin 1': 'de-DE-Standard-G',
  'Sprecherin 2': 'de-DE-Standard-G',
  'Sprecherin 3': 'de-DE-Standard-G',
  'Sprecherin 4': 'de-DE-Standard-G',
  'Sprecher 1': 'de-DE-Standard-H',
  'Sprecher 2': 'de-DE-Standard-H',
  'Sprecher 3': 'de-DE-Standard-H',
  'Sprecher 4': 'de-DE-Standard-H',
  'Sprecher 5': 'de-DE-Standard-H',
});
const NARRATOR = 'de-DE-Standard-G';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

function segment(transcript) {
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
    if (part.speaker !== null && !(part.speaker in VOICES)) throw new Error('unmapped speaker label: ' + part.speaker);
    if (!part.text) throw new Error('empty speaker turn');
    if (part.text.length > 4500) throw new Error('turn exceeds provider limit');
  }
  return parts.map((part) => ({ voice: part.speaker === null ? NARRATOR : VOICES[part.speaker], text: part.text }));
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

export async function buildDtzListeningMedia({ mediaRoot, key, only = null } = {}) {
  if (!key) throw new Error('a key is required; the key is never a CLI argument');
  if (!mediaRoot || !path.isAbsolute(mediaRoot)) throw new Error('--media-root must be an absolute directory');

  const source = JSON.parse(fs.readFileSync(SOURCE_PATH, 'utf8'));
  const version = source.setVersion || 'v1';
  const entries = [];
  for (const part of source.parts || []) {
    for (const rec of part.recordings || []) {
      entries.push({ part: part.part, family: part.family, rec, version });
    }
  }
  const selected = entries.filter((e) => !only || e.rec.id === only || e.rec.mediaId === only);
  if (!selected.length) throw new Error('nothing matched --only ' + String(only));

  const outDir = path.join(mediaRoot, EXAM, 'audio');
  fs.mkdirSync(outDir, { recursive: true });

  const media = [];
  let chars = 0;
  for (const { rec, version: ver } of selected) {
    const segments = segment(rec.transcript);
    const rendered = [];
    for (const turn of segments) rendered.push(await synthesize(turn, key));
    const wav = assemble(rendered);
    const parsed = parsePcmWav(wav);
    const digest = createHash('sha256').update(wav).digest('hex');
    const short = rec.id.replace('-', '.'); // hv1-01 -> hv1.01
    const file = `${short}-${ver}.wav`;
    const rel = `content/exams/${EXAM}/audio/${file}`;
    fs.writeFileSync(path.join(outDir, file), wav);
    chars += rec.transcript.replace(/\s+/g, ' ').trim().length;
    media.push({
      mediaId: rec.mediaId,
      version: ver,
      examId: EXAM,
      path: rel,
      sha256: digest,
      byteLength: parsed.byteLength,
      durationMs: parsed.durationMs,
      mimeType: parsed.mimeType,
      reviewStatus: 'unreviewed',
      rightsStatus: 'generated',
      source: `Google Cloud Text-to-Speech, de-DE-Standard-G/H (machine speech); script authored in content/exams/${EXAM}/listening-source.json#${rec.id}`,
    });
    console.log(`OK ${rec.id}  turns=${segments.length}  bytes=${parsed.byteLength}  duration=${(parsed.durationMs / 1000).toFixed(1)}s  voices=${[...new Set(segments.map((s) => s.voice))].join('+')}`);
  }

  let existing = [];
  if (only && fs.existsSync(MEDIA_OUT)) {
    try { existing = (JSON.parse(fs.readFileSync(MEDIA_OUT, 'utf8')).media ?? []).filter((row) => !media.some((m) => m.mediaId === row.mediaId)); }
    catch { existing = []; }
  }
  const allMedia = [...existing, ...media].sort((a, b) => a.mediaId.localeCompare(b.mediaId));
  const doc = { schemaVersion: 1, examId: EXAM, generatedBy: 'tools/dtz-listening-tts-build.mjs', media: allMedia };
  fs.writeFileSync(MEDIA_OUT, JSON.stringify(doc, null, 2) + '\n');
  console.log(`\n${media.length} recording(s), ${chars} characters synthesised this run.`);
  console.log('metadata: ' + path.relative(ROOT, MEDIA_OUT));
  return allMedia;
}

function main() {
  const keyFile = arg('key-file');
  return buildDtzListeningMedia({
    mediaRoot: arg('media-root'),
    only: arg('only'),
    key: process.env.GOOGLE_TTS_API_KEY || (keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : ''),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error('FAILED: ' + error.message); process.exitCode = 1; });
}
