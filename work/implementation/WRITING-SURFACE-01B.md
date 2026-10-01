# WRITING-SURFACE-01B — task record

| | |
|---|---|
| Objective | conversion item (3): wire `draft-session.js` into the exam writing surface |
| Branch | `codex/writing-surface-01b` |
| Base SHA | **`e126d8c4b18a2beaf58eca2d279fe8d191e825ae`** (`origin/codex/ownapi-03-persistent`, verified against `git rev-parse`) |
| PR | [#75](https://github.com/ronslink/hatoove/pull/75) against `codex/ownapi-03-persistent` (not `main`) |
| Files changed | `public/js/exam.js`, **new** `public/js/writing-surface.js`, `tools/writing-surface-check.mjs`, `tools/writing-surface-check.test.mjs`, `tools/writing-surface-browser-check.mjs`, `.github/workflows/ci.yml`, this file |
| Not changed | `public/js/draft-session.js`, `public/js/store.js`, `public/js/account.js` (consumed only), `public/js/owned-client.js` |

Every commit cites the base SHA above.

---

## Step 1 — the writing entry point, found by reading

`public/js/exam.js` is 1648 lines. Grep for `saveNow`, `recordAttempt`, `draft`, `textarea`, `writing`.

**The standalone Schreiben view (this slice's target):**

| What | Line |
|---|---|
| `writingView(el, params)` — the writing screen | `public/js/exam.js:603` |
| `renderWritingTask(el)` — builds the screen | `:621` |
| the learner's text lives at `textarea#writing-text` | `:656` |
| text read for the word count | `:683` |
| text read for the offline check | `:725` |
| text read for AI grading | `:737` |
| grading records weakness **tags** via `store.recordAttempt(...)` | `:771`, `:775`, `:777`, `:778`, `:789` |
| view teardown (stopped the timer only) | `:1638` `teardownExamViews()` |

**Finding — the plan's assumption is wrong, recorded rather than worked around.** §2 of the plan allows the
writing text to go "through `store.saveNow()` or a direct `store.recordAttempt`". It does **neither**. There is
**no persistence of the writing text at all today**: no `store.saveNow()` on `#writing-text`, and
`store.recordAttempt` carries only *weakness tags* computed from a completed grading (`:771`–`:789`), never the
text. Leaving the Schreiben view discards the text and re-entering starts empty. That is exactly the gap item (3)
closes.

**A second, separate writing path — deliberately not wired.** `renderMockWriting` (`:1427`) keeps its text in the
in-memory mock session (`session.writingText`, written `:1337`/`:1385`, read `:1317`); the whole mock session
persists nothing. Wiring it would widen the diff to a different screen. See LIMITS.

**What `session().openDraft(taskId)` demands of a caller** (`public/js/account.js:376`, `async`): it throws
`OwnedClientError('unauthenticated')` unless the page is signed in; its inner `session.open()` can also reject
`unauthenticated` and re-enter signed-out. A view must catch both and render a *view state*.

---

## The design

A new DOM-free controller, `public/js/writing-surface.js`, owns the text lifecycle
(`enter` / `change` / `flush` / `resolveConflict` / `leave` / `state`). `public/js/exam.js` renders the textarea
and the `#w-draft-status` line and delegates:

- `writingView` records the rotation slot; the draft's **task identity** is `writing-sa1-<slot>`
  (`writingTaskId(slot)`), stable across leave/return and advancing only on "Neue Aufgabe";
- `renderWritingTask` calls `surface.enter(taskId, {initialText})`, populates the textarea with the saved text,
  and wires `input -> surface.change()`;
- `teardownExamViews()` (called on every `navigate`) calls `surface.leave()`, which **flushes before closing** —
  `close()` drops local text, so a view that closed while dirty would be the N-2 data-loss defect;
- a `409` paints two explicit choices (`resolveConflict('local'|'server')`) rather than swallowing the conflict;
- on the single-user path the boundary refuses, `enter()` resolves to `mode:'local'`, nothing is persisted, and
  the status line stays empty — the view is unchanged from today.

One surface per page (`writingDraftSurface()`); `enter()` awaits a pending `leave()` so a task switch cannot race
the previous flush.

---

## The check, verbatim

`node tools/writing-surface-check.mjs`:

```
PASS enter-restores-the-saved-text-on-return
PASS leave-flushes-unsaved-text-before-closing
PASS debounced-save-persists-without-leaving
PASS stale-save-is-refused-and-stored-text-unchanged
PASS resolving-the-conflict-locally-writes-the-kept-text
PASS single-user-path-persists-nothing
PASS a-failed-save-does-not-drop-the-text

7 passed, 0 failed
NOTE in-memory datastore/session/pointer fakes only; no browser, no DOM, no PostgreSQL.
```

It drives the real `public/js/draft-session.js` over the real `public/js/owned-client.js` against the real
`server/owned-api.mjs`, with the test-only in-memory datastore/session/pointer fakes reused from
`tools/owned-api-check.mjs`. The injected `openDraft` reproduces `account.js`'s contract exactly (reject
`{code:'unauthenticated'}` unless signed in, otherwise an opened draft session).

### Acceptance set A — proven / not proven

| Property (plan §"A. Same-browser draft integration") | Proven | Where |
|---|---|---|
| **leave and return** — text written, screen left, re-entered → text is there | **yes** | `enter-restores-the-saved-text-on-return` (node) **and** the browser check (rendered) |
| **flush before close** — leaving with unsaved text saves it | **yes** | `leave-flushes-unsaved-text-before-closing` (asserts the STORED value) |
| **the fence** — a stale save is refused and the text proven unchanged | **yes** | `stale-save-is-refused-and-stored-text-unchanged` (asserts `attempt().draft.text` and the datastore fingerprint, not the status code) |
| **single-user path unchanged** | **yes** | `single-user-path-persists-nothing` (node) **and** the browser check (accounts off: empty textarea on return, no status painted) |
| **discrimination** — break the restore, watch the check fail | **yes** | the `.test.mjs` mutant, below |

**Not proven / not delivered (acceptance set B — explicitly out of scope):** a full page reload starts a fresh
rotation slot, so the previous slot's draft is **not** auto-resumed — finding and resuming an account's drafts
needs S6's enumeration route and stable task identity. The draft itself is on the server; the app has no route to
it after a reload. The browser check prints this as a NOTE rather than asserting it.

### The browser check (rendered evidence)

`CHROME_PATH=/snap/bin/chromium node tools/writing-surface-browser-check.mjs --port 4361` (run twice, both green):

```
PASS  single-user: leaving and returning starts from an empty textarea, as today  [value length 0]
PASS  single-user: no draft status is painted  [status=""]
PASS  account: a synthetic account signs up against the in-process owned API  [synthetic.writing-surface@example.invalid]
PASS  account: a fresh draft starts empty  [value length 0]
PASS  account: the view reports the opened draft as saved  [Entwurf gespeichert.]
PASS  account: the debounced autosave reports saved  [Entwurf gespeichert.]
PASS  account: the typed text is restored when the screen is re-entered  [93 chars restored (from the server draft, not page memory)]
NOTE  a page reload starts a fresh rotation slot; auto-resuming the previous slot is S6 (set B), not this slice.
PASS  no console errors during the run  [clean]

8 passed, 0 failed
```

It drives the real page over real HTTP: an in-process `server.js` mounted with the real `server/owned-api.mjs`
over the in-memory fakes (no PostgreSQL), real sign-up, the real writing view, real navigation away and back.

### The discrimination leg, verbatim

`node --test tools/writing-surface-check.test.mjs`:

```
# tests 10
# pass 10
# fail 0
# mutant failures: enter-restores-the-saved-text-on-return
```

The scratch copy of `public/js/writing-surface.js` has its **restore leg disabled** (the server snapshot is
ignored on entering a task). On that mutant exactly one check fails —
`enter-restores-the-saved-text-on-return` — and every other check still passes, so the failure is specific and
not a module that failed to load. The checkout is never modified and the scratch copy is removed.

---

## Two defects found while making the checks pass (recorded, not hidden)

1. **`state().dirty` ignored text typed but not yet saved.** Between keystrokes the surface holds the newest text
   while the draft session still holds the previous one, so `dirty` read from `snapshot()` alone and the status
   line said "Entwurf gespeichert." while the text was unsaved — a status that lies. Fixed in `state()`:
   `dirty = snap.dirty || text !== snap.text`. This was caught because the browser check now waits for the
   *value* to return, not just for a status string (suspected the check first, per rule 4 — it was right twice:
   the second time the check raced the async restore).
2. **The check raced the async restore** — it read the textarea before `enter()` resolved. Fixed by waiting on the
   textarea value with a bounded timeout.

---

## Baselines re-run (this tree, `node <file>`)

| Suite | Result |
|---|---|
| `tools/check.js` | **101 passed, 0 failed** |
| `tools/writing-check.js` | **9 passed, 0 failed** |
| `tools/feedback-check.js` | **14 passed, 0 failed** |
| `tools/draft-session-check.mjs` | **18 passed, 0 failed** |
| `tools/owned-client-check.mjs` | **31 passed, 0 failed** |
| `tools/design-check.mjs` | **11 passed, 0 failed** (exit 0) |
| `tools/repository-check.mjs` | **passed** (329 tracked files; 258 text blobs screened) |
| `tools/mock-outcome-check.mjs` | **19 passed** (incl. discrimination) |
| `tools/progress-scope-check.mjs` | **7 passed** (incl. discrimination) |
| `tools/provider-config-check.mjs` | **11 passed** |
| `tools/server-origin-check.mjs` | **16 passed** |
| `tools/reset-check.mjs` | **8 passed** |
| `tools/revision-check.mjs` | **8 passed** (incl. discrimination) |
| `tools/keymask-check.mjs` | **12 passed** |
| `tools/progress-equal-check.mjs` | **10 passed** (incl. discrimination) |
| `tools/owned-api-check.mjs` | **24 passed** (memory backend) |
| **new** `tools/writing-surface-check.mjs` | **7 passed, 0 failed** |
| **new** `node --test tools/writing-surface-check.test.mjs` | **10 passed, 0 failed** |
| **new** `tools/writing-surface-browser-check.mjs` | **8 passed, 0 failed** (2 runs) |

---

## LIMITS — what was NOT executed, stated plainly

- **The reload/resume path (acceptance set B) is not delivered and not tested.** After a page reload the app
  generates a new rotation slot, so the previous slot's draft is not shown; enumerating and resuming an account's
  drafts needs S6's server route and stable task identity. Do not accept this slice as delivering B.
- **`public/js/exam.js`'s mock-exam writing block (`renderMockWriting`, `:1427`) is NOT wired** to the draft
  service. It is a separate screen whose whole session is in-memory; wiring it would widen the diff and is a
  different concern. Its text is still lost on leaving, as before.
- **No PostgreSQL / RLS evidence.** The browser check mounts the real owned API over the in-memory fakes
  (`tools/owned-api-check.mjs`), exactly as the plan advises ("prefer no database over a convenient one"). That a
  draft survives re-provisioning on real PostgreSQL is `postgres-provision-check`'s existing claim, unaffected.
- **Browser evidence is headless Chromium with an emulated viewport.** No real phone, no hardware keyboard, no
  audio path, no second physical device. The two heads are emulated pages on one host.
- **`tools/writing-browser-check.js` (the pre-existing offline writing suite) was NOT run.** `tools/cdp.js`'s
  `findBrowser()` does not list `/snap/bin/chromium`, so on this host it would report no Chromium. Rather than
  claim a pass, it was not run; the new `writing-surface-browser-check.mjs` finds Chromium via `CHROME_PATH`
  (and is what CI runs, where Chrome is at a documented path).
- **No changes to `draft-session.js`'s contract, `store.js`'s fence, or `account.js`'s public surface.** `exam.js`
  now imports `session` from `account.js` and the new controller; no new export was added to `account.js`.
- **`save()`'s `already_submitted` refusal is surfaced as a status but its learner-facing text is provisional**
  (the view says "noch nicht gespeichert" until the surface maps it); the conflict path (the plan's third
  refusal) is the one rendered as an explicit choice. `stale_session` renders a view-state note.
- **No deployment, no DNS, no live payments, no live AI, no new production access.** `D:\B1_Prep` was never
  touched; this work ran on Hetzner against synthetic data and provider stubs only.
