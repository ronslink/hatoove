# POOL-01 — the listening release (task-48)

**Status: DELIVERED, NOT REVIEWED, NOT DEPLOYED.** Branch `codex/pool-01-listening-release` off `daaff6b`.
No production system, droplet or `/opt/hatoove` path was touched, and nothing was pushed.

## 1. What was released, and on whose authority

POOL-01 batch 1 (task-37) authored six sets: three LV1 sets and three listening sets. The listening three
(`telc-deutsch-b1.hv1.04`, `hv2.04`, `hv3.04`) were **held** because they had no audio — a Hörverstehen set
whose recording cannot play must not enter the pool (contract A11(b); POOL-01 lease rule 2).

Ron authorised **AI synthesis of the three recordings AND the release of all three into the served pool**.
That is what this slice does. The sets, the recordings and the descriptors all stay `unreviewed` /
`generated`: machine speech from machine-drafted scripts. **No check, migration or tool in this slice marks
content or translations `approved` or `reviewed`**, and none makes an exam-validity claim.

## 2. The recordings (machine speech, Google Cloud TTS, de-DE-Standard-G/H)

| set | file | sha256 | bytes | duration | turns | voices |
|---|---|---|---|---|---|---|
| `hv1.04` | `content/exams/telc-deutsch-b1/audio/hv1.04-v1.wav` | `b7298156a2de5b9b02fe88537433fbc662a078ecf41d631e640d3e9d220ec8f5` | 3,631,568 | 75,657 ms | 5 | H + G (`Sprecher 1/3/5` H, `Sprecherin 2/4` G) |
| `hv2.04` | `content/exams/telc-deutsch-b1/audio/hv2.04-v1.wav` | `324e3e35b43994f5713ef9b46eafebbaa9f6d6c49705b03854885749b4519582` | 7,871,966 | 163,998 ms | 13 | H + G (`Moderator` H, `Frau Feldmann` G) |
| `hv3.04` | `content/exams/telc-deutsch-b1/audio/hv3.04-v1.wav` | `a884cc459f3d352154d916be58f1477f3e2218cc78b793e81ea4ed11828c96ad` | 3,558,248 | 74,129 ms | 5 | H only (`Ansage 1`–`Ansage 5`) |

- **5,387 characters synthesised** in total; 15,061,782 bytes (≈ 14.4 MiB) of new tracked audio.
- VOICES extends the existing map and keeps the FAIL-on-unmapped-label rule: `Frau Feldmann` and
  `Sprecherin 2/4` are female `de-DE-Standard-G`; `Ansage 1`–`Ansage 5` are `de-DE-Standard-H`, the same
  public-announcement register as the seeded `Durchsage`.
- Descriptors: `content/exams/telc-deutsch-b1/pool-listening-media.json` (mediaId, version, path, sha256,
  byteLength, durationMs, mimeType, `reviewStatus: unreviewed`, `rightsStatus: generated`, machine-speech
  `source`). It lives under `content/exams/` so `tools/media-mount-check.mjs` verifies those bytes too.
- The synthesis needed only `--key-file D:\Hatoove\.qa\google-tts-key.txt` (gitignored; never printed, never
  committed, never a CLI argument).

## 3. The change set

| file | change |
|---|---|
| `tools/listening-tts-build.mjs` | POOL-01 batch mode (`--batch`, `--media-root`, `--descriptors`), the five new voice labels |
| `tools/build-objective-migration.mjs` | `--batch` now emits the audio's own `content_version` / `content_rights` / `exam_media` rows for a released listening set that carries a `recordings[]` binding; descriptors are validated with the media contract's own rule; a released listening set with no binding, or with a binding whose audio was never built, is a named error |
| `content/pool-01/batch-1.json` | the three sets gain their `recordings[]` binding and flip to `released`; a `listening_release` provenance block records what was built and what is still owed |
| `content/exams/telc-deutsch-b1/pool-listening-media.json` | new, generated descriptor document (3 rows) |
| `content/exams/telc-deutsch-b1/audio/hv{1,2,3}.04-v1.wav` | new, tracked plain WAVs (A12(1) precedent: `*.wav binary`) |
| `server/migrations/0048-pool-01-listening-release.sql` | new forward migration, GENERATED (`--batch … --out …`) |
| `server/migrations/MANIFEST.json` | the `0048-pool-01-listening-release` line, sha256 of the file's bytes |
| `tools/pool-01-check.mjs` | legs 1–8 rewritten/extended (audio binding, frozen 0047 half, 0048 rows, reader verification) plus the media mutation axis |
| `tools/practice-runner-check.mjs` | pool is 31 sets (HV 4 each); the three sets must be present with their binding; corpus de-duplicated per set id |
| `tools/exam-s5-package-pg-check.mjs`, `tools/exam-s5{b,-}-browser-check.mjs` | the fixture's `exam_media` count is scoped to its own `s5.*` imports; "count must not change" became "may add rows, never rewrite one" |

