# COORD-REEXECUTION — the combined head `e126d8c` re-executed, and what that does and does not prove

| | |
|---|---|
| Why | `work/implementation/REVIEW-COVERAGE.md` recorded that **no review covered the current head** and set the integration decision: *"re-review the combined head, or record explicitly which findings are known-good by **re-execution rather than by reading** — and state that limitation in the merge decision."* This is that re-execution and that statement. **It is not a merge approval** |
| Written by | the coordinator, on the candidate's own behalf — **which is why it is evidence of behaviour and not a review** |
| Candidate re-executed | `codex/ownapi-03-persistent` @ **`e126d8c4b18a2beaf58eca2d279fe8d191e825ae`** (PR #60) |
| Baseline | `origin/main` @ `4f76b9428aacfc2ef670bdd3bdf5e43fa316222e` — **untouched.** Nothing has been merged to it |
| Machine | the coordinator's host: Node v24.4.1, npm 11.7.0, Docker 29.7.2, `postgres:17-alpine`, headless Chrome at `C:\Program Files\Google\Chrome\Application\chrome.exe` |
| Database | a **fresh disposable** database `hatoove_rev` on a labelled disposable container (`postgres:17-alpine`), synthetic accounts only. **No production access of any kind** |

---

## 1. The honest boundary of this document

**This is re-execution, not independent review.** The distinction was already recorded and it is not a formality:

- CI re-running a behaviour on every push is **stronger than a one-off review for regression**;
- it is **weaker than a review for whether the check tests the right thing** — and every checker in this tree was
  written by the same author as the code it checks.

So this document can say *"the behaviour is what it was claimed to be, today, on a fresh database, at this SHA"*.
It cannot say *"the check is the right check"*. **Only an independent reader says that**, and three were dispatched
for exactly this head (see §6).

---

## 2. What was re-executed, and what it produced

**Every suite CI runs, plus the four browser suites, plus the discrimination legs, all at `e126d8c`.** Run from a
detached worktree at that SHA. Counters are as observed, not as recorded elsewhere.

### 2.1 The offline baseline

| Suite | Result |
|---|---|
| `repository-check.mjs` | passed — 325 tracked files, 254 text blobs screened |
| `check.js` | **101 passed, 0 failed** |
| `writing-check.js` | **9 passed, 0 failed** |
| `feedback-check.js` | **14 passed, 0 failed** |
| `design-check.mjs` | **11 passed, 0 failed**, exit 0 |
| `mock-outcome-check.mjs` | **19 checks passed**, including discrimination against the pre-fix `exam.js` (15/15 defect checks fail and 4 controls pass on the pre-fix tree) |
| `progress-scope-check.mjs` | **7 checks passed**, including discrimination against the pre-fix tree |
| `provider-config-check.mjs` | **11 checks passed** |

### 2.2 The server and owned-API contracts

| Suite | Result |
|---|---|
| `server-origin-check.mjs` | **16 checks passed** |
| `reset-check.mjs` | **8 checks passed** |
| `revision-check.mjs` | **8 checks passed**, including discrimination against the pre-fix tree |
| `keymask-check.mjs` | **12 checks passed** |
| `keymask-check.mjs --prefix-commit 8a71f718…` | **12 checks passed** |
| `progress-equal-check.mjs` | **10 checks passed**, including discrimination against the pre-fix tree |
| `draft-session-check.mjs` | **18 passed, 0 failed** |
| `owned-api-check.mjs` (memory) | **24 passed, 0 failed** |
| `owned-client-check.mjs` | **31 passed, 0 failed** |
| `feedback-case-check.mjs`, `objective-fixture-check.mjs`, `exam-blueprint-check.mjs` | structurally sound; blueprint consistent, 0 warnings |

### 2.3 The durable and hosted contracts, on real PostgreSQL

The database was created fresh and then provisioned by the checks themselves, exactly as CI's `postgres` job does.

| Suite | Result |
|---|---|
| `postgres-provision-check.mjs` | **5 passed, 0 failed** — including `second-run-applies-nothing-and-changes-no-role` and `a-fresh-world-still-sees-the-rows-and-the-policy` |
| `accounts-http-check.mjs` | **6 passed, 0 failed** — including **the restart property**: the session and the draft survive a real server restart |
| `owned-api-check.mjs --backend=postgres-persistent` | **24 passed, 0 failed** |
| `deletion-check.mjs` | **17 passed, 0 failed** |
| `session-boundary-check.mjs` | **13 passed, 0 failed** |
| `saas-runtime-check.mjs` | **10 passed, 0 failed** |

**Two of these are worth naming, because they are the properties the conversion exists to deliver.** The restart
property proves a draft survives a server restart **as the restricted learner role with FORCE RLS in force** — a
memory backend cannot show that at all. And `saas-runtime-check` re-proves, on a fresh database, that the legacy
progress route and the AI provider are **refused** unauthenticated, that `B1PREP_AI_TEST` is operator-only **with the
flag set** (the case the first review found open), and that a database interruption is a **refusal** rather than a
fallback to single-user.

### 2.4 The rendered behaviour, in real headless Chrome

| Suite | Result |
|---|---|
| `mock-outcome-browser-check.mjs --port 4341` | **11 passed, 0 failed** |
| `provider-config-browser-check.mjs --port 4344` | **13 passed, 0 failed** |
| `account-ui-browser-check.mjs --port 4347` | **25 passed, 0 failed** |
| `session-boundary-browser-check.mjs --port 4350` | **52 passed, 0 failed** |

Each asserts **no console errors** along the way. The counts are **higher than any record states** — 52 for the
session-boundary browser suite where `REVIEW-0600.md` §2.7 records 38, and 13 for the Node session-boundary suite
where §2.7c records 12 — because the N-1 and N-2 fixes added records after those reports were written. **The
documents are behind the code; the code is green.**

**The suite's own limit, quoted rather than paraphrased:** *"headless Chromium, emulated viewports: no real phone,
keyboard or audio was exercised."* A 390 px emulated viewport is not a phone, and the human gates
(`E-01`, `C-04`, `C-06`, `P-03`/`X-01`, real-device evidence) remain **open**.

---

## 3. What this re-execution establishes about the five review findings

This is the part `REVIEW-COVERAGE.md` asked for: **known-good by re-execution rather than by reading.** Each of the
five findings below was a real defect at the head it was found. The behaviour that the defect consisted of is now
**executed and correct at `e126d8c`**.

| Finding | Original defect | Re-executed at `e126d8c` | Verdict |
|---|---|---|---|
| **Runtime F1** | with `B1PREP_AI_TEST=1` an **anonymous same-origin caller reached the provider with zero session** | `saas-runtime-check` **`ai-test-is-operator-only-with-the-flag-set`**: anonymous 403, learner 403, wrong-token 403, **zero provider calls**; operator 200 with exactly one call | **closed, re-executed** |
| **Runtime F2** | the claim *"leaving the local install unchanged"* was **false** — five observable behaviours differ | `saas-runtime-check` **`legacy-progress-local-install-unchanged`** passes; the claim is corrected in the record rather than the hardening weakened | **closed, re-executed** |
| **Runtime F3** | `https://app.hatoove.example.test\@attacker.example` was **accepted** | `saas-runtime-check` **`configured-public-origin-accepted-and-foreign-refused`** — allowed 200, foreign 403, **rebound 403** | **closed, re-executed** |
| **Session F1** | *"sign-out clears private state"* was **conditional** (`forget: flushed`), so a held save or an offline sign-out left **plaintext in `localStorage`**; and `session-boundary-browser-check.mjs:372` asserted the property **unconditionally** while exercising one branch | `session-boundary-check` **`sign-out with the final save held past the budget`** and **`sign-out while offline`** both pass; the browser suite's `sign-out-*-leaves-no-account-text-in-storage` family passes | **closed, re-executed** |
| **Session F2** | a late response **landed through the writing view** — `exam.js:757-786` wrote after `await ai.gradeWriting(...)` with no fence | `session-boundary-browser-check`'s whole `late-writing-*` family passes, including `late-writing-feedback-puts-no-text-in-the-notebook-after-sign-out` and `late-writing-feedback-for-a-does-not-land-in-b` | **closed for the writing path, re-executed** |
| **Session F3** | a `resolve()` in the `visibilitychange` handler re-reconciled the single-user record on every tab return | `session-boundary-check` **`single-user: a second resolve (tab return) neither reconciles again nor replaces the in-memory record`** and **`…still notices another tab signing in (the hardening is kept)`** both pass | **closed, re-executed** |
| **N-2** | the unconditional forget destroyed unsaved work on the **expiry/refused** path and told the learner nothing | `session-boundary-check` carries the discard signal; **the browser suite does not exercise an expiry**, which is a finding in its own right — see §4.3 | **partly closed — see §4.3** |
| **N-1** | **another page of the same browser re-created the account record, with its text, after the sign-out forget** | `session-boundary-check` **`another page of the same browser cannot re-create the record after a sign-out, and the next sign-in still saves`** passes; the record also states that the **browser** half of this check cannot discriminate the fence and that the fence rests on the Node check alone | **closed, re-executed — with the discrimination limit recorded** |
| **N-3, N-4, N-5** | low: a `signed-out` marker on a single-user page; a coverage gap; dispatch files in the branch | **not addressed at `e126d8c`** | **open** |

**So: nine of the findings that made this head unreviewed are now correct by execution, one (N-2) is only partly
covered by execution, and the three lows are open.** That is the strongest statement re-execution can make, and it is
still not a review.

---

## 4. Three defects this re-execution found. All three are in the *evidence*, not in the behaviour.

Every one is the same family, which is the family this programme keeps finding: **the artefact that reports the
result does not report what it did.**

### 4.1 The hard-delete port is **not wired into the running server** — the production route is a permanent `503`

**This one is behaviour, and it is the most serious thing in this document.**

`tools/deletion-check.mjs` is **17/17** and every line of it is true *of the code it drives* — but it drives its own
`createOwnedApi({ ...ports, accountDeletion: deletion })` (`deletion-check.mjs:218`). The **running server** gets its
api from `server/accounts.mjs:86` → `createPostgresWorld()` → **`server/owned-postgres/fixture.mjs:36`
`createOwnedApi({ datastore: port, sessions, settings })` — with no `accountDeletion`.** So in hosted mode
`deletionWired` is false (`owned-api.mjs:250`) and `DELETE /api/v1/account` answers `503 deletion_unavailable`
forever. **Ron's "hard delete" cannot be reached by any learner.**

**Found empirically, not by reading.** `tools/coord-deletion-mount-probe.mjs` (added on
`codex/coord-verify-e126d8c`, **PR #76**) starts a **real server process** against a **real disposable database**,
signs a synthetic account up over HTTP, and asks it to delete itself:

```
PASS the running server accepts a sign-up over real HTTP (accounts really are mounted)
PASS the running server serves GET /api/v1/account for that session
     DELETE /api/v1/account -> 503 {"error":"deletion_unavailable"}
     the same cookie afterwards -> 200
FAIL the RUNNING SERVER actually performs the hard delete (200 deleted:true)
FAIL the account is really gone from the running server (the cookie stops working)
FAIL the running server reports the deletion honestly when it ran (completeErasure:false)
2 passed, 3 failed
```

**Why no check caught it:** every deletion check assembles its own API, so **a tree in which the deletion is
unreachable scores exactly the same as this one**. The one check that would catch it is the inverse of
`deletion-check.mjs:302` — assert that the API built by `createPostgresWorld` *deletes*, not only that an API built
without the port *refuses*.

**Dispatched as `DELETION-WIRE-01`.** Independent corroboration: the Hermes deletion review reached the same
conclusion from reading alone and added the second half — *"`createPostgresWorld` cannot be passed a deletion port
even if `accounts.mjs` wanted to: its options are `{allowance, fixture}` and its only injection seam is
`db.settings`. The wiring gap is not one forgotten argument; the world builder has no seam for a deletion port at
all."*

**FIXED AND RE-VERIFIED BY THE SAME PROBE, 2026-10-01.** On `codex/deletion-wire-01` @ `77cca13`, against a **fresh
disposable database provisioned from scratch**, the probe that failed here now passes **5 passed, 0 failed**:

```
DELETE /api/v1/account -> 200 {"deleted":true,"accountExisted":true,
  "removed":{...,"entitlements":1,"session":1,"user":1},
  "verifiedAbsent":true,"completeErasure":false,"notRemoved":[operator_backups,
  copies_outside_the_service, legacy_progress_file, model_provider]}
the same cookie afterwards -> 401
```

Four things about that output are worth more than the pass itself, because each is a claim this document made about
what was missing now being satisfied by *execution* rather than by reading the diff:

1. **`200` instead of `503`** — the running server now performs the deletion. `createPostgresWorld` gained a real
   `deletion` **seam** (`fixture.mjs:28,42-44`), `accounts.mjs:79` passes `persistent.deletion` into it, and
   `provision.mjs` adds `'deletion'` to `ROLES` (`:62`) and applies a tracked migration
   **`0005-account-deletion`** (`:77`). **That closes the second HERMES half too**: the run above is a learner
   deleting itself through a role the *provisioner* created, not one a checker invented. The ledger on the fresh
   database reads `0001-auth-schema … 0005-account-deletion`, and `hatoove_deletion` is `rolsuper=f`,
   `rolbypassrls=f` — least privilege, as the review required.
2. **`verifiedAbsent: true`** — a field that can only be true because the port's own pre-COMMIT read-back ran, which
   is the fix for the reviewer's F7. **The `removed` counts are still the delete's own `rowCount`s**, which is why
   the honest label matters and the reply now carries both.
3. **`legacy_progress_file` no longer over-claims.** The old text asserted *"Hosted mode refuses that file route"*
   while `/api/progress` is refused only under `B1PREP_SAAS=1` — so there was a real configuration in which the
   reply said the server refused something it accepted. The new wording states the conditional and says the
   response cannot promise the refusal. **F9 closed, and closed in the honest direction rather than by weakening
   the code.**
4. **A fourth item, `model_provider`**, names the provider that processed the submitted text and says no retention
   period is known. **F8 closed, and it invented no period** — the same rule that produced the correct backup
   wording.

**What this does NOT establish.** The probe exercises one account deleting itself over real HTTP; it does not
re-exercise the eleven-step transaction's per-table read-back, the forced-failure legs, or another owner's rows —
those are `tools/deletion-check.mjs`'s job, and its own re-run belongs to the branch's record. **The verification
here is narrow and stated as narrow.**

### 4.2 `owned-api-check --backend=postgres-persistent` prints the **memory** note

`tools/owned-api-check.mjs:956-958`:

```js
console.log(report.backend === 'postgres'
  ? 'NOTE real PostgreSQL datastore as the restricted learner role with FORCE RLS; synthetic sessions.'
  : 'NOTE in-memory datastore and session fakes only; no PostgreSQL/RLS evidence. Add --backend=postgres for that.');
```

The CI `postgres` job runs `--backend=postgres-persistent` (`.github/workflows/ci.yml:141`), and that value is not
`'postgres'`, so **the run that proves the durable property on real PostgreSQL prints a note telling the reader it
proved nothing.** The check itself is 24/24 and correct; the sentence is false. Observed verbatim in this
re-execution:

```
24 passed, 0 failed (backend: postgres-persistent)
NOTE in-memory datastore and session fakes only; no PostgreSQL/RLS evidence. Add --backend=postgres for that.
```

**Not yet dispatched.** It is a one-line fix plus a check that the note matches the backend, and it should not ride
along inside the deletion brief.

### 4.3 The N-2 discard notice is dropped on the path that needed it — its own branch has no test

**This is the same defect shape as the F1 it was written to fix, one slice later.** The N-2 fix moved the signal from
`signOut()`'s return value into a boundary field because a caller reading `lastSaveReached` on the expiry path got
`undefined`. The field it moved to (`account.js:167`) is an **assignment**, not a latch:

```js
discardedUnsaved = discards && phase === 'signed-in' && store.syncStatus().state === 'pending';
```

`accountView` performs a **second** resolve unless the reason is exactly `'signed_out_elsewhere'`
(`account.js:685-687`); that second resolve re-enters `enterSignedOut` and **clears the flag** (`account.js:249-251`),
and also rewrites the reason from `'expired'` to `'signed_out'`. So the notice is not painted. And **`discardedUnsaved`
appears in no file under `tools/`**: the browser suite asserts the rendered notice on the two *sign-out* branches and
contains **no expiry scenario at all** — no synthetic 401, no `signed_out_elsewhere`.

**Found by the independent fence review (its F-B), not by this re-execution**, and recorded here because it is the
clearest instance in the tree of the defect this document exists to name: **the code is conditional and the check is
unconditional — or, here, absent.**

### 4.4 The writing-surface discrimination leg was **vacuous on a Windows checkout**

CI's `Offline baseline (windows-latest)` job failed on PR #75 on exactly the check that exists to prove the suite can
fail: `the restore block exists exactly once` and `the leave-and-return check must catch a surface that cannot restore`.
Cause: `tools/writing-surface-check.test.mjs` read the module as raw bytes and matched an **LF** constant against it,
while git writes **CRLF** on a Windows checkout (`core.autocrlf=true` on this host). `String.replace` matched
**nothing**, so the "mutant" the suite ran against was the unmodified module. The leg passed for the wrong reason on
Linux and could not run at all on Windows.

Proved on this host before fixing, and fixed in **`fc02cc2`** on `codex/writing-surface-01b` (PR #75):

```
module on disk has CRLF: true
OLD (literal replace on the raw file) mutated anything: false
NEW (toLf, then replace) mutated something:            true
```

The fix normalises line endings before matching **and asserts the mutation actually happened**, failing with that
message if it did not. `node --test tools/writing-surface-check.test.mjs` → **10 pass, 0 fail** on this CRLF
checkout, with the mutant failing only `enter-restores-the-saved-text-on-return`.

---

## 5. The limitation, stated in the words the merge decision should quote

> **This head was re-executed, not re-reviewed.** Every suite CI runs passed at `e126d8c`, on a fresh disposable
> PostgreSQL and in headless Chrome, including the discrimination legs that make the checks capable of failing — with
> the exception of the four defects recorded in §4, one of which (`§4.1`) is a production behaviour and not a
> reporting one. **The checkers remain the work of the same authors as the code they check**, so this document
> establishes what the software *does* and not that the checks *ask the right question*. Two of the four reviews in
> this programme looked at an artefact written by its own author and found five defects that the author's own checks
> had passed. **Nothing here should be read as a merge approval**, and `main` remains at `4f76b94`.

Consequences that follow, stated so they cannot be discovered later:

- **`§4.1` blocks the claim that "hard delete" is delivered.** It is dispatched (`DELETION-WIRE-01`) and must be
  re-executed through `tools/coord-deletion-mount-probe.mjs` (PR #76) before that claim is made again.
- **`§4.2` is a false statement in a CI log.** Cheap to fix; until it is, a reader of the `postgres` job is told the
  opposite of what happened.
- **`§4.3` is an open product defect** (`N-2` recurring) dispatched as `SESSION-FENCE-02` together with two HIGH
  findings of the same review.
- **A 390 px emulated viewport is not a phone**, and the human gates `E-01`, `C-04`, `C-06`, `P-03`/`X-01` and
  real-device evidence remain open.
- **Issue #63 is not a production-security approval.** S5 — production authentication — is still the synthetic
  session port, with no `Secure` cookie, no rotation, no recovery and no abuse controls, **and there is no design for
  it.** That is Ron's decision, not an agent's.

---

## 6. What is running against this head, and where its output goes

| Reviewer / worker | Slice | Output |
|---|---|---|
| Hermes `review-deletion-e126d8c` | `server/owned-api.mjs`, `server/owned-postgres/adapter.mjs`, `tools/deletion-check.mjs` | `reports/review-deletion-e126d8c/` — **received**: 12 findings, F1–F3 HIGH, corroborating §4.1 and adding F2 (no provisioned role) |
| Hermes `review-fence-e126d8c` | `public/js/store.js`, `account.js`, `app.js`, `exam.js`, `mock-outcome.js` and both session-boundary checkers | `reports/review-fence-e126d8c/` — **received**: F-A HIGH (the mock late writer crosses into the next account), F-C HIGH (a never-signed-in browser is permanently locked out of its own record), F-B MEDIUM (N-2 recurring), F-H MEDIUM (five records that cannot fail for the property they name) |
| Hermes `review-head-e126d8c` | the **combined head**: `server.js`, `server/accounts.mjs`, `public/js/app.js`, and the finding-by-finding reconciliation of all four earlier reviews | `reports/review-head-e126d8c/` — **in progress** |
| OpenClaw `SESSION-FENCE-02` | fixes F-A, F-C and F-B | `codex/session-fence-02` |
| OpenClaw `DELETION-WIRE-01` | fixes F1–F12 of the deletion review, including §4.1 | `codex/deletion-wire-01` |
| OpenClaw `WRITING-SURFACE-01B` | objective item 3, delivered | `codex/writing-surface-01b`, **PR #75** — CI green except the Windows leg of §4.4, now fixed |

---

## 7. The integration decision, restated with this evidence in hand

`REVIEW-COVERAGE.md` said: **not merged, and not proposed for merge until the two unreviewed safety slices have an
independent reader.** That condition is now **met** — both were read independently, and between them they found
**four HIGH and three MEDIUM defects in slices that had passed every check.**

**So the answer to the merge question is still no, and for a better reason than before: the independent reviews did
their job.** The head is not ready to propose for merge until:

1. **`§4.1` is fixed and re-executed** — hard delete is unreachable from a hosted install;
   **✅ DONE, 2026-10-01.** `codex/deletion-wire-01` @ `77cca13`; re-executed by this document's own probe against a
   fresh provisioned database: **`DELETE /api/v1/account → 200 deleted:true`**, the cookie refused afterwards
   (`401`), `verifiedAbsent: true`. See §4.1's *"FIXED AND RE-VERIFIED"* block.
2. **the deletion review's F1–F3 are closed**, including a provisioned deletion role, without which the fix to (1)
   produces a `500`;
   **✅ F1 and F2 DONE and re-executed** — migration `0005-account-deletion` is applied, `hatoove_deletion` exists
   with `rolsuper=f, rolbypassrls=f`, and the deletion ran through it. **F3 is closed on the branch by dropping the
   mode that passed for the wrong reason** (`01b5316`) rather than by making it pass — the honest resolution
   §4.3 of the deletion review allowed. The branch's own re-run of `deletion-check` belongs to its record, and the
   reviewer's F5/F6/F7/F8/F9/F10/F11/F12 landed in `4810ad1`, `8bf629b`, `01b5316` and `77cca13`.
3. **the fence review's F-A and F-C are closed** — one is a cross-account text leak, the other takes away the local
   record of a learner who never signed in;
   **◐ PARTIAL.** **F-C is done** and **F-B with it**, on `codex/session-fence-02` @ `2633ffe` — and that run
   **honestly left its record's Status at `working`** rather than claiming the slice. **F-A is not started**: the run
   died at turn 112 on the third of three findings, and `public/js/exam.js` and `public/js/mock-outcome.js` are
   untouched on that branch. **Dispatched as `SESSION-FENCE-03`**, based on `2633ffe` so the two findings travel
   with it.
4. **`§4.3` (N-2 recurring) is closed**, with a test on the expiry branch at last;
   **✅ DONE on `codex/session-fence-02`** — `discardedUnsaved` is now a **latch** (`||=`) rather than a recomputed
   assignment, and the expiry reason is no longer downgraded to `signed_out` by the Konto view's own second resolve.
   The record must still show a test on the expiry branch, which is part of that branch's deliverable.
5. **the combined head is re-reviewed or freshly re-executed after those fixes**, because every fix moves the head
   and this document is pinned to `e126d8c`.
   **⏳ NOT YET.** Four branches now move the head — `deletion-wire-01`, `session-fence-02`, `session-fence-03` and
   `writing-surface-01b` — and **condition 5 is the reconciliation step that was item 1 of this whole objective, so it
   must be done again on the head that actually gets proposed.** Do not read this document's green
   results as covering a head it was not run against.

**The merge to `main` remains deliberately undone and is Ron's call**, as is S5 (production authentication). Nothing
in this document authorises a merge, and `main` is still `4f76b94`.

---

## 8. ADDENDUM — the combined-head re-review landed, and it agrees where it matters

The third reader's report and its finding-by-finding table were received while this document was being written.
They are `reports/review-head-e126d8c/report.md` and `reconciliation.md`, and they are **copied into this
repository** beside this file so that the evidence travels with the merge it justifies. Three things about its
outcome belong in the merge record.

### 8.1 It reproduced this document's coverage map and corrected two of my expectations

- **All four counts in `REVIEW-COVERAGE.md` reproduce exactly** — 60/35, 54/34, 47/38, 42/37 commits and files
  behind. The map is accurate.
- **All four reviewed heads *are* objects in the bundle.** I had told the reviewer to report it if they were not,
  expecting they might not be. They are, and the reviewer therefore **re-derived** each review's claim where it
  could be re-derived instead of inheriting it. **The programme's evidence is stronger than I recorded**, and the
  record should say so.
- **`REVIEW-COVERAGE.md` was absent from the candidate.** It existed only on `codex/review-coverage`, so the
  document that justifies the integration decision would not have travelled with the merge it justifies. **Fixed by
  this branch**: it is now on `codex/coord-verify-e126d8c`, which merges into the candidate.

### 8.2 Its reconciliation is the finding-by-finding answer this item asked for

**37 findings, one bucket each: 22 closed-and-still-closed, 1 closed-but-at-risk, 5 known-good by CI re-execution,
9 not covered.** The single item that moved into *at risk* is the claim that **the CSRF/origin gate is
byte-identical to `main`** — it was true at `90d9860` and is **not** true at the head, because `93c9b73` added the
hosted branch and `8f3bf97` rewrote its admission rule. The reviewer re-derived the property rather than accepting
the transfer. **That is exactly why the item was on the list**, and it is the second time in this programme that a
claim which was true when written stopped being true without anyone noticing.

The reviewer's bucketing also states the caveat I would have had to add myself, and states it better: `on every
push` is **not** literally true for this branch, because `ci.yml` triggers on `pull_request` and on pushes to
`main` only. Every "known-good by CI" row therefore means *the check exists, is wired to a job, and that job runs on
a PR against this head* — **not** *a green run was observed*. It also verified both halves of the CI change by
reading the YAML (the workflow parses; every `node tools/…` step is wired to a job whose file exists), which is the
rule this programme paid two cycles for.

### 8.3 Five findings of its own, and two of them change the list of what blocks a merge

| # | Sev | Finding | Effect |
|---|---|---|---|
| **X-A** | **HIGH** | **The shipped runtime never wires the account-deletion port** — the same defect this document found by execution (§4.1). The reviewer reached it from the wiring it owns, and added the two halves this document missed: **`provision.mjs` creates no deletion role either**, and both source comments that record the deferral cite `HARD-DELETE-01.md` **§6, which does not exist**. | **Independent corroboration of §4.1**, from reading rather than execution. Both halves are in the `DELETION-WIRE-01` dispatch |
| **X-B** | low | **The F3 fix over-refuses, and disables a documented fallback.** `Origin: https://<configured>/` (trailing slash) and **any `Referer` carrying a path** are now **refused**, where the earlier review recorded both as **accepted**. So `server.js:298-301`'s *"we fall back to Referer"* is **dead for every value a browser can send**. The blast radius is a proxy that strips `Origin`; no checker covers it | **Not a security defect — it fails closed.** But it is a control doing something different from what its own comment says, which is the class this programme treats as a defect. **Recorded as open, not dispatched** |
| **X-C** | medium | `REVIEW-COVERAGE.md` was absent from the candidate | **Closed by this branch** (§8.1) |
| **X-D** | low | Two live SHA citations in the tree are not objects in the bundle (`72994ad(444b3cdd…)`, `ef888ff`), from an audit of all 123 SHA-like strings in the records. **Caveat stated exactly as the reviewer stated it:** absent from *that bundle*, which is not proof of absence from the repository | Recorded. Same class as the two *declared-dead* citations |
| **X-E** | info/low | **`/api/ready` ignores the origin configuration:** with `B1PREP_SAAS=1`, accounts loaded and `B1PREP_PUBLIC_ORIGIN` unset, it answers **200 `{ready:true, mode:'saas'}`** while the origin gate refuses **every** non-GET — **including sign-in**. Disclosed in the startup banner only, invisible to a supervisor | **A readiness surface that says ready while refusing service.** Recorded as open |

### 8.4 The merge conditions, restated with §8 included

The five conditions in §7 stand, with two additions:

6. **`X-B` is closed or explicitly accepted**: a control whose comment describes a fallback that its own regex has
   made unreachable is the defect shape this programme keeps finding, even when the failure direction is safe.
7. **`X-E` is closed or explicitly accepted**: `/api/ready` must not report `ready:true` in the configuration where
   every mutating route, including sign-in, is refused.

**And one process condition, which is the only one that is about this programme rather than about the product:**
`REVIEW-COVERAGE.md` and this document live on `codex/coord-verify-e126d8c` and **must reach `main` with the
candidate**. An integration decision that does not travel with the merge it justifies is the defect that item
`X-C` records, and it is the reason item 1 of this whole objective was uncomfortable in the first place.
