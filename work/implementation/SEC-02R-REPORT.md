# SEC-02R - independent review of the F-2 reset fix (`11982a6`, PR #42)

| | |
|---|---|
| Reviewer | **Clawdbot** - independent reviewer, **not** the author (the fix was written by OpenClaw) |
| Execution id | `sec-02r-clawd-20260930-a` |
| Coordinator | `COORD-TAKEOVER-20260930` |
| Candidate | `origin/codex/sec-02-reset` @ **`11982a6eabc672091c114a27ae389c411744bb04`** (fix `c1c5ec8`, report `11982a6`), based on `9c57ffd` |
| Base reviewed against | `origin/main` = `de4ecb6e68f089218ef92c3879e392063356efa2` |
| Pre-fix reference | `git archive 9c57ffd` -> scratch checkout |
| Environment | Windows 11, Node v24.4.1, git 2.54.0. Offline, in-process. Synthetic data only. |

## Verdict: **accept-with-notes**

The fix does what it claims for the ordinary path: reset and notebook-clear now reach a real
`DELETE`; the probe discriminates (9/9 vs 6/9 against the pre-fix tree); the `POST` merge is
byte-for-byte untouched; the kept/cleared split is exactly as documented; every baseline count
matches; the change set is disjoint from `main` and merges cleanly; `public/js/exam.js` is
untouched. All of that is verified below.

**The one substantive problem:** the author states the in-flight-save race **"is closed for one
tab"** (SEC-02.md, "Not done / not verified") and the fix commit says it *"waits for an in-flight
save so a late POST cannot write the record back."* **That is not true.** I reproduce, with a
single tab and no concurrent writer, a reset that is *silently undone*: the reset's own in-flight
save folds the merged record back into `localStorage` and memory **after** the reset cleared them,
then the next load re-uploads it - the exact F-2 symptom. The race is narrowed but not closed, and
the documentation overstates it. This must be corrected and a follow-up fix + test added; it does
not, by itself, require rejecting the primary fix.

---

## Check 1 - the fix works and the probe discriminates (with a caveat about `--legacy-root`)

Measured on the candidate extracted with `git archive 11982a6`:

- `node tools/reset-check.mjs` -> **9/9 PASS, exit 0**.
- `node tools/reset-check.mjs --legacy-root <path to a `git archive 9c57ffd` checkout>` -> the
  candidate side 9/9; the pre-fix side fails **exactly 6 of 9**:

| pre-fix FAIL | pre-fix PASS (unchanged by the defect) |
|---|---|
| `reset-deletes-server-record` | `normal-post-still-merges` |
| `reset-clears-browser-cache` | `delete-requires-same-origin` |
| `reset-not-undone-on-next-load` | `backup-copies-outside-deletion-path` |
| `reset-preserves-configuration` | |
| `clear-notebook-removes-entries-keeps-history` | |
| `unknown-delete-scope-is-rejected` | |

The six names match the task's expected set exactly, and `normal-post-still-merges` passes on
**both** trees - so the probe isolates the deletion defect, not the SEC-01 origin gate.

**`--legacy-root` pitfall confirmed.** `node tools/reset-check.mjs --legacy-root` with no value
resolves to the current directory and compares the candidate against itself:
`pre-fix run fails 0 check(s): none`, exit 0 - a silent false negative. Anyone wiring this into CI
must pass a real path (or fix the fallback).

## Check 2 - the `POST /api/progress` merge is byte-for-byte untouched

- `server.js` diff (`9c57ffd..11982a6`) has exactly two hunks: a new `writeProgressScoped()`
  helper and the rewritten `DELETE` branch. `numstat` = `+59 / -4`, all inside those hunks.
- The **`POST` handler body is character-identical** between the two commits (compared side by
  side).
- `mergeProgress` lives in `public/js/progress-merge.js`; its blob is **identical** at both
  commits (`f6017208ec7efc6e8aa7c404adb89299ff3c0520`). The merge logic is untouched.

## Check 3 - scope of deletion is as documented (verified independently, not from the summary)

My own probe seeded every field and asserted the split after `resetAll()`:

- **Kept:** `.env` key, `BASE_URL`, model line, `EXAM_DATE`, `PORT`; theme key `certa-theme`;
  settings `examDate`, `dailyGoal`, `ttsRate`, `voiceName`, `autoPlay`, `aiDrills`, `model`.
- **Cleared:** `writingTaskIndex` (rotation counter), an unknown `settings.bogus` key, and
  `nodes`, `history`, `errors`, `srs`, `days`, `planDone`, `counters`.

