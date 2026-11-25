# DTZ A2–B1 — original internal listening and complete written package (`dtz-a2-b1`)

This directory now holds the **original, generated, internal** listening package and complete written
package input for `dtz-a2-b1`, alongside the existing reading (`manifest.json`) and writing
(`writing-manifest.json`) inputs.

## Files

- `listening-source.json` — Authored original German A2–B1 listening scripts (with explicit speaker
  labels), questions, options, answer keys and German explanations for `HV1`–`HV4` (20 items, IDs
  `1`–`20`, 16 recordings).
- `audio/hv1.01-v1.wav` … `audio/hv4.03-v1.wav` — 16 fixed 24 kHz mono 16-bit PCM WAV recordings
  synthesised from `listening-source.json` via Google Cloud Text-to-Speech Standard German voices
  (`de-DE-Standard-G` female, `de-DE-Standard-H` male).
- `listening-media.json` — SHA-256, byte length and PCM duration descriptors emitted by
  `tools/dtz-listening-tts-build.mjs`.
- `listening-package.json` — Deterministic importable package (`blueprint` `v4`, `release` `v4`,
  `state: "internal"`) built by `tools/dtz-listening-package-build.mjs`, combining:
  - `dtz-a2-b1.complete.original01@v1` (`complete_supported_written`, `HV` 25 min + `LV` 45 min +
    `SA` 30 min = 6000 s, `ordered-fixed-v1`, 9 objective sets `HV1`–`HV4` + `LV1`–`LV5`, writing
    choices `A`/`B`),
  - `dtz-a2-b1.listening.practice@v1` (untimed `HV` section practice),
  - `dtz-a2-b1.listening.mock@v1` (timed 1500 s `HV` section mock).

## Listening shape (20 items, IDs 1–20, 16 recordings, playback 1/1)

| Family | Part | Recordings | Items | IDs | Shape |
| ------ | ---- | ---------- | ----- | --- | ----- |
| HV1 | 1 | 4 | 4 | 1–4 | Public announcements & messages (`a`/`b`/`c`) |
| HV2 | 2 | 5 | 5 | 5–9 | Short radio announcements (`a`/`b`/`c`) |
| HV3 | 3 | 4 | 8 | 10–17 | Everyday dialogues (2 items each: `richtig`/`falsch` + `a`/`b`/`c`) |
| HV4 | 4 | 3 | 3 | 18–20 | Radio listener opinions matched to 6 statements (`a`–`f`) |

Every DTZ listening part enforces `playback: { practice: 1, mock: 1 }`.

## Provenance and review status

- **Originality:** All transcripts, questions, options, answers and German explanations were
  independently authored for Hatoove. No official DTZ, telc or g.a.s.t. text or audio was copied or
  reproduced.
- **Audio provenance:** Offline AI-generated PCM WAV recordings (`Google Cloud Text-to-Speech`,
  `de-DE-Standard-G`/`H`), permitted under Ron's 5 October 2026 D10 amendment with recorded
  provenance and human review still required.
- **Review status:** Every set, recording, writing task and rubric remains `reviewStatus: "unreviewed"`
  and `rightsStatus: "generated"`, and `release.state` remains `"internal"`. Qualified human
  educational/audio review is required before marking content approved or enabling `dtz-a2-b1` in
  `ENABLED_EXAM_IDS`.

## Building and checking

```bash
# Re-synthesise audio (requires Google TTS API key, never commit keys):
node tools/dtz-listening-tts-build.mjs --media-root "$PWD/content/exams" --key-file <path>

# Deterministically rebuild listening-package.json:
node tools/dtz-listening-package-build.mjs

# Validate package contract, determinism, privacy and audio integrity:
node tools/dtz-listening-check.mjs
node tools/media-mount-check.mjs --require-recordings
```
