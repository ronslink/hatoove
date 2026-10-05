# MEDIA-MOUNT-01 — the listening audio comes from a mounted, verified root

**Task-36. Branch `codex/media-mount-01` cut from main `8c680fd`. Nothing pushed, nothing merged, no live
install touched, no migration created, `public/app/**` untouched, playback accounting untouched.**

## 1. Where the bytes actually come from — measured, not assumed

The brief's premise that "the compose file and the image might disagree" is right, and the measurement is
worse than "they disagree":

| | what carries the recordings |
|---|---|
| local run BEFORE this change | **nothing.** `content/exams/telc-deutsch-b1/audio/` does not exist in the checkout (`Test-Path` false), so `readMediaBytes` answered `media_unavailable` at the moment a learner pressed play. |
| the image | only if the build context happened to contain them: `Dockerfile` line 28 is `COPY content/exams/ ./content/exams/`. It carries the three manifests (`manifest.json`, `listening-package.json`, `listening-media.json`) and **no `audio/` directory at all** in a clean checkout — verified inside the built image: `ls /app/content/exams/telc-deutsch-b1/` lists the three JSON files and nothing else. |
| `.qa/` recovery material | the only place the nine WAVs exist locally: `.qa/listening-media-20261004/content/exams/telc-deutsch-b1/audio/` and a second copy in `.qa/listening-media-v2-20261004/`. All nine **sha256-match** `listening-package.json`; 43.9 MB total; `.gitignore:5` ignores `.qa/`. `git ls-files '*.wav'` is **0**. |

**Corrections to the brief (measured):** there is no `docker-compose.yml` — the surface is `compose.yaml` plus
the three `compose.production*.yaml` files; the audio directory is absent from the checkout entirely; and
`server/migration/*` is untouched as instructed. One more fact the brief did not have, and it shapes the
decision below: **production is contractually forbidden from mounting anything** —
`tools/production-compose-check.mjs:104` requires `!(service.volumes ?? []).length` and `:99` pins the command
to exactly `[node, server.js]`, with the app `read_only` from a digest-pinned image. So a production image can
only carry the recordings **inside the image**, i.e. they must be present in the build context at build time.

**Authoritative path today, after this change:** local/compose → the host bind-mount read through
`B1PREP_MEDIA_ROOT=/app/media`; image → the manifests only (the recordings are no longer claimed to be in the
image); production → whatever is in the build context when the digest-pinned image is built, which this lease
documents as a prerequisite and gates with the checker below.

## 2. The mechanism: an environment override, not a second path

`server/media-contract.mjs` already took `readMediaBytes(media, { mediaRoot })`; nothing was wired to it. The
change is exactly that wiring:

- **`B1PREP_MEDIA_ROOT`** — new `export function defaultMediaRoot()`, and `readMediaBytes` resolves
  `mediaRoot ?? defaultMediaRoot()`. Resolution happens **per call, not at module load**: `server.js` reads
  `.env` *after* its static imports are evaluated, so a value captured at import time would silently miss
  `.env` and fall back to the repo path.
- **`compose.yaml`** — `x-media-mount` bind-mounts `${HATOVE_AUDIO_ROOT:-./media}` at `/app/media`
  (`read_only: true`, `create_host_path: true`), and `B1PREP_MEDIA_ROOT: /app/media` is set on `app`,
  `migrate` (package import checksums every referenced recording) and the gate below. The host layout mirrors
  the inside of `content/exams/`, so `.qa/listening-media-20261004/content/exams/*` is a direct copy source.
  `create_host_path: true` is deliberate: a missing directory must reach the *checker* so it can name every
  missing file, which a mount failure cannot do.
- **The startup signal** — a new one-shot `media` service runs
  `node tools/media-mount-check.mjs --require-recordings`, and `app` now
  `depends_on: media: {condition: service_completed_successfully}`. A missing recording is therefore a failed
  `docker compose up` that names every file, never a 404 at play time. This mirrors the existing
  `db healthy -> migrate completed -> app` shape rather than inventing a health route, and it does not change
  any pinned production command.
