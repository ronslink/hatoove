#!/usr/bin/env node
/**
 * LISTENING-01 — build the fixed listening recordings from the authored transcripts.
 *
 * THE CONTENT ALREADY EXISTS. `server/migrations/0010-objective-catalogue.sql` seeds nine HV sets and
 * their `objective_key` rows already carry the answers, the explanations and the full transcript, with
 * speaker labels (`[Sprecherin 1]:`, `[Moderator]:`, `[Durchsage]:`). What has never existed is the
 * AUDIO. This tool is the missing half: it turns those transcripts into the private PCM WAV files the transport
 * already knows how to serve, and emits the metadata the package importer needs.
 *
 * POOL-01 BATCH MODE (`--batch`, task-48). The three listening sets of `content/pool-01/batch-1.json` are
 * authored there, not in `0010`: flipping one from `held` to `released` needs audio that exists, so the same
 * synthesis is run over THAT source and the descriptors are written to
 * `content/exams/telc-deutsch-b1/pool-listening-media.json` — beside the exam's own descriptors, so
 * `tools/media-mount-check.mjs` verifies those bytes too (it walks every `content/exams/**\/*.json`). The
 * transcript is the AUTHORED script; nothing here is re-typed. There is no fake-audio fallback: without the
 * provider key this tool fails, and it never writes a descriptor for audio it did not produce.
 *
 * VOICES (owner decision, 4 October 2026: "female standard voice always or the cheapest"):
 *   `de-DE-Standard-G` (female) and `de-DE-Standard-H` (male) are BOTH in the Standard tier — the
 *   cheapest ($4 per 1M characters after 4M free). The transcript's own labels decide which is which: a female
 *   speaker is `G`, a male speaker is `H`. That is not a preference, it is what the text says, and the tool
 *   FAILS on a label it cannot place rather than silently reading a man's line in a woman's voice. A public
 *   announcement (`Durchsage`, `Ansage 1`…`Ansage 5`) is the male `H`, consistent with the seeded corpus;
 *   `Frau Feldmann` is female because the transcript says she is a woman.
 *
 * OUTPUT IS WAV, NOT MP3. `server/migrations/0029-fixed-media.sql` constrains `exam_media.mime_type` to
 * `audio/wav`, and `server/media-contract.mjs#parsePcmWav` re-parses every byte at publication time. Google's
 * `LINEAR16` response is already a RIFF/WAVE container, so the tool concatenates the speaker turns into one
 * WAV per set and re-derives the header itself.
 *
 * The API key is read from `GOOGLE_TTS_API_KEY` (or `--key-file`, a file containing only the key). It is never
 * accepted as a command-line argument, printed, or written into the output metadata.
 *
 * Usage:
 *   GOOGLE_TTS_API_KEY=... node tools/listening-tts-build.mjs --media-root /abs/private/media [--only hv1.01]
 *   node tools/listening-tts-build.mjs --batch content/pool-01/batch-1.json --media-root D:\Hatoove\content\exams \
 *        --key-file D:\Hatoove\.qa\google-tts-key.txt [--only telc-deutsch-b1.hv1.04] [--descriptors <out>]
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parsePcmWav } from '../server/media-contract.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXAM = 'telc-deutsch-b1';
const MIGRATION = path.join(ROOT, 'server', 'migrations', '0010-objective-catalogue.sql');
const EXAM_MEDIA_DIR = path.join(ROOT, 'content', 'exams', EXAM);
const SAMPLE_RATE = 24000;
const GAP_MS = 700;
/** The listening families. Anything else in a batch source is not audio material. */
const MEDIA_FAMILIES = new Set(['HV1', 'HV2', 'HV3']);

