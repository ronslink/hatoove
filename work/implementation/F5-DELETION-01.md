# F5-DELETION-01 — backups and portable copies inside the deletion path

| | |
|---|---|
| Task / execution | F5-DELETION-01 / `f5-deletion-01-openclaw-20261001-a` |
| Worker | OpenClaw (Hetzner), local to this checkout |
| Coordinator | `COORD-TAKEOVER-20260930` |
| Branch | `codex/f5-deletion-01` |
| Base used | `origin/main` @ `3a8c26647a2dabd1a95aff393ca9be870381d01a` (PR #57, the F-4 merge) |
| PR | draft, to `main` (URL in the handoff/report) |
| Finding | `work/implementation/P-03A-PRIVACY-AUDIT.md` **F-5** (Low) |
| Status | Fixed on this branch, with a discriminating checker. Backups on removable media are **disclosed, not deleted** (see below). This closes no privacy/legal gate: **P-03** and **A-05** remain human/plan gates |

The finding has two halves and they are kept separate here:

1. **Deletion scope (fixed).** Copies the app itself left beside the record were not in the
   deletion path. `DELETE /api/progress?scope=all` (the action behind "Alles zurücksetzen")
   now removes them.
2. **Removable media (disclosed, not deleted).** The portable build copies the real `.env`
   (the provider key) and the progress files onto whatever media it is written to. The app
   cannot delete from media that is not attached, so it now **states** that at the point of
   copy. This is **mitigation by disclosure, not deletion**.

## What the finding got right, and what it got wrong

- **Right:** the copies existed and were outside the deletion path. `progress.json.pre-recovery`
  (`tools/recover-progress.js`) and `progress.json.before-ssd-sync-<id>.bak` (`tools/sync-home.js`)
  were never removed by any delete.
- **Partly stale, said with evidence:** the finding's Evidence line — "`DELETE /api/progress`
  removes only `progress.json` and `progress.json.bak`" — undercounts by one at the base. The
  base already removed `progress.json.tmp` too (`server.js`, the interrupted-write leftover).
  `.bak` is genuinely removed, so the finding's `.bak`-in-scope claim is correct.
- **Not a server defect:** the `.tmp` leftover is removed by the base delete line-by-line. What
  was missing was `.pre-recovery` and the home-sync backups, which are the copies the checker
  discriminates on.

## The full path-enumeration table (from the code, not assumption)

Everything the app **can** write learner text or the key to, who creates it, and whether a
delete reaches it. "Now" = after this branch; "Base" = `3a8c266`.

| Path | Contains | Created by | Delete reaches it? |
|---|---|---|---|
| `progress.json`¹ | the whole learner record (attempts, notebook text, settings) | `server.js` `writeProgress` (POST `/api/progress`) | **Yes** — Base and now |
| `progress.json.bak`¹ | previous generation of the same record | `server.js` `writeProgress` (2nd+ save) | **Yes** — Base and now |
| `progress.json.tmp`¹ | in-flight write buffer (a full record) | `server.js` `writeProgress`, `writeProgressScoped` | **Yes** — Base and now (removed as a leftover) |
| `progress.json.pre-recovery`¹ | pre-merge safety copy of the record | `tools/recover-progress.js` | **Now** — was outside; the checker discriminates on this |
| `progress.json.before-ssd-sync-<id>.bak`¹ | byte-for-byte home record before a portable→home sync | `tools/sync-home.js` | **Now** — was outside |
| `progress.json.rev`¹ | `{rev, deletedThrough}` only — **no learner text** | `server.js` `writeRevision` | **Deliberately not** — it is the write fence that refuses a pre-delete save |
| `progress.json.rev.tmp`¹ | temp for the marker — no learner text | `server.js` `writeRevision` | Not targeted (no learner text) |
| `progress.json.<accountId>` and `.bak`/`.tmp`/`.rev`¹ | per-account record (F-4) | `server.js` `accountPaths` | **Yes, for the account named in `X-B1Prep-Account`** (`scope=all` with that header) |
| `.env`¹ (`$B1PREP_ENV_FILE`) | provider key, model, base URL, exam date, port | `server.js` `saveEnv` (POST `/api/config`) | **No, by design** — configuration, not progress; stated in the delete response |
| `localStorage['b1prep.state.v1']` (+ account-scoped keys) | cached learner record | `public/js/store.js` | Cleared client-side by the reset itself, not by the server |
| `localStorage['certa-theme']` | theme only | `public/js/app.js` | Kept (a preference, not progress) |
| `b1-prep-fortschritt-<date>.json` (browser Downloads) | an **export** of the record | `public/js/ui.js` download | **No** — outside the app's filesystem; stated in the delete response |
| `<media>/B1_Prep/.env`, `progress.json`, `.bak`, `.pre-recovery` | the key **and** the record, on removable media | `tools/build-portable.ps1` | **No** — media not attached; **disclosed** via `DELETION-NOTICE.txt` in the bundle |
| `.qa/portable-build/**` (staging, `manifest.json`) | build-time copies of the above | `tools/build-portable.ps1` | **No** — gitignored build artifact, not the learner install |
| `.progress-ssd-sync-<id>.tmp`, `.b1prep-sync-home.lock`, `.sync-home-complete*.json` | sync transients/lock/marker — no learner text | `tools/sync-home.js` | Not targeted (no learner text; the temp and lock are removed by the tool itself) |
| `.portable test <uuid>.json` + suffixed copies | a throwaway test record | `tools/verify-portable.js` | Removed by that tool; test-only |
| PostgreSQL rows (`spikes/auth-runtime`) | drafts/submissions/assessments (synthetic) | the spike server | Out of scope of the legacy app (audit F-6) |

¹ `$B1PREP_PROGRESS_FILE` / `$B1PREP_ENV_FILE` relocate the path; the suffixes in this table follow the resolved file.

## What deletion still cannot reach — stated, not guessed

- **Removable media.** `tools/build-portable.ps1` copies the learner's real `.env` and the
  progress files onto the target media. A delete inside an installed copy cannot reach media
  that is not attached. Fixed by **disclosure**: the build now writes a `DELETION-NOTICE.txt`
  into the bundle (and warns on the console) saying the copy travels with the media and that
  removing it means deleting the files on the media itself. Recorded as **mitigation by
  disclosure, not deletion**.
- **A browser export.** `ui.js` saves `b1-prep-fortschritt-<date>.json` through the browser's
  download flow, outside the app directory. Stated in the delete response.
- **`.env`.** The key and settings are configuration, not learner progress, and are kept.
  Stated in the delete response.

The delete response now carries this honesty explicitly:
`{ deleted: true, rev, removed: [...], outsideScope: [...] }`.

## Changes

| File | Change |
|---|---|
| `server.js` | `scope=all` delete now removes `progress.json.tmp` (as before), `.pre-recovery`, and every `progress.json.before-ssd-sync-*.bak`, reports `removed` and `outsideScope`. The merge-on-save guard and the F-4 account scoping are untouched; `.rev` (write fence) is kept |
| `tools/deletion-scope-check.mjs` | **new** checker: creates the copies with the real app processes, runs the UI delete, asserts file-by-file what survives, and discriminates against the pre-fix tree |
| `tools/deletion-scope-check.test.mjs` | **new** `node --test` wrapper |
| `tools/recover-progress.js` | states, when it writes the safety copy, that the app's full delete removes it and that a media copy is outside that path |
| `tools/build-portable.ps1` | writes `DELETION-NOTICE.txt` into the bundle and warns on the console when the key/record are copied to media |
| `tools/verify-portable.js` | verifies the bundle carries the notice; cleans up `.pre-recovery` test files |
| `tools/reset-check.mjs` | **the one file outside the literal allowed list — see below** |

### `tools/reset-check.mjs` was changed outside the literal allowed paths

The F-2 test held a check, `backup-copies-outside-deletion-path`, that asserted the exact
opposite of this task: *"the pre-recovery copy must be untouched (this is the documented
boundary)"*. Fixing F-5 removes that boundary, so the assertion had to be inverted or the
baseline could not stay at 9. It is now `app-created-copies-removed-by-full-delete` (still 9
checks). The dispatch's allowed list omitted this file (it also lists a
`public/js/settings.js` that does not exist at the base, so the list is not a complete map of
the tree). Flagged here for the coordinator; the hunk is self-contained and revertible.