- **`Dockerfile`** — the copy of `tools/media-mount-check.mjs` (filesystem-only: no database, no network) and a
  corrected comment: the image carries the manifests, the recordings arrive from outside it.
- **`tools/media-mount-check.mjs` (new)** — proves, against whatever root the API will use (it calls the same
  `defaultMediaRoot()`): every referenced recording resolves through the shipped reader; the shipped framing
  answers 200/206/HEAD/416 with the sha-pinned etag for those real bytes; a root without them answers
  `media_unavailable`; and `--require-recordings` exits 1 naming every missing file and its expected physical
  path. It de-duplicates by path (both `listening-package.json` and `listening-media.json` describe the same
  nine files) and prints the resolved root and the rule that chose it.

`media_integrity` on bad bytes and the no-debit rule are **untouched** — the only behavioural edit to the
reader is where the root comes from.

## 3. The git question: not decided here, and the change works with all three answers

**The WAVs are not in this commit and nothing from `.qa/` is.** Which of Ron's three options ships is his call;
what this lease does is make the code and config work with each:

- **track in git or LFS** → nothing to change in the serving path; the mount stays useful as an override for
  new audio before an image rebuild, and the `media` gate keeps checking the root actually in use. If LFS is
  chosen, note the trap: a checkout without `git-lfs` yields pointer files, which fail as `media_integrity`
  (a confusing 409) rather than `media_unavailable` — the gate names the file either way.
- **documented deployment prerequisite (the state this lease implements)** → populate the host root from the
  recovery copy, run `docker compose up`; the gate refuses to start the API until every referenced file is
  present. For production this is a build-time prerequisite: the recordings must be inside the digest-pinned
  image because production may not mount.
- **object storage** → a fetch/sync step must run before the `media` service; because the gate only reads
  files, it works unchanged as the verification step after any fetch, and names what a partial fetch missed.