/** Speaker label -> voice. Every label in the seeded transcripts must appear here; see the header. */
const VOICES = Object.freeze({
  'Sprecherin 1': 'de-DE-Standard-G', 'Sprecherin 2': 'de-DE-Standard-G', 'Sprecherin 3': 'de-DE-Standard-G',
  'Sprecherin 4': 'de-DE-Standard-G', 'Sprecherin 5': 'de-DE-Standard-G',
  'Sprecher 1': 'de-DE-Standard-H', 'Sprecher 2': 'de-DE-Standard-H', 'Sprecher 3': 'de-DE-Standard-H',
  'Sprecher 4': 'de-DE-Standard-H', 'Sprecher 5': 'de-DE-Standard-H',
  // HV2 is an interview: the guest is "die Ernährungsberaterin Dr. Karin Baum" — female; the host is male.
  'Gast': 'de-DE-Standard-G', 'Moderator': 'de-DE-Standard-H',
  // HV3 alternates an answering machine and a public announcement.
  'Anrufbeantworter': 'de-DE-Standard-G', 'Durchsage': 'de-DE-Standard-H',
  /*
   * POOL-01 batch 1 (task-48). HV2.04 is an interview with "die Fahrradbeauftragte der Stadt" — the
   * transcript names her `Frau Feldmann` and calls her a woman, so she is G. HV3.04 is five public
   * announcements, the same register as the seeded `Durchsage`, so they are H.
   */
  'Frau Feldmann': 'de-DE-Standard-G',
  'Ansage 1': 'de-DE-Standard-H', 'Ansage 2': 'de-DE-Standard-H', 'Ansage 3': 'de-DE-Standard-H',
  'Ansage 4': 'de-DE-Standard-H', 'Ansage 5': 'de-DE-Standard-H',
});
const NARRATOR = 'de-DE-Standard-G';

function arg(name, fallback = null) {
  const i = process.argv.indexOf('--' + name);
  return i === -1 ? fallback : process.argv[i + 1];
}

/** The nine seeded transcripts, taken from the migration that is their single source of truth. */
function readTranscripts() {
  const sql = fs.readFileSync(MIGRATION, 'utf8');
  const block = sql.slice(sql.indexOf('INSERT INTO "__SCHEMA__".objective_key'));
  const sets = [];
  const row = /\('telc-deutsch-b1\.(hv\d\.\d+)',\s*'v1',\s*'(\{[\s\S]*?\})'::jsonb,\s*'(\{[\s\S]*?\})'::jsonb,\s*'([\s\S]*?)'\),\n/g;
  for (const m of block.matchAll(row)) sets.push({ setId: m[1], version: 'v1', answers: m[2], transcript: m[4] });
  if (sets.length !== 9) throw new Error('expected 9 seeded HV transcripts, found ' + sets.length);
  return sets.map((set) => ({ ...set, setId: `${EXAM}.${set.setId}`, authoredIn: `server/migrations/0010-objective-catalogue.sql#telc-deutsch-b1.${set.setId}` }));
}

/**
 * The listening sets of an authored BATCH source — `content/pool-01/batch-1.json` — which is where the
 * released pool's sets live. A set with no full script is refused rather than synthesised from a fragment.
 */
function readBatchTranscripts(batchPath) {
  const source = JSON.parse(fs.readFileSync(batchPath, 'utf8'));
  const sets = (source.sets ?? []).filter((entry) => MEDIA_FAMILIES.has(entry.family));
  if (!sets.length) throw new Error('the batch source carries no listening set');
  return sets.map((entry) => {
    if (typeof entry.set_id !== 'string' || !entry.set_id.startsWith(`${EXAM}.`)) throw new Error('a batch listening set has no usable set_id');
    if (typeof entry.script !== 'string' || entry.script.trim().length < 300) throw new Error(`${entry.set_id}: no full recording script is authored`);
    return {
      setId: entry.set_id,
      version: 'v1',
      label: typeof entry.title === 'string' ? entry.title : entry.set_id,
      transcript: entry.script,
      authoredIn: `${path.relative(ROOT, batchPath).replaceAll('\\', '/')}#${entry.set_id}`,
    };
  });
}

/** Split a transcript into speaker turns. Text before the first label is narration read in the narrator voice. */
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
    if (part.text.length > 4500) throw new Error('turn exceeds the provider limit');
  }
  return parts.map(part => ({ voice: part.speaker === null ? NARRATOR : VOICES[part.speaker], text: part.text }));
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
      await new Promise(r => setTimeout(r, 1000 * attempt));
      return synthesize(part, key, attempt + 1);
    }
    throw new Error('synthesis failed (' + response.status + '): ' + String(message).slice(0, 200));
  }
  // Google returns a RIFF/WAVE container for LINEAR16; take its PCM payload, not its header.
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