## Acceptance checks — actual output

**New checker** (`node tools/deletion-scope-check.mjs`) — 7/7:

```
PASS  app-created-copies-created-first  [created first: progress.json, progress.json.bak, progress.json.tmp, progress.json.pre-recovery, progress.json.before-ssd-sync-...bak]
PASS  ui-delete-removes-every-local-copy  [removed: progress.json, progress.json.bak, progress.json.tmp, progress.json.pre-recovery, progress.json.before-ssd-sync-...bak]
PASS  learner-record-gone-get-reports-empty  [record gone; GET reports found:false]
PASS  tombstone-kept-without-learner-text  [.rev kept as the write fence; holds no learner text]
PASS  removable-media-copy-reported-out-of-scope  [reported, not claimed deleted: the simulated media copy (.env + progress.json) is untouched]
PASS  delete-response-states-its-boundary  [reports removed files and names removable media as out of scope]
PASS  probe-discriminates-on-prefix-tree  [pre-fix leaves progress.json.pre-recovery, progress.json.before-ssd-sync-...bak behind (sha256 ce465f18601e)]
  OK    7 check(s) passed, including discrimination against the pre-fix tree.
```

**Pre-fix discrimination** (same probe, pre-fix tree materialized from git):

- `git show 3a8c266...:server.js | sha256sum` = `ce465f18601ea3e68c1b19313f9f0c00c3f2554c913bfe7d2ba4cfdb1615d207`
  — the checker asserts this byte-for-byte before it trusts the comparison.
