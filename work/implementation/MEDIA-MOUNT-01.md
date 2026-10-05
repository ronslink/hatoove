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