`clearErrors()` removes the notebook entries and keeps history, ability nodes and settings -
confirmed on both the server record and `localStorage`. The documented table in SEC-02.md is
accurate.

## Check 4 - try to break it (one real finding)

My probe (scenarios S0-S8) ended at **57 passed / 5 failed**. One of the five is an over-strict
expectation of mine (S5 `scope[]=all`, see below); the other four are the single finding.

### FINDING (medium-high) - a reset racing an in-flight save is silently undone (single tab)

**Claim contradicted:** SEC-02.md says the in-flight-save race *"is closed for one tab"*; the fix
commit says it *"waits for an in-flight save so a late POST cannot write the record back."*

**Reproduction (no second tab, no concurrency beyond one in-flight POST):**

```
seed server + localStorage with a record containing SYNTHETIC-LEARNER-TEXT-PROBE
store.importJSON(record)            // queues the normal 1200 ms debounced save
wait 1300 ms                        // debounce fires; POST is now on the wire (net delay 300 ms)
await store.resetAll()              // user clicks "Alles zuruecksetzen" while the save is in flight
-> cacheHasMarker = true            // localStorage still holds the learner text
-> server found = false             // the DELETE did run
reload (fresh module) -> syncFromServer()
-> server found = true   (RESURRECTED) // the record is back
```

**Mechanism (root cause, verified):**

1. `progressEqual()` is a `JSON.stringify` comparison, and `mergeProgress()` emits the top-level
   object with a **different key order** than the client sends (`counters` is moved ahead of
   `nodes`). So `progressEqual(state, mergeProgress(state, state)) === false` even for logically
   identical state - I measured this directly. Consequence: the server returns a full `state`
   payload on **every** POST.
2. `store.js` `sendProgress()` folds that payload back and calls `writeLocal()` on every
   successful save.
3. `resetAll()` writes the fresh (empty) state to `localStorage`, **then** awaits the in-flight
   save (`deleteServerProgress` awaits `inflight`). The in-flight response's fold runs during that
   await and overwrites `localStorage` **and the in-memory `state`** with the merged full record.
   Only afterwards does the `DELETE` run.
4. The `b1prep.reset.pending.v1` marker is cleared (the delete succeeded), so the next load does
   not retry; it sees a non-empty local copy and re-uploads it through the normal merge path.

So the very mechanism the author relied on (waiting for the in-flight save) is insufficient: the
save's **response handler** writes the record back after the reset has cleared it. The pending
marker does not help because it is correctly cleared by the successful delete - the corruption
happens in the cache, not the flag.

**Reachability:** needs a `POST` genuinely in flight at click time - i.e. the network round-trip
window after the 1200 ms debounce fires, on tab-hide/tab-close (`flushNow()` -> `flushToServer()`),
or during a startup upload. Deterministic with modest latency (300 ms shown). The author's own
probe can never catch this: it waits 1600 ms *past* the debounce so no save is ever concurrent.

**Suggested fix directions (reviewer):** after the awaited save and the delete, re-assert the
fresh state (`writeLocal()` again) and keep the marker until after that re-write; and/or have a
pending reset suppress the fold in `sendProgress` (discard `data.state` while the reset marker is
set); and/or make `progressEqual` order-insensitive (canonicalize, or compare a stable hash) so an
identical POST returns no payload at all. A regression test must drive `resetAll()` with a save in
flight, not after a settle delay.

### Secondary observations (not defects, documented for completeness)