- The same checks run with the pre-fix tree as the primary root **fail there**, and the copies
  are the reason:

```
pre-fix tree materialized at /tmp/b1prep-f5-prefix-… (base 3a8c26647a2dabd1a95aff393ca9be870381d01a)
PASS  app-created-copies-created-first  [created first: progress.json, progress.json.bak, progress.json.tmp, progress.json.pre-recovery, progress.json.before-ssd-sync-…bak]
FAIL  ui-delete-removes-every-local-copy  [these app-created copies outlived the delete: progress.json.pre-recovery, progress.json.before-ssd-sync-…bak: expected 0, got 2]
FAIL  learner-record-gone-get-reports-empty  [no file may still hold learner text, found progress.json.before-ssd-sync-…bak, progress.json.pre-recovery]
PASS  tombstone-kept-without-learner-text  [.rev kept as the write fence; holds no learner text]
PASS  removable-media-copy-reported-out-of-scope  [reported, not claimed deleted: the simulated media copy (.env + progress.json) is untouched]
FAIL  delete-response-states-its-boundary  [the delete must report the files it removed]
ok = false
```

On this branch the same probe is 7/7 (`ok = true`), and the in-suite `probe-discriminates-on-prefix-tree` check asserts the pre-fix tree leaves `.pre-recovery` behind — refusing to pass if the pre-fix tree removed everything (which would mean the probe discriminates nothing).

(Evidence produced by a scratch runner kept at `.openclaw/tmp/f5-prefix-evidence.mjs` in the
worker workspace; it is not committed.)

**Baseline (actual counts):**

| Suite | Count |
|---|---|
| `node tools/check.js` | **101 passed, 0 failed** |
| `node tools/writing-check.js` | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | **14 passed, 0 failed** |
| `node tools/reset-check.mjs` | **OK 9 check(s) passed** |
| `node tools/revision-check.mjs` | **OK 8 check(s) passed** (incl. discrimination) |
| `node tools/server-origin-check.mjs` | **OK 16 check(s) passed** |
| `node tools/keymask-check.mjs` | **OK 12 check(s) passed** (no key regression) |
| `node tools/progress-equal-check.mjs` | **OK 10 check(s) passed** (incl. discrimination) |
| `node tools/deletion-scope-check.mjs` | **OK 7 check(s) passed** (incl. discrimination) |
| `node --test tools/deletion-scope-check.test.mjs` | **tests 9 / pass 9 / fail 0** |
| `node tools/repository-check.mjs` | **passed — 298 tracked files; 227 text blobs screened** |
| `git diff --cached --check` | **clean** (LF only) |

## No new secret exposure

Nothing prints, logs or returns any part of a key. The delete response returns only file
*names* and scope *statements*. The portable notice names file names, never key material.
`keymask-check.mjs` is 12/12. No live provider call, no real credential, synthetic data only.

## Could not verify

- **No browser was started.** The checker drives `public/js/store.js` and `server.js`
  in-process; it does not exercise real page lifecycle, the reset confirmation dialog, or the
  debounce timers. The settle wait is longer than the debounce, so a late save must have
  landed, but that is not a browser.
- **`tools/verify-portable.js` was not run.** It needs Windows, a deployed portable bundle and
  a bundled `node.exe`; only its syntax was checked here. Its new notice assertion is unproven
  on a real bundle.
- **`tools/build-portable.ps1` was not run.** No PowerShell on this host; the `DELETION-NOTICE.txt`
  write and the `Write-Warning` path are reasoned from the code, not executed.
- **The home-sync backup was not produced by running `tools/sync-home.js`.** That tool needs a
  portable install and two stopped servers, so the checker writes the
  `.before-ssd-sync-<id>.bak` name/shape directly. The server is still asserted to delete that
  path shape. The genuinely app-created copies the checker proves are `.bak` (the server) and
  `.pre-recovery` (`tools/recover-progress.js`, run as a child process).
- **`scope=errors` (notebook clear) still does not touch `.pre-recovery`/home-sync copies.**
  That is a partial clear, not "delete everything"; the copies can still hold the cleared
  notebook entries. Recorded for the coordinator rather than silently widening this fix.
- **The learner is not shown the `outsideScope` text in the UI.** `store.js`/`ui.js` are out of
  scope for this task (F-4 owns `store.js`), so the delete response carries the statement but
  the Settings screen does not render it yet. Follow-up.
- **`public/js/settings.js`** in the allowed list **does not exist** at the base; no Settings
  module does. Nothing was created at that path.
- **Windows behaviour of `.bak`/`.pre-recovery` deletion** is asserted through Node's `fs` on
  Linux; the same `fsp.rm` calls are what run on Windows, but not executed there.

## Boundaries respected

No deployment, no production access, no real credential, no live provider call. `public/js/exam.js`,
`public/js/store.js`, `.github/**`, `package.json`, `IMPLEMENTATION_PLAN.md`, `MASTER-PLAN.md`
and `work/BOARD.md` were not touched. No merge, no force-push, no rebase. All files LF.
