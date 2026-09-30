# SEC-02 — make reset and clear actually delete learner progress (fixes F-2)

| | |
|---|---|
| Task / execution | SEC-02 / `sec-02-openclaw-20260930-a` (coordinator `COORD-TAKEOVER-20260930`) |
| Worker | OpenClaw/Hetzner, slot 3 (same worker as SEC-01; finding written by Claude, independently of this fix) |
| Base | `origin/main` @ `9c57ffd72f67856c88fedbf996f27f127c51e8f0` |
| Branch | `codex/sec-02-reset` |
| Pull request | [draft PR #42](https://github.com/ronslink/hatoove/pull/42) (base `main`) |
| Allowed paths | `server.js`, `public/js/store.js`, `public/js/settings.js`, `public/settings.html`, `tools/reset-check.mjs`, `tools/reset-check.test.mjs`, `work/implementation/SEC-02.md` |
| Fixes | `work/implementation/P-03A-PRIVACY-AUDIT.md` finding **F-2 (medium)** |
| Status | Reset and clear now reach a real delete path, proven offline. **This closes no privacy or security gate.** Human `P-03` review remains required. |

## What F-2 was

`POST /api/progress` merges on purpose (monotonic union; a partial write must never destroy a
week of study). Both reset actions relied on that same POST:

- **"Alles zurücksetzen"** → `store.resetAll()` replaced the in-memory state with a fresh one and
  saved it. The server merged the empty state into the stored record, the result differed from
  what was sent, and the server returned the full record, which the client merged back into
  memory and `localStorage`. Nothing was deleted on either side.
- **"Fehlerheft leeren"** → `store.clearErrors()` did the same with `errors: []`; the notebook is
  unioned by id, so every entry came back.
- `DELETE /api/progress` existed at `server.js` but **no client code called it**.

## The fix

### `server.js` — a scoped delete on the existing route

The existing `DELETE /api/progress` route keeps its meaning (delete the whole stored record) and
gains one explicit scope:

- `DELETE /api/progress` (or `?scope=all`) — removes `progress.json`, its one-generation `.bak`
  and a leftover `.tmp`, and reports `{ok, scope:"all", deleted:true}`.
- `DELETE /api/progress?scope=errors` — **clears only the error notebook** in the stored record and
  keeps attempts, ability evidence, days, SRS and ticks. It rewrites the record atomically
  (temp + rename) and removes the `.bak`, because that backup still contained the entries the
  learner asked to delete; the atomic write is what protects the remaining progress.
- Any other scope is `400 {code:"invalid_scope"}`. An unrecognised scope is never guessed: a typo
  must not delete more or less than the caller asked for.

The merge path (`POST`) is untouched. Same-origin/JSON enforcement is inherited from SEC-01
(`DELETE` is not a body method, so only the origin gate applies).

### `public/js/store.js` — the client reaches the delete path

- New private `deleteServerProgress(scope)` issues the `DELETE` and reports through
  `syncStatus()`.
- `resetAll()` now cancels the pending debounced saves, writes the fresh state to
  `localStorage`, sets a `b1prep.reset.pending.v1` marker, and deletes the server record. The
  marker is cleared once the server confirms. If the request could not be delivered (server
  restarting, tab closed mid-reset), `syncFromServer()` retries the delete **before** merging on
  the next start, so a reset cannot be silently undone by the merge. It no longer posts the empty
  state, which is what recreated the record.
- `clearErrors()` clears the notebook locally and calls the scoped delete.
- `deleteServerProgress` waits for an in-flight save first, so a POST that left before the reset
  cannot land after the delete and write the record back.
- Both functions are now `async`. The two existing callers (`ui.js`) ignore the return value, so
  no UI change was needed.

### Deliberate choice: no `ui.js` change, and the two unused allowed paths

`public/js/settings.js` and `public/settings.html` **do not exist in this tree**. The Settings page
and both actions live in `public/js/ui.js` (registered in `app.js`). Both actions already call the
store functions above, so fixing the store fixes the actions and the learner appearance is
untouched — the smaller and safer route the task asked for. `ui.js` was not in the allowed paths
and was not needed.

## Scope of deletion — decided and documented

| | A reset ("Alles zurücksetzen") removes | Keeps |
|---|---|---|
| Server | `progress.json`, `progress.json.bak`, a leftover `.tmp` | `.env` (provider key, base URL, model, exam date, port) |
| Browser | `localStorage['b1prep.state.v1']` (attempts, ability nodes, notebook, SRS, days, plan ticks, counters) | `localStorage['certa-theme']` |
| In-record settings | the writing rotation counter (`writingTaskIndex`) | `examDate`, `dailyGoal`, `ttsRate`, `voiceName`, `autoPlay`, `aiDrills`, `model` |

Reasoning: configuration is not learner progress. The AI key, the exam date and the theme
preference are configuration, and so are the preferences chosen on the Einstellungen page; the
rotation counter follows the recorded attempts, so it is progress and is cleared (the writing
regression checks assert exactly that).

**"Fehlerheft leeren"** removes the notebook entries and nothing else: attempts, ability evidence,
days, SRS and plan ticks stay on both sides.

### Backup and portable copies are **not** addressed

The reset removes the record the app reads. It does **not** reach copies outside that path:
`progress.json.pre-recovery` (`tools/recover-progress.js`), `progress.json.before-ssd-sync-*.bak`
(`tools/sync-home.js`), an export the learner downloaded through the Settings page, or the
portable build on removable media (audit finding **F-5**). This is deliberate and is asserted by
the `backup-copies-outside-deletion-path` check rather than implied away: **deletion is not
total**, and saying so is part of the fix.

Also unchanged: `importJSON` is still additive (the merge import semantics are F-2-adjacent but
were not in scope), and no account-deletion path exists (F-6, spike only).

## Before / after — the same probe, pre-fix code

`node tools/reset-check.mjs --legacy-root <export of 9c57ffd>` runs the identical checks against
the pre-fix tree (`git archive 9c57ffd`), offline, synthetic data only:

| Check | Pre-fix `9c57ffd` | Fixed |
|---|---|---|
| `normal-post-still-merges` | PASS | PASS |
| `reset-deletes-server-record` | **FAIL** `progress.json must be gone after a reset` | PASS |
| `reset-clears-browser-cache` | **FAIL** `the browser cache must not still hold the learner text` | PASS |
| `reset-not-undone-on-next-load` | **FAIL** `the next load must not POST the deleted record back: expected 2, got 3` | PASS |
| `reset-preserves-configuration` | **FAIL** `the exam date in the learner settings must survive: expected "2031-03-15", got ""` | PASS |
| `clear-notebook-removes-entries-keeps-history` | **FAIL** `the notebook must be empty on the server: expected 0, got 1` | PASS |
| `unknown-delete-scope-is-rejected` | **FAIL** `unknown scope status: expected 400, got 200` | PASS |
| `delete-requires-same-origin` | PASS (SEC-01 gate) | PASS |
| `backup-copies-outside-deletion-path` | PASS (unchanged, documented) | PASS |

The pre-fix run fails 6 of 9 and the checks unaffected by the deletion defect still pass, so the
probe discriminates the deletion defect instead of failing wholesale. The same discrimination runs
in CI without a second checkout (`mode:"prefix"`, the pre-SEC-02 call sequence) as a test.

Two honest limits of the probe: it is HTTP + client-module only (no browser, so no real page
lifecycle and no browser debounce timing — it waits 1600 ms, longer than the 1200 ms debounce,
so a late save must have landed), and `mode:"prefix"` reproduces the old call order rather than
importing the old code; the table above is the real pre-fix run.

## Acceptance checks — exact counts

| Command | Result |
|---|---|
| `node tools/reset-check.mjs` | **9/9 PASS**, exit 0 |
| `node --test tools/reset-check.test.mjs` | **12 tests, 12 pass** |
| `node tools/check.js` | **101 passed, 0 failed** (unchanged) |
| `node tools/writing-check.js` | **9 passed, 0 failed** (unchanged) |
| `node tools/feedback-check.js` | **14 passed, 0 failed** (unchanged) |
| `node tools/server-origin-check.mjs` | **16/16 PASS** (SEC-01 checks unchanged) |
| `node tools/repository-check.mjs` | passed (248 tracked files; 177 text blobs screened) |

Every check runs in-process, offline, with `B1PREP_ENV_FILE` and `B1PREP_PROGRESS_FILE` pointing
into a throwaway temp directory and `B1PREP_FORCE_OFFLINE=1`; the repository `.env` is never read
or written (the test asserts the suite's env file lives under the temp directory and is not the
repository one). All learner text is synthetic (`SYNTHETIC-LEARNER-TEXT-RESET-CHECK`), and the
SEC-01 same-origin gate on the new delete path is asserted too (`delete-requires-same-origin`).

## Boundaries observed

- No real `.env`, real learner data, credential, database, browser, provider or AI call. The
  synthetic key is deliberately not `sk-` shaped so the repository secret scan stays quiet.
- `public/js/exam.js` was not touched (paused hold). `docs/**`, `tests/fixtures/**`, `spikes/**`
  and the coordination records were not touched.
- No deployment, DNS or production access.

## Not done / not verified

- No browser run, so the click-through, the confirm dialogs and real debounce/tab-close timing are
  unverified; `localStorage.clear()` was not needed and is not used.
- A second tab that holds pre-reset state can still re-upload it after the delete, because the
  merge is intentionally monotonic and the app has no accounts or sessions. The in-flight-save
  race is closed for one tab; cross-tab is not, and is stated rather than hidden.
- Backups, exports and portable copies remain outside the deletion path (F-5), as above.
- `importJSON` keeps its additive semantics; F-3 (AI disclosure) and F-4 (unscoped local
  persistence) are untouched.
- The new test is not wired into `.github/workflows/ci.yml`; CI files were not in the allowed
  paths. It is run manually with `node --test tools/reset-check.test.mjs`.
- `P-03` human review remains required; no gate is closed here.