- **`?scope=` default.** `searchParams.get('scope') || 'all'` means an empty or **unknown query
  key** silently defaults to **delete-everything**: `?scope=` and `?scope[]=all` both return 200
  and delete the whole record (my S5 flagged the latter as an over-strict expectation; the
  behaviour is defensible since "delete all" is the route's default). A genuine typo in the
  *value* (`nonsense`, `ALL`, `all\0`, `all `) is correctly rejected as `400 invalid_scope`, and
  `?scope=errors` clears only the notebook while keeping history/ability. Only the *missing or
  misnamed key* case defaults to all. Low risk; worth a one-line comment.
- **Wedged marker when the server is unreachable (low).** If the retry `DELETE` cannot reach the
  server, the marker stays set and `syncFromServer()` returns early on every load - the server
  record survives (not a silent undo) but new local work is not synced while the marker is stuck.
  Acceptable and self-healing on the next reachable load.

Everything else resisted attack: leftover `.bak`/`.tmp` holding the deleted text were removed by
the reset; a reset followed by two immediate reloads did not re-upload; `.bak` after a notebook
clear did not retain the entry; the marker applied the delete exactly once and cleared itself.

## Check 5 - `public/js/exam.js` untouched

Blob identical at `9c57ffd` and `11982a6` (`f683256723ad0410afeefeefe40555abd4b25085`). The only
file changed under `public/` is `public/js/store.js` (`+131 / -4`). `public/js/ui.js` is also
unchanged (`71d72d8640d3e57ff70f448c3375b65b4acee3ab`); `public/js/settings.js` and
`public/settings.html` do not exist in the tree.

## Check 6 - exact counts (measured, not trusted)

| Command | Claim | Measured |
|---|---|---|
| `node tools/reset-check.mjs` | 9/9 | **9/9 PASS**, exit 0 |
| `node --test tools/reset-check.test.mjs` | 12/12 | **12 tests, 12 pass** |
| `node tools/check.js` | 101 | **101 passed, 0 failed** |
| `node tools/writing-check.js` | 9 | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | 14 | **14 passed, 0 failed** |
| `node tools/server-origin-check.mjs` | 16/16 | **16/16 PASS** |

## Disjointness from `main`

`9c57ffd..de4ecb6` touches only `docs/contracts/OWNED-CLIENT.md`, `public/js/owned-client.js`,
`tools/owned-client-check.mjs`, `work/implementation/OCLI-N1.md` - none of which the candidate
touches. `git merge-tree --write-tree de4ecb6 11982a6` returns a tree (`a90a1937...`) with **exit 0,
no conflicts**. The coordinator's disjointness claim holds.

---

## Judgment on the declared limitations

- **No browser run.** Acceptable *in principle* for an HTTP+client-module proof - but the reviewer
  notes the probe's design (waiting past the debounce, never concurrent) is precisely why the
  in-flight race is invisible to it. "No browser" is not what hides this; the absence of a
  concurrent-save test is. So the limitation itself is acceptable; the gap it left is not.
- **A second tab holding pre-reset state can re-upload.** Framed honestly and acceptable given the
  monotonic merge and no accounts. However, the author's framing understates the problem by
  bundling the **single-tab** race under "cross-tab is not closed" - my finding needs no second
  tab.
- **New test not wired into CI** (`.github/**` was out of scope). Should **not** block *this* PR,
  but must not be forgotten: without CI wiring the regression is unguarded. It would take adding
  `node --test tools/reset-check.test.mjs` (plus `node tools/reset-check.mjs`) to
  `.github/workflows/ci.yml` in a follow-up where that path is allowed, plus the regression test
  for the in-flight race.
- **Deletion is not total** (backups/exports/portable copies, F-5). The framing is accurate and
  is asserted by `backup-copies-outside-deletion-path` rather than implied away - I confirmed the
  `progress.json.pre-recovery` copy survives a reset. If anything this is stated correctly, not
  understated.

## Reviewer's own probe

Written from scratch for this review (not the author's), driving the real `server.js` and the real
`public/js/store.js` in-process against a throwaway `.env`/`progress.json` under the OS temp dir.
Scenarios: S0 baseline, S1 in-flight save (single tab), S2 in-flight save + second tab, S3 leftover
`.bak`/`.tmp`, S4 double immediate reload, S5 `?scope=` values, S6 wedged marker (incl. unreachable
server), S7 kept/cleared split, S8 clearErrors split. Result **57 passed / 5 failed**; the failures
are the finding above plus one over-strict expectation of mine (`scope[]=all`). The probe lives in
the review scratch directory (throwaway) and is not committed; the repro is inlined in Check 4.

## Boundaries observed

Read-only on the candidate. Only write is this report on `codex/sec-02r-review-clawd`. No real
`.env`, no real learner data, no credential, no browser, no provider/AI call, no database, no
deployment. Synthetic values and throwaway files only.

---

### Summary for the coordinator

- **Fix is real and correct for the ordinary path; probe discriminates; merge protected; splits and
  counts verified; disjoint and merge-clean; `exam.js` untouched.**
- **One substantive gap:** the reset can be silently undone by its own **in-flight save** with a
  **single tab** (contradicts the author's "closed for one tab"). Repro + root cause + fix
  directions above. Requires a corrected claim plus a concurrent-save regression test; recommend a
  follow-up fix rather than blocking the primary deletion fix.
- **Verdict: accept-with-notes.**
