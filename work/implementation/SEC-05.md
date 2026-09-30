# SEC-05 — a reset invalidates older writes via a persisted revision (proper F-2 race fix)

| | |
|---|---|
| Task / execution | SEC-05 / `sec-05-openclaw-20260930-a` (coordinator `COORD-TAKEOVER-20260930`) |
| Worker | OpenClaw/Hetzner, slot 3. Authored SEC-02; the defect was found by **Clawdbot** (`sec-02r-clawd-20260930-a`), so this is not self-graded |
| Base | `origin/main` @ `8a71f718ee534851a98d19eece07dab933b56479` |
| Branch | `codex/sec-05-revision` (fresh worktree; `hatoove-sec02` not reused) |
| Pull request | [draft PR #47](https://github.com/ronslink/hatoove/pull/47) (base `main`), head `6a8eb1a` |
| Allowed paths | `server.js`, `public/js/store.js`, `tools/reset-check.mjs`, `tools/revision-check.mjs`, `tools/revision-check.test.mjs`, `work/implementation/SEC-05.md` |
| Fixes | `work/implementation/SEC-02R-REPORT.md` finding **F-2 race (medium-high)** |
| Status | The race is closed and the probe discriminates against the pre-fix tree. **This closes no security or privacy gate.** Human `P-03` review remains required. |

## What the defect was

SEC-02 made both reset actions reach a real `DELETE`, but its report claimed the
in-flight-save race was *"closed for one tab"*. The independent review proved that false with
**no second tab**:

```
seed server + localStorage with a record containing SYNTHETIC-LEARNER-TEXT-PROBE
store.importJSON(record)   // queues the normal 1200 ms debounced save
wait 1300 ms               // debounce fires; the POST is now on the wire
await store.resetAll()     // user clicks "Alles zurücksetzen" while that save is in flight
-> DELETE runs, server found = false          // the delete worked
reload -> syncFromServer()
-> server found = true     (RESURRECTED)      // the stale POST merged the record back
```

The review's measured root cause: `progressEqual()` compares `JSON.stringify`, while
`mergeProgress()` emits the top-level object with a different key order (`counters` is moved
ahead of `nodes`). So the server returns a full payload on **every** `POST`; `sendProgress()`
folds that payload back and calls `writeLocal()` **after** `resetAll()` cleared the browser
cache, and the next load re-uploads the record through the still-merged `POST` path.

Re-measured on the base commit for this report:

```
progressEqual(state, mergeProgress(state, state)) === false
client keys : version,createdAt,updatedAt,settings,nodes,history,errors,srs,days,planDone,counters
merged keys : version,createdAt,updatedAt,settings,counters,nodes,history,errors,srs,days,planDone
```

## The fix

The monotonic merge stays: it is deliberate, and it protects a learner whose partial write would
otherwise erase a week of study. What changes is that a `DELETE` leaves a mark a **stale** write
cannot cross.

### `server.js` — persisted revision + delete tombstone

- `PROGRESS_REV_PATH = <progress>.rev` holds `{rev, deletedThrough}` and is written atomically
  (temp + rename). It is a **sidecar, not a field in `progress.json`**: a full reset deletes
  `progress.json`, so a revision stored inside the record would be destroyed by exactly the
  delete it exists to survive. Beside the record it survives the delete and a restart.
- `GET /api/progress` returns `rev` (and returns it with `found:false` too, so a client that
  reconnects after a reset can learn the post-delete value). A GET never advances it.
- `POST /api/progress` carries `rev` and is classified by `classifyWrite()`:
  - `rev < deletedThrough` → **`409 {code:"stale_revision", reason:"older_than_delete"}`**, nothing
    written. This is the write that left *before a delete*.
  - `rev` equal, or merely *behind the current revision but at/after `deletedThrough`* → accepted
    and merged as today, then `rev` advances. The deliberate multi-tab merge protection is kept.
  - `rev` ahead of the stored one → accepted; it means this server lost its marker and refusing
    would discard learner evidence. It cannot cross a delete, because the comparison is against
    `deletedThrough`.
  - **Missing `rev`** (a lean client that only posts `{state}`): accepted while no delete has
    happened, so an existing simple client keeps working; **refused** once a delete has advanced
    the revision, because such a write cannot be proven newer than the delete and silently
    accepting it would reopen the hole. This is the deliberate choice the task asked to document.
- Every accepted write advances `rev` (`Math.max(rev, sent)+1`). A delete (`scope=all` **and**
  `scope=errors`) advances `rev` and sets `deletedThrough = rev`, **before** removing or rewriting
  anything, so a crash between the two steps leaves the revision high (which only costs the next
  writer a re-read) rather than low (which would let a pre-delete write through). An unknown scope
  is still rejected and does not move the revision.

### `public/js/store.js` — carry the revision; on 409 re-read instead of retrying

- The client remembers `serverRev`, captured from `GET`, `POST` and `DELETE` responses, and sends
  it with every save.
- A **state epoch** guards the fold: if the whole state was replaced since a save left (a reset,
  an import, adopting the server copy), the response is *not* folded back. This is what stops the
  SEC-02R mechanism directly — the response handler can no longer write the deleted record into
  the cache after `resetAll()` cleared it.
- On `409 stale_revision` the client does **not** retry a stale snapshot; it re-reads and adopts
  the server copy (empty after a full reset), which keeps the record consistent.
- On startup, `found:false` together with `rev > 0` means the record was deleted on purpose, so
  the browser copy is dropped rather than uploaded. (`rev > 0` and no record can only follow a
  delete.) A server that has never held a record (`rev 0`) is still seeded from a browser-only
  learner — the one-time migration path is preserved.
- `resetAll()` bumps the epoch before it touches anything and re-asserts the empty browser cache
  after awaiting the in-flight save and the delete; `clearErrors()` gets the same epoch guard, so a
  save still carrying the notebook entries cannot merge them back either.

### `tools/reset-check.mjs` — the `--legacy-root` trap

`--legacy-root` with no value silently resolved to the current directory and compared the candidate
against itself (`pre-fix run fails 0 check(s)`, exit 0). It now fails loudly on a missing value, on
a path without `server.js`, and on a path equal to this tree:

```
$ node tools/reset-check.mjs --legacy-root            -> FAIL  --legacy-root requires a path ... (exit 1)
$ node tools/reset-check.mjs --legacy-root /nope       -> FAIL  no server.js under /nope ...   (exit 1)
```

The scenario helper also clears the `.rev` sidecar between scenarios, so each isolation case starts
from a clean slate.

## Evidence

### The discrimination requirement (the point)

`tools/revision-check.mjs` runs the reviewer's exact probe — including a genuinely slow POST leg
and an assertion that the save **was** in flight at reset time — against both trees. The pre-fix
tree is materialized from git, not simulated: `git show 8a71f71:server.js` plus the pre-fix
`public/js/store.js` (`public/js/progress-merge.js` and `public/js/blueprint.js` as loaded
dependencies). Stable across three consecutive runs:

| Probe observation | This tree (fixed) | Pre-fix tree `8a71f71` |
|---|---|---|
| POST genuinely in flight at reset | **yes** | **yes** |
| server `found` immediately after reset | false | false (the delete always worked) |
| cache still holds the probe text after reset | **false** | **true** |
| server `found` after reload | **false** | **true — RESURRECTED** |
| POSTs re-uploaded on reload | **0** | **1** |

A probe that passes on both trees proves nothing; this one fails on the pre-fix tree exactly as the
reviewer reproduced.

### Exact counts

| Command | Before | After |
|---|---|---|
| `node tools/check.js` | 101 passed, 0 failed | **101 passed, 0 failed** |
| `node tools/writing-check.js` | 9 passed, 0 failed | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | 14 passed, 0 failed | **14 passed, 0 failed** |
| `node tools/server-origin-check.mjs` | 16/16 | **16/16** |
| `node tools/reset-check.mjs` | 9/9 | **9/9** |
| `node tools/owned-client-check.mjs` | 31/31 | **31/31** |
| `node tools/revision-check.mjs` | — | **8/8, exit 0** |
| `node --test tools/reset-check.test.mjs` | 12/12 | **12/12** |
| `node --test tools/revision-check.test.mjs` | — | **10/10** |
| `node --test tools/reset-check.test.mjs tools/revision-check.test.mjs` | — | **22/22** (suites isolated by unique module URLs) |
| `node tools/repository-check.mjs` | passes | **passes** |

The seven `revision-check` checks cover: the reviewer's race; ordinary/partial writes still
merging; a pre-delete write refused with `409 stale_revision`; a 409 handled by re-read (record
stays consistent); `?scope=errors` clearing only the notebook and keeping history/ability; the
revision surviving a server restart; and the missing-revision choice. `--prefix-root <path>` runs
the discrimination against a pre-fix checkout supplied by hand when git is unavailable; otherwise
the CLI materializes the tree from git and **fails** if it cannot prove discrimination.

## Where the design is wrong or insufficient (stated, not hidden)

1. **The `progressEqual` key-order bug is untouched.** `public/js/progress-merge.js` is not in the
   allowed paths, so the server still ships a redundant full `state` on every `POST` and the client
   still folds on every save. That is the measured root cause of the original report. It is now
   *harmless* (the tombstone refuses stale writes and the epoch discards post-reset folds), but it is
   still wasteful and remains the reason the fold path runs at all. A follow-up that makes
   `progressEqual` order-insensitive (or compares a stable digest) would remove the redundant
   payloads; it belongs in a task that owns `public/js/progress-merge.js`.
2. **A not-yet-re-read writer loses writes made after the reset.** If a second tab still carries a
   pre-delete revision and answers a question after the reset, that save is refused (its revision is
   older than the delete, which is the spec). The client re-reads and adopts, so the record stays
   consistent and the next save from that tab is accepted, but the one in-flight answer on that tab
   is dropped. This is the intended "a reset wins" semantics, not a silent resurrection.
3. **`?scope=errors` also advances `deletedThrough`**, so a concurrent pre-clear write from another
   tab is refused like a full reset. Deliberate — otherwise an in-flight save would merge the cleared
   notebook entries straight back — but stricter than the previous behaviour.
4. **`found:false` with `rev > 0` discards a browser-only copy.** If `progress.json` *and* its `.bak`
   both disappear out of band while `.rev` survives, the browser copy is dropped rather than
   uploaded. That is the price of never resurrecting a deliberate reset; losing both the record and
   its one-generation backup this way is not a supported state.
5. **`rev` is not persisted in the browser.** The real app awaits `store.syncFromServer()` before the
   first render (`public/js/app.js`), so the client always knows the revision before it can post
   anything. The remaining window (a save before the first GET) is answered with 409 + re-read, never
   with a stale write.
6. **`tools/verify-portable.js` posts `{state}` with no revision.** It still works while no delete has
   happened (its normal case), and a post-delete upload is refused rather than silently accepted.
   It was not updated because it is outside the allowed paths.

## Not done / not verified

- **No browser run.** The probe is an HTTP + client-module proof. It makes the network leg genuinely
  slow and asserts the save was in flight, so the race is exercised for real, but no page lifecycle,
  iPhone/Android keyboard or audio check was performed. Those remain required before the pilot.
- **No live provider, database, deployment or real learner data.** Throwaway temp directories,
  synthetic values only.
- **`public/js/exam.js` untouched** (separate paused hold). No files outside the allowed paths were
  changed.
- **Not wired into CI.** `.github/**` is outside the allowed paths; the review already noted this
  must not be forgotten. `node tools/revision-check.mjs` fails loudly if it cannot demonstrate
  discrimination, so wiring it in is safe whenever that path is allowed.
- **Independent review of this diff is still pending** (batched per Ron's instruction). This change
  may be integrated before a reviewer sees it, so the evidence above is deliberately falsifiable:
  the probe fails on the pre-fix tree and asserts that the save was truly concurrent.

## Boundaries observed

Read-only on anything outside the allowed paths. No real `.env`, no real learner data, no credential
(never printed or transmitted), no browser, no live provider/AI call, no database, no deployment.
`node tools/repository-check.mjs` was run on the staged snapshot and `git diff --cached --check` was
clean before the commit.