/** One RIFF/WAVE file from the speaker turns, joined by silence. */
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
  header.writeUInt16LE(1, 20);           // PCM
  header.writeUInt16LE(1, 22);           // mono
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);           // block align
  header.writeUInt16LE(16, 34);          // bits
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * Build recordings into `mediaRoot` and write their descriptors.
 *
 * Exported so a caller that already holds the key in memory can run it without the key ever crossing a process
 * boundary or a command line. `batch` (a path to an authored batch source) selects POOL-01 mode; without it the
 * nine seeded recordings of `0010` are rebuilt.
 */
export async function buildListeningMedia({ mediaRoot, key, only = null, batch = null, descriptorsOut = null } = {}) {
  if (!key) throw new Error('a key is required; the key is never a CLI argument');
  if (!mediaRoot || !path.isAbsolute(mediaRoot)) throw new Error('--media-root must be an absolute private directory');

  const batchPath = batch ? path.resolve(ROOT, batch) : null;
  const transcripts = (batchPath ? readBatchTranscripts(batchPath) : readTranscripts())
    .filter((set) => !only || set.setId === only || set.setId === `${EXAM}.${only}`);
  if (!transcripts.length) throw new Error('nothing matched --only ' + String(only));
  const outDir = path.join(mediaRoot, EXAM, 'audio');
  fs.mkdirSync(outDir, { recursive: true });

  const media = [];
  for (const set of transcripts) {
    const segments = segment(set.transcript);
    const rendered = [];
    for (const part of segments) rendered.push(await synthesize(part, key));
    const wav = assemble(rendered);
    const parsed = parsePcmWav(wav);                       // the same parser publication runs
    const digest = createHash('sha256').update(wav).digest('hex');
    const short = set.setId.replace(new RegExp('^' + EXAM + '\\.'), '');
    const file = short + '-' + set.version + '.wav';
    const rel = 'content/exams/' + EXAM + '/audio/' + file;
    fs.writeFileSync(path.join(mediaRoot, EXAM, 'audio', file), wav);
    media.push({
      mediaId: EXAM + '.' + short + '.audio',
      version: set.version, examId: EXAM, path: rel, sha256: digest,
      byteLength: parsed.byteLength, durationMs: parsed.durationMs, mimeType: parsed.mimeType,
      reviewStatus: 'unreviewed', rightsStatus: 'generated',
      source: 'Google Cloud Text-to-Speech, de-DE-Standard-G/H (machine speech); script authored in ' + set.authoredIn,
    });
    console.log('OK ' + set.setId + '  turns=' + segments.length + '  bytes=' + parsed.byteLength + '  duration=' + (parsed.durationMs / 1000).toFixed(1) + 's  voices=' + [...new Set(segments.map(s => s.voice))].join('+'));
  }

  const out = descriptorsOut
    ? path.resolve(ROOT, descriptorsOut)
    : (batchPath ? path.join(EXAM_MEDIA_DIR, 'pool-listening-media.json') : path.join(EXAM_MEDIA_DIR, 'listening-media.json'));
  // A partial run (--only) must not overwrite a full descriptor set with one row: merge by mediaId.
  let existing = [];
  if (only && fs.existsSync(out)) {
    try { existing = (JSON.parse(fs.readFileSync(out, 'utf8')).media ?? []).filter((row) => !media.some((entry) => entry.mediaId === row.mediaId)); }
    catch { existing = []; }
  }
  const document = { schemaVersion: 1, examId: EXAM, generatedBy: 'tools/listening-tts-build.mjs', media: [...existing, ...media] };
  fs.writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
  const chars = transcripts.reduce((n, s) => n + s.transcript.replace(/\s+/g, ' ').trim().length, 0);
  console.log('\n' + media.length + ' recording(s), ' + chars + ' characters synthesised this run.');
  console.log('metadata: ' + path.relative(ROOT, out));
  console.log('media root: ' + mediaRoot);
  return media;
}

function main() {
  const keyFile = arg('key-file');
  return buildListeningMedia({
    mediaRoot: arg('media-root'),
    only: arg('only'),
    batch: arg('batch'),
    descriptorsOut: arg('descriptors'),
    key: process.env.GOOGLE_TTS_API_KEY || (keyFile ? fs.readFileSync(keyFile, 'utf8').trim() : ''),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error('FAILED: ' + error.message); process.exitCode = 1; });
}