**Applied migrations 0001–0047 were not edited** (`git diff daaff6b -- server/migrations` touches only
`MANIFEST.json` and adds `0048`), `data/seed.json` is untouched, and the frozen `0010` is still byte-identical
to its source (its own `--check` leg, plus `eol-hash-check`).

`0048` is generated from the same batch source as `0047`, so it carries the three LV1 rows **again** — a
no-op under `ON CONFLICT … DO NOTHING`, and `tools/pool-01-check.mjs` leg 4 compares the replayed LV1 half
line for line with the rows the frozen `0047` applied, so the replay cannot hide a content edit.

## 4. Evidence

- `node tools/run-gates.mjs mirror` → **14/14**; `node tools/run-gates.mjs baseline` → **9/9**;
  `node tools/run-gates.mjs mirror-db` → **7/7** against a disposable `postgres:17-alpine` on
  `127.0.0.1:55493` (`OWNAPI_PG_ALLOW=1`, database `hatoove_pool48`; container removed afterwards).
- `node tools/practice-runner-check.mjs --mutations` → 4/4 mutations fail exactly the intended leg.
- `node tools/exam-s5-package-pg-check.mjs` → 15 passed (real package import leg skipped without a private
  root, as designed); `exam-s5-media-pg-check` → 19 passed; `readiness-pg-check`, `deletion-check`,
  `worker-runner-check`, `session-lifecycle-check` → green.
- Mutation evidence in `tools/pool-01-check.mjs` (each mutation is applied to a throwaway copy and the leg
  that must fail is named in the run's `MUTATION` lines):

| mutation | leg that fails |
|---|---|
| M1 a released listening set loses its `recordings[]` binding | leg 1 |
| M1b a released listening set is marked held again | leg 1 |
| M2 an LV1 answer is not one of the headlines | leg 1 |
| M3 a released set is dropped from the batch | leg 3 |
| M5 a confirmed key duplicates another text's answer | leg 1 |
| M6 a confirmed key is changed after the decision | leg 3 |
| M7 the reworded headline reverts to the rejected wording | leg 3 |
| M4 the builder stops stripping answer fields | leg 5 (0010 no longer matches its source) |
| M8 the source-record rule accepts any digest | leg 5 (the hand-edited record is accepted) |
| M9 the generator stops requiring a released listening set's audio | leg 6 (the no-audio refusal disappears) |
| M10 a built recording's sha256 is changed in the descriptors | leg 4 |
| M11 a built recording disappears from the descriptors | leg 1 |
| M12 a descriptor claims it was reviewed | leg 5 (the contract's own rule refuses it) |

The builder-mutation proofs run in a throwaway tree that mirrors the repository through directory junctions,
because a mutated generator dropped in a bare temp directory cannot read `data/seed.json` at all and would
"fail" for that reason instead of the guard it attacks.

## 5. Not done / owed — what a human must still do

1. **Listen to the three recordings and read the scripts against the keys.** Everything here is
   `unreviewed` on purpose; the audio is machine speech and the scripts are machine-drafted. Nothing in this
   slice is content-approved, and no agent may approve it.
2. **`tools/docker-stack-check.mjs` still asserts the pre-batch corpus totals** (25 sets / 192 items /
   16 servable). That line was ruled out of scope by the Lead in task-37 ("a comment, not a gate"), and it is
   already stale from `0047` alone. With both halves applied the numbers are **31 sets / 227 items /
   19 servable sets / 147 servable items** — for whoever owns that check.
3. **A listening part still serves nothing through the practice path** (`FIX-F1`: the candidate query
   excludes `media_required = true`). Releasing these sets deliberately does NOT bypass that; the playback
   path itself (allowance, `begin`, `practice_check_required`, byte route) is proved against synthetic media
   by `tools/practice-media-check.mjs`. A learner-visible listening practice transport is a separate slice.
4. `exam-s0-server-pg-check.mjs` and `explanation-admission-pg-check.mjs` are hard-guarded to port 62563 and
   were therefore **not run** (that port is reserved for another check).
5. Nothing was deployed, pushed or merged; `main` is untouched at `daaff6b`.