Two follow-ups I deliberately did **not** take (outside this lease's file list): adding `media/` to
`.gitignore` so a populated host root can never be staged by accident, and recording the production build-time
prerequisite in `docs/PRODUCTION_DEPLOYMENT.md`. Both are one-line changes for the Lead/Ron once the option is
chosen.

## 4. Evidence — exact commands

All of it uses the **real `.qa` bytes** in a scratch tree and disposable stacks. Never a tracked path.

```text
# scratch root with the real recordings (never tracked)
mkdir %TEMP%\media-scratch ; mkdir %TEMP%\media-scratch\telc-deutsch-b1\audio
copy .qa\listening-media-20261004\content\exams\telc-deutsch-b1\audio\*.wav %TEMP%\media-scratch\telc-deutsch-b1\audio\
  -> 9 files, 43.9 MB

# the exposed state the brief describes: a checkout with no recordings
node tools/media-mount-check.mjs --require-recordings
  -> exit 1, "9 referenced recording(s) are not under ...\content\exams\", each MISSING line naming its file

# the environment override, over the real bytes
set B1PREP_MEDIA_ROOT=%TEMP%\media-scratch
node tools/media-mount-check.mjs --require-recordings
  -> exit 0 · 9 recordings, 44 MB read and checksum-verified · 200/206/HEAD/416 as shipped · media_unavailable from a root without them

# a disposable stack with the mount
set HATOVE_AUDIO_ROOT=%TEMP%\media-scratch  &  docker compose -p hatoove-mediamount up -d --build
  -> db healthy · media Exited (0) · migrate Exited (0) · app Up (healthy) · worker Up
docker compose -p hatoove-mediamount exec -T app node tools/media-mount-check.mjs --require-recordings
  -> media root /app/media (rule B1PREP_MEDIA_ROOT) · 9 recordings verified · 3 passed, 0 failed
docker compose -p hatoove-mediamount exec -T app sh -c 'ls /app/content/exams/telc-deutsch-b1/; ls /app/media/telc-deutsch-b1/audio | wc -l'
  -> the IMAGE has the 3 manifests and NO audio; the MOUNT has 9 files
docker compose -p hatoove-mediamount exec -T app node -e "<readMediaBytes + mediaResponse over media[0]>"
  -> default root: /app/media · bytes 3094216 · 200 audio/wav · etag "sha256-28ea34480612..." · 206 content-range bytes 0-99/3094216

# the loud failure, with an EMPTY host root
set HATOVE_AUDIO_ROOT=%TEMP%\media-empty
docker compose -p hatoove-mediamount-empty run --rm media     -> exit 1, 9 MISSING lines
docker compose -p hatoove-mm-empty up -d                      -> media Exited (1), app Created (never started)

# the accounting and integrity contracts, unchanged (task-17's own check, disposable database)
node tools/practice-media-check.mjs  -> exit 0 · 19 legs, 0 failed · M1-M4 mutations fire
  PASS M9  a MISSING file refuses the play, debits nothing  [media_unavailable, no practice_playback row, no play debited]
  PASS M10 a CORRUPT file is an integrity failure           [media_integrity, no play debited]

node tools/repository-check.mjs        -> passed, 751 tracked files, 668 text blobs screened
node tools/production-compose-check.mjs -> PASS (11 source mutations; composeExecution: not_run)
```

Every stack and container was removed afterwards; fixture residue **0 schemas / 0 roles**; the scratch roots
deleted.

## 5. Limits, stated rather than implied

- **The mock and practice play paths are proven at the level they can be proven here.** Both read through the
  same `readMediaBytes(media, { mediaRoot })` call sites (`playback.mjs:91`, `practice-playback.mjs:133`) and
  `server.js` passes no `mediaRoot`, so both fall to `defaultMediaRoot()` — the same function the in-container
  run proved resolves to `/app/media` over the real bytes. Their *accounting* is covered by
  `practice-media-check` (19/19, M9/M10 above) against a disposable database. What was **not** driven is an
  HTTP mock/practice media request against a compose stack's mount: that needs a full authenticated mock run
  or practice sitting, and the route code is untouched by this change. If the Lead wants that closed, it is a
  follow-up that imports a package with `mediaRoot=<mount>` and drives the two routes end to end.
- The checker reads all nine files (~44 MB) on every run: ~1-2 s, and it is what makes the gate real.
- `compose.production*.yaml` was **not** modified: adding a mount there would fail
  `production-compose-check.mjs`, and production's contract is that the artifact carries its own bytes.

## 6. Addendum — the Lead's three authorisations after acceptance

- **`.gitignore`**: `media/` added, so a populated host root can never be staged by accident whatever Ron
  decides. Protective under all three options, and trivial to drop if the recordings become tracked.
- **`docs/PRODUCTION_DEPLOYMENT.md`**: a new section, *"Listening media: a BUILD-TIME input, because production
  cannot mount it"*. Phrased option-agnostically, per the instruction: it states the constraint
  (`production-compose-check.mjs` asserts zero runtime volumes and the exact command, app `read_only`, image
  digest-pinned → the recordings must be inside the artifact), fixes the resolution point (the image
  build/publish step: materialise the audio in the build context, verify with
  `tools/media-mount-check.mjs --require-recordings`, record the source and checksums with the digest) and
  leaves Ron's choice open. It also names the LFS trap.
- **The real-bytes HTTP media GET: ATTEMPTED, NOT CLOSED, and here is exactly why.** I patched a throwaway copy
  of `tools/practice-media-check.mjs` (deleted immediately afterwards; the shipped file is untouched) to import
  the **real** `listening-package.json` with `mediaRoot` = the real-bytes root. The import and the reader path
  worked, but **12 of its 19 legs are written against its synthetic exam's set ids**
  (`s5.telc-deutsch-b1.hv1|hv2|hv3`), so the practice and mock legs fail with "the fixture has no set s5…" —
  that check is a fixture-shaped harness, not a package-agnostic one. Closing this needs either a fixture change
  **inside `tools/practice-media-check.mjs`** (the practice-media slice's file, outside this lease's write
  scope) or a small dedicated HTTP check: build a practice sitting for a **real** `hv` set, then
  `GET /api/v1/practice/attempts/<id>/media/<mediaId>/v1` and assert 200 + the sha-pinned etag + a 206 range.
  What **is** proven for real bytes: the shipped reader and framing inside the deployed image
  (200/206/HEAD/416, etag = the package's sha256) and the importer's own checksum verification of every
  referenced recording. The route works and the mount works; only that one authenticated GET with real bytes is
  unproven, and I am not claiming it.
- **Noted, not built** (per instruction): if the media root holds a **git-lfs pointer file**, the checker should
  say "this is a git-lfs pointer, run `git lfs pull`" rather than reporting `media_integrity`. The trap is
  documented in the deployment doc so the option can be weighed with its hidden cost.

## 7. Ron's decision — option (a): the recordings are tracked plain, and the pointer guard is built

**Committed in this lease (authorised 5 Oct 2026).** The nine recordings are now tracked plain under
`content/exams/telc-deutsch-b1/audio/` — **no LFS**, so the pointer hazard cannot arise from the tracked copy,
and `COPY content/exams/` puts them in the image, which is what production needs since it cannot mount.

| file | bytes | sha256 (first 10) |
| --- | --- | --- |
| hv1.01-v1.wav | 3 094 216 | 28ea344806 |
| hv1.02-v1.wav | 3 135 154 | db02ccf343 |
| hv1.03-v1.wav | 3 091 232 | 99385b384d |
| hv2.01-v1.wav | 9 192 586 | 111f915c30 |
| hv2.02-v1.wav | 8 116 492 | f52021ec2c |
| hv2.03-v1.wav | 8 340 144 | 3f76b49bbd |
| hv3.01-v1.wav | 3 523 860 | bd13363f74 |
| hv3.02-v1.wav | 3 878 000 | cde56f3eba |
| hv3.03-v1.wav | 3 652 856 | cea2c8801b |

**43.89 MB across nine files; all nine sha256-match `listening-package.json` (measured, 0 mismatches).**
Provenance, recorded in the tracked package itself: `"rightsStatus": "generated"`, `"source": "Google Cloud
Text-to-Speech, de-DE-Standard-G/H; transcript authored in
server/migrations/0010-objective-catalogue.sql#hv1.01"` — project-generated audio from our own authored
transcripts, and D10 was amended the same day to permit offline AI-generated content assets with recorded
provenance and human review still required. **They were not re-encoded**: the sha256s are pinned by the package
and re-encoding is a content decision, not a packaging one.

**The pointer guard is built and proved.** `tools/media-mount-check.mjs` now recognises a git-LFS pointer
*before* the reader (`version https://git-lfs.github.com/spec/v1` in the first 200 bytes) and reports it as
what it is, with the action, instead of letting it surface as `media_integrity`:

```text
$ node tools/media-mount-check.mjs --media-root <scratch tree of pointer files> --require-recordings
GIT-LFS POINTER content/exams/telc-deutsch-b1/audio/hv1.01-v1.wav
  this is not audio ("version https://git-lfs.github.com/spec/v1") — run `git lfs pull`, then re-run this check.
  It is NOT a media_integrity failure.
exit 1 · 9 pointer(s) named · no `[media_integrity]` code anywhere in the output
```

And the default root, now that the recordings are tracked, is green:

```text
$ node tools/media-mount-check.mjs --require-recordings
PASS every referenced recording resolves through the shipped reader on this root  [9 recording(s), 44 MB read and checksum-verified]
PASS the shipped framing serves those bytes (content-type, etag, range, HEAD, 416)
PASS a root that does not hold a referenced recording answers media_unavailable
PASS --require-recordings: all 9 referenced recording(s) are present
exit 0 · 3 passed, 0 failed
```

`media/` stays in `.gitignore`: that is the **host mount** directory, which must not be stageable. The tracked
asset path (`content/exams/telc-deutsch-b1/audio/`) is deliberately not ignored.

**For the next lease (POOL-01's TTS sets, held):** the mount plus the tracked path now accept new recordings
without any image or migration change. A TTS pass needs the authored batch-1 scripts, a reproducible generation
step with model/voice/settings/date/operator recorded as provenance, the WAVs added to this same tracked path,
the package's `media` entries and sha256s updated, and this check run — it verifies byte length, sha256 and PCM
duration, so a mis-generated or truncated file fails at startup rather than at play time.

## 8. FIX-F2 (task-40) — the default path is the tracked tree, and the mount is opt-in

**The defect the outside review found, and it was mine.** `compose.yaml` bind-mounted
`${HATOVE_AUDIO_ROOT:-./media}` with `create_host_path: true` and set `B1PREP_MEDIA_ROOT=/app/media`
unconditionally. `./media` is gitignored, so on a **clean checkout it was created empty**, the `media`
preflight failed, and `app` — which waits on it — **never started**, on a branch that tracks the nine WAVs and
an image that copies them. It would have taken down the local install and broken mock listening, which plays
from the image. Worse, my own evidence could not have caught it: the only full-stack run set
`HATOVE_AUDIO_ROOT` to a scratch directory, so **the default path was never exercised**. That is the lesson I
am recording here: a run that only exercises the interesting override proves the override, not the default.

**The fix.**
- `defaultMediaRoot()` resolves to the tracked `content/exams/` tree — so a clean clone and a production image
  need **no environment variable and no host folder**. `B1PREP_MEDIA_ROOT` is now purely an opt-in override.
- The mount's default source is that same tracked tree (`${HATOVE_AUDIO_ROOT:-./content/exams}`), and
  `create_host_path: false`: a typo in the override fails `docker compose up` at the mount instead of silently
  creating an empty directory, while the default source always exists in a checkout.
- The `media` preflight keeps its loud, file-naming failure **for an incomplete override**, and passes for the
  default; the pointer guard is untouched.
- Stale comments corrected in `compose.yaml`, `server/media-contract.mjs`, `Dockerfile` and `.gitignore` —
  they still said the recordings were untracked and "Ron is deciding".
- `.gitattributes` gains `*.wav binary`, so the byte-exact rule is explicit like every other pinned artifact.

**Evidence — the case the previous run skipped.**

```text
# DEFAULT: clean tracked state, NO HATOVE_AUDIO_ROOT, NO ./media directory
$ docker compose -p hatoove-f2 up -d --build
  db healthy · media Exited (0) · migrate Exited (0) · app Up (healthy) · worker Up
$ docker compose exec -T app node -e "<readMediaBytes + mediaResponse over media[0]>"
  default root: /app/media · bytes 3094216 · 200 audio/wav · etag "sha256-28ea34480612…"
  range: 206 bytes 0-99/3094216, body 100
$ docker compose exec -T app node tools/media-mount-check.mjs --media-root /app/content/exams --require-recordings
  PASS --require-recordings: all 9 referenced recording(s) are present under /app/content/exams
  3 passed, 0 failed          <- the IMAGE's own copy, i.e. mock listening without any mount

# OVERRIDE POPULATED (HATOVE_AUDIO_ROOT=<scratch with the real bytes>)
$ docker compose -p hatoove-f2-ovr run --rm media
  rule: B1PREP_MEDIA_ROOT · all 9 referenced recording(s) are present under /app/media · 3 passed, 0 failed

# OVERRIDE EMPTY
$ docker compose -p hatoove-f2-ovr-empty run --rm media
  exit 1 · 9 MISSING lines naming every file
```

Gate groups on this head: `run-gates.mjs mirror`, `baseline`, `mirror-db` against a disposable
migrated database. Every stack and container removed; `./media` was deleted and the tracked state left clean.
