# DRAFT-SESSION-01 — recoverable-draft service layer (no `exam.js`)

| | |
|---|---|
| Task / execution | DRAFT-SESSION-01 / `draft-session-01-claude-20260930-a` |
| Worker | Claude for Windows (local), coordinator `COORD-TAKEOVER-20260930` |
| Base | `origin/main` @ `258f2000b8fed1a30677937ad5464c3d0599b43a` (re-checked with `git rev-parse origin/main` before editing; unchanged from the assignment) |
| Branch | `codex/draft-session-01` |
| Allowed paths used | `public/js/draft-session.js`, `tools/draft-session-check.mjs`, `tools/draft-session-check.test.mjs`, `work/implementation/DRAFT-SESSION-01.md` |
| Not touched | `public/js/exam.js`, `public/js/owned-client.js`, `server/owned-api.mjs`, `IMPLEMENTATION_PLAN.md`, `work/BOARD.md`, `docs/qa/DRAFT-RECOVERY-MATRIX.md` (no inaccuracy found: the *browser* surface is still unwired, so section U's "currently missing" remains true) |
| Status | Module + 17 offline checks + discrimination done. **Closes no browser, device, security or educational gate.** Independent review is batched. |

## What was built

`public/js/draft-session.js` is a DOM-free service layer: no imports, no `localStorage`, no timers, no
module-scope state. It drives an injected `createOwnedClient()` instance.

```js
const session = createDraftSession({ client, pointers, taskId, newEventId? });
await session.open();                 // start or resume -> snapshot {status, attemptId, revision, text, dirty, conflict, submissionId}
await session.save(text);             // {status: 'saved'|'unchanged'|'conflict', ...}
session.resolveConflict('server'|'local');
await session.submit();               // {submissionId, replay}
await session.readResult();           // read only; never retries or regrades
session.snapshot(); session.close(); await session.signOut();
```

### Why these names

- **`open()`** rather than separate `start`/`resume`/`recover`: a page load cannot know which one applies
  until it has asked the server, and making the caller choose invites "create a new empty attempt" on a
  reload that should have recovered. One entry point; the snapshot says what it found.
- **`save(text)`** takes the text and uses the revision *the session last saw* internally. The caller never
  passes a revision, so a UI cannot accidentally pass a fresher one and defeat the check.
- **`resolveConflict(choice)`** is a separate, synchronous, explicit step. `PILOT-V0.1.md:34` says
  *"Conflict never silently overwrites text: the consumer preserves local text and offers
  compare/reload/new revision."* A save that auto-resolved would violate that; so after a 409 the session
  re-reads, keeps local text, and refuses further `save()`/`submit()` with `conflict_unresolved` until the
  caller picks `'server'` (adopt the server copy) or `'local'` (keep mine; the next save deliberately
  replaces the server text on the re-read revision).
- **`submit()`** refuses `unsaved_changes` rather than auto-saving, so the frozen text is exactly the
  server-saved revision the learner last saw confirmed.
- **`signOut()`** / **`close()`**: sign-out drops local text *before* the server request, so a failed
  sign-out cannot leave text readable; `close()` drops it without contacting the server.

### Design decisions a reviewer should check

1. **Task identity lives in an injected pointer store.** Contract 0.1.0 attempts carry no caller task id
   and there is no list route, so a fresh page cannot find its attempt from the server alone. The caller
   injects `pointers` (`get/set/delete`, may be async) holding, per `(account id, task id)`, only
   `{attemptId, submissionId, pendingEventId}` — **identifiers, never learner text**. A pointer is only a
   hint: the server's owner scoping decides what it resolves to; a 404 or malformed record is dropped and a
   fresh attempt created. **The durable browser implementation of this store, and whether task identity
   should move server-side, are coordinator decisions (PILOT-02-DRAFT "task identity") and are deferred.**
   The checks use an in-memory `Map`.
2. **Fencing.** The session captures the client's `generation` and verified account id at `open()` and
   re-checks both before every request and after every await. Any change (sign-out, `clear()`, account
   switch, a 401) drops local text and fails with `stale_session`, including for a response that arrives
   after sign-out.
3. **Saves are serialised** through an internal promise chain, so a double-fired save never conflicts
   with itself, and a save equal to the saved text sends nothing (`unchanged`).
4. **Submission identity.** The event id is written to the pointer *before* sending. A network/5xx/
   malformed outcome keeps it pending (even across a reload), and `submit()` retries with the same id; a
   4xx is a definite answer (a failed enqueue commits nothing), so the id is released.
5. **Local text is memory-only.** Unsaved text survives a network failure in memory (R5) but not a reload;
   a reload recovers only what the server saved. A local durable copy (R6) is deliberately not built.

## Evidence

### Harness (reused, not parallel)

`tools/draft-session-check.mjs` imports `createMemoryDatastore` and `createMemorySessions` from
`tools/owned-api-check.mjs` and routes the **real** `owned-client.js` into the **real**
`createOwnedApi().handle`. The only repeated code is the ~20-line in-process fetch adapter, because
`owned-api-check.mjs` does not export `inProcessBrowser` and that file is outside the allowed paths. The
adapter adds what this task needs: one cookie jar shared by several tabs of a "browser profile", and fault
hooks (`before` = request never arrives, `after` = server committed but the response is lost, `hold` =
delayed response). A simulated **reload** is a cache-busted `import()` of the module (a fresh module
instance), a new client, the same cookie jar and the same pointer store.

### Checks (17) and what each covers

| Check | Acceptance item |
|---|---|
| `open-creates-one-owned-attempt-and-records-only-ids` | start/resume; pointer holds ids only |
| `recovery-across-simulated-reload` | **2** — umlauts, Arabic, emoji, newlines come back byte-identical at revision 3, from a fresh module instance; no second attempt |
| `unsaved-text-is-not-invented-after-reload` | R5 in memory; reload returns only server-saved text |
| `stale-save-rejected-writes-nothing` | **3** — two tabs; stale save → `conflict`, datastore fingerprint unchanged, PUT sent once (never retried), further saves/submit refused locally with nothing sent; `resolveConflict('local')` then save → revision 3 |
| `conflict-resolved-to-server-adopts-server-copy` | **3** — the other resolution path |
| `repeated-and-concurrent-saves-do-not-corrupt` | **3** — identical save sends nothing; double-fired save = one write; two concurrent texts applied in order, no 409 |
| `sign-out-drops-text-and-next-account-cannot-recover-it` | **4** — snapshot null after sign-out; account B on the same jar + pointer store starts empty with its own attempt; leak scan of B's responses, snapshot and pointers finds none of A's text |
| `forged-pointer-to-another-account-resolves-to-nothing` | **4** — B's pointer seeded with A's attempt id → 404 → fresh attempt; hint replaced |
| `late-response-after-sign-out-does-not-land` | **4** — PUT held, sign-out, response released → `stale_session`, snapshot stays null |
| `account-switch-under-an-open-session-fails-closed` | **4** — client re-signed-in as B, or `clear()` → `stale_session`, nothing sent |
| `submit-freezes-the-saved-revision` | **5** — unsaved text refused; frozen text/revision equal the saved ones; saving after submit refused; reload recovers the submission |
| `uncertain-submit-reuses-the-same-event-id-after-reload` | **5** / R9 — lost response, reload, same event id → `replay: true`, one submission, one reservation |
| `definite-submit-rejection-releases-the-event-id` | 422 releases the pending id |
| `read-result-never-regrades` | **5** — three reads identical; datastore calls are only `result`; fingerprint and entitlement unchanged; a failed job stays `failed`/unassessed |
| `fail-closed-without-client-or-account` | **6** — no client / fake client / no pointer store → `not_configured`; unreachable transport, signed out, 503 server, network down while resuming → rejection, `snapshot() === null`, no attempt created, pointer kept |
| `invalid-input-is-refused-before-sending` | bad task ids, oversize text, malformed pointer (path-like attempt id) |
| `snapshot-is-a-copy-and-module-has-no-ambient-state` | snapshot is a copy; source has no import/storage/DOM/timer/fetch |

### Discrimination (item 7)

**What would fail if the revision check were removed:** a tab holding an old revision would save over a
newer draft from another tab — last writer wins, silently. `stale-save-rejected-writes-nothing` catches
that (the stale save must return `conflict` and leave the datastore fingerprint unchanged), and so does
`conflict-resolved-to-server-adopts-server-copy`.

Manual run, scratch copy (checkout never modified), mutating the one line that sends the last-seen
revision so that every save uses the server's current revision instead:

```
-      saved = await client.saveDraft(s.attemptId, { expectedRevision: s.revision, text });
+      saved = await client.saveDraft(s.attemptId, { expectedRevision: (await client.readAttempt(s.attemptId)).revision, text });

$ node tools/draft-session-check.mjs %TEMP%\dsm\draft-session.mutant.js
FAIL stale-save-rejected-writes-nothing
  a stale save must conflict, got {"status":"saved","revision":3}
FAIL conflict-resolved-to-server-adopts-server-copy
  Expected values to be strictly equal:
15 passed, 2 failed (module: ...\dsm\draft-session.mutant.js)
```

The scratch copy was then deleted; the real module passes 17/17. `tools/draft-session-check.test.mjs`
repeats this automatically on every run, for two mutants:

- (a) the scratch module mutant above, and
- (b) the real module over a datastore whose `save` ignores `expectedRevision` (server-side check off).

Both must fail **exactly** those two checks while the other 15 pass. Asserting the exact set matters: the
first draft of this test deleted its scratch directory too early, every check failed with "Cannot find
module", and only the detail assertion stopped that from being read as discrimination. The exact-set
assertion now makes a broken mutant load fail the test.

### Exact counts (this tree)

| Command | Result |
|---|---|
| `node tools/draft-session-check.mjs` | **17 passed, 0 failed** |
| `node --test tools/draft-session-check.test.mjs` | **21/21** (17 checks + suite-complete + mutant-differs + 2 discrimination) |
| `node tools/check.js` | **101 passed, 0 failed** |
| `node tools/writing-check.js` | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | **14 passed, 0 failed** |
| `node tools/server-origin-check.mjs` | **16/16** |
| `node tools/reset-check.mjs` | **9/9** |
| `node tools/revision-check.mjs` | **8/8** |
| `node tools/owned-client-check.mjs` | **31/31** |
| `node tools/owned-api-check.mjs` | **24/24** |
| `node tools/keymask-check.mjs` | **12/12** |

## Deferred — deliberately not done

- **`public/js/exam.js` wiring** (textarea → `save()`, conflict UI, submit button). Separate task, waits
  on the paused hold. Until it lands, section **U** of `DRAFT-RECOVERY-MATRIX.md` stays "currently
  missing" for the browser: this module makes the logic demonstrable offline, not the surface.
- **No browser and no device evidence.** Section **D** (R14 keyboard, R15 tab discard/process kill) stays
  open. Nothing here was run in a browser, on an iPhone or on Android, and no emulated result is claimed.
- **Durable pointer store** (e.g. a `localStorage` adapter keyed by account) and the **task-identity
  decision** (client pointer vs a server-side task binding/list route). Coordinator-owned.
- **Autosave cadence/debounce** (needs timers; belongs with the UI).
- **Local durable copy of unsaved text** (R6 quota/private mode) — not built; unsaved text is memory-only.
- **Discard / new attempt (R7) and revise-after-submit (R11 `parentSubmissionId`)** — not exposed by
  this module yet; the client supports both.
- **`retry()` of a failed assessment** — intentionally not exposed; `readResult()` is read-only.
- **Pointer cleanup on sign-out** — pointers (ids only) are kept for the same account's next sign-in;
  whether to purge them on shared devices is a policy decision.
- **No PostgreSQL/RLS evidence, no real auth.** The datastore and sessions are the test-only in-memory
  fakes from `owned-api-check.mjs`.

## Boundaries observed

Offline only: no browser, database, provider call, `.env`, real credential or deployment. Synthetic text
only. No merge, force-push or rebase. `node tools/repository-check.mjs` run on the staged snapshot before
pushing.
