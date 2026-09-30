# F5-RESCOPE — what deletion means for the hosted service, and what is left of F-5

| | |
|---|---|
| Task / execution | F5-RESCOPE / `f5-rescope-hermes-20261001-a` |
| Worker | Hermes (Docker container `hermes-agent`), local to this checkout |
| Coordinator | `COORD-TAKEOVER-20260930` |
| Branch | `codex/f5-rescope` |
| **Base used** | **`origin/codex/ownapi-03-persistent` @ `3e0a2a811f2199bcf72565edc68634225bb7daa7`** |
| Why that base | The brief says `origin/main` after PR #60 merges, else `origin/codex/ownapi-03-persistent`. Verified with `git merge-base --is-ancestor origin/codex/ownapi-03-persistent origin/main` → **not an ancestor**, so **PR #60 is not merged** and the brief's fallback base is the right one. `git ls-remote` against the delivered bundle reports exactly the three refs the dispatch names (`main` `4f76b94`, `ownapi-03-persistent` `3e0a2a8`, `f5-deletion-01` `d3117ec`), so the base was reachable and identifiable. |
| Reviews | **PR #59 (`codex/f5-deletion-01` @ `d3117ec`) — not merged, not adopted.** This document is the re-decision the dispatch asks for. |
| Status | Re-scope complete. Part 2 implemented: the delete path reports what it removed and states what it cannot reach, with a discriminating checker. Nothing that depends on the retention policy was built. `P-03` remains a human gate. |

Line references are to the base commit `3e0a2a8`. Nothing here is an opinion about the code's
quality; every claim below is read out of the tree at that SHA.

---

## Part 1 — the re-scope

### 1.1 How many places can hold learner data, and does a delete reach them today

"Today" = the tree at the base, `node server.js` as it ships, no code change. Every row was
checked against the code, not against a design document.

| # | Where learner data can live | Holds learner text? | Written by | Does any delete reach it today? |
|---|---|---|---|---|
| 1 | `progress.json` (`$B1PREP_PROGRESS_FILE`, default `<root>/progress.json`) | **Yes** — attempts, history, notebook `prompt`/`yourAnswer`, ability model, settings | `server.js` `writeProgress` (POST `/api/progress`), L312–324 | **Yes.** `DELETE /api/progress?scope=all`, L647–652 |
| 2 | `progress.json.bak` | **Yes** — the previous generation of the same record | `server.js` `writeProgress`, the `copyFile` at L318 | **Yes** (L649) |
| 3 | `progress.json.tmp` | **Yes** — a whole in-flight record | `writeProgress` L315 / `writeProgressScoped` L338 | **Yes** (L652) — otherwise the next save would rename it into place and resurrect the record |
| 4 | `progress.json.<accountId>` + its `.bak` / `.tmp` (F-4 account scope) | **Yes** | `server.js` `accountPaths` (L74) | **Partly.** Reached only when the caller names the account (`X-B1Prep-Account`). A scoped delete deliberately does **not** touch the legacy unscoped record, and a legacy delete does **not** touch any account's record |
| 5 | `progress.json.rev`, `.rev.tmp` | **No** — `{rev, deletedThrough}` only | `server.js` `writeRevision` L359–363 | **No, on purpose.** It is the fence that refuses a save queued before the delete (SEC-05). Keeping it is what makes the delete hold |
| 6 | `progress.json.pre-recovery` | **Yes** — a full copy | `tools/recover-progress.js` | **No** |
| 7 | `progress.json.before-ssd-sync-<id>.bak` | **Yes** — a full copy | `tools/sync-home.js` | **No** |
| 8 | `.env` (`$B1PREP_ENV_FILE`) | No learner text: provider key, model, base URL, exam date, port | `server.js` `saveEnv`, POST `/api/config` | **No, by design** — configuration, not progress |
| 9 | `localStorage['b1prep.state.v1']` and the `::<accountId>` namespaces | **Yes** — the same record | `public/js/store.js` | Not by the server: the client clears its own copy in `resetAll()` (store.js L644–683). Nothing in the server can reach a browser |
| 10 | `localStorage['certa-theme']` | No — a preference | `public/js/app.js` | Kept, deliberately |
| 11 | Owned tables: `attempts`, `drafts`, `submissions`, `assessments`, `usage_ledger` (+ `jobs`, `entitlements`) | **Yes**: `drafts.text`, `submissions.text`, `assessments.feedback` are the learner's writing (`spikes/auth-runtime/schema.sql` L8–11, L19–26, L37–46) | `server/owned-api.mjs` over `server/owned-postgres/adapter.mjs` | **Partly, and only per attempt.** `DELETE /api/v1/attempts/:id` → `adapter.remove()` (L187–202) **soft-deletes** the attempt (`UPDATE attempts SET deleted_at = now()`), deletes the draft row, and **leaves the submission, its job, its assessment and its usage_ledger row in place**. There is **no account-deletion route at all**: `owned-api.mjs` routes are `/api/auth/*`, `GET /api/v1/account`, `/api/v1/attempts*`, `/api/v1/submissions*`, `/api/v1/settings` — no `DELETE` on the account (L260–305) |
| 12 | `learner_settings` (account settings: exam date, daily goal, model, theme, language) | No learner text, but it is account data | `server/owned-postgres/settings.mjs`, `read`/`write` only | **No.** The port has no delete, and no route calls one |
| 13 | Auth tables `"user"`, `"account"` (password hash), `"session"`, `"verification"` | Email, credential hash, live session tokens — not learner text, but not nothing | `server/owned-postgres/sessions.mjs` | **No account deletion.** `signOut` (L150–154) deletes only the presented token's row; every other live session of the same account survives. No expiry sweep exists |
| 14 | Server logs | None: the app writes **no** log file. `server.js` only `console.log`s the startup banner (L850–868); a grep for `appendFile`/`createWriteStream` finds nothing | — | Nothing to reach. A host that captures stdout is outside the app |
| 15 | Backups | — the app creates none and documents none. A hosted deployment's database snapshots and host backups are outside the app entirely | — | **No, and cannot be** |
| 16 | Removable media (portable build) | key **and** record | `tools/build-portable.ps1`, `tools/verify-portable.js` | **No** — and **dropped** by the SaaS conversion (§1.3) |

**The honest answer.** What the app calls "delete everything" is a **local-file delete of one
record for one scope**. It reaches exactly three files the server itself writes (rows 1–3) and,
for a caller that names an account, the same three in that account's namespace (row 4). It does
**not** reach:

* the two copies beside the record that no delete has ever touched (rows 6–7) — and both are
  produced only by tools the SaaS target **drops**;
* the browser's copy of the same record (row 9);
* **any part of the hosted store** — the learner's own writing in `drafts`/`submissions`/
  `assessments`, the account's settings, its sessions (rows 11–13);
* **any backup at all** (row 15).

So the gap the SaaS target actually has is not "backup copies of the progress file". It is that
**the deletion path does not know about the hosted store, and the hosted store has no deletion
path**: `DELETE /api/progress` is the only delete in the product and it deletes a JSON file.

### 1.2 What survives the SaaS target

Ron, 2026-10-01, recorded in `SAAS-CONVERSION.md` §1.3: sync, export/import, the portable build
and the copies of the key on removable media, learner-writable provider configuration, and
"pre-recovery / `.bak` copies beside the install" are **dropped**, because *"there is now one
authoritative server copy that every signed-in device reads"* — and, for the shipped app,
*"no install directory once the app is served"*.

**Obsolete — do not build on it**

| F-5 / PR #59 element | Why it is obsolete |
|---|---|
| The removable-media half of F-5 (the key and the record copied onto a USB device) | §1.3: the portable build is dropped; there is no media. PR #59's `DELETION-NOTICE.txt` in `tools/build-portable.ps1` and its assertion in `tools/verify-portable.js` describe a technique the product no longer has |
| Deleting `progress.json.before-ssd-sync-*.bak` | Produced only by `tools/sync-home.js`, dropped. Dead code against the target |
| Deleting `progress.json.pre-recovery` | Produced only by `tools/recover-progress.js`, dropped with export/import. Dead code against the target |
| `outsideScope` text naming the portable build and a browser download | Names two dropped mechanisms; and the download was the dropped export |
| "copies of the key on removable media" as a deletion-scope problem | §1.3 makes the provider key operator-owned configuration; a learner never holds it, so there is no learner-side key copy to delete |

**More important in a hosted service — do not drop it with the local app**

1. **The honesty property itself.** SEC-02 put it exactly right about the merged check
   (`SEC-02.md` L92–94): *"This is deliberate and is asserted by the `backup-copies-outside-deletion-path`
   check rather than implied away: **deletion is not total**, and saying so is part of the fix."*
   A hosted deployment has **more** stores than a local install, not fewer — database snapshots,
   the owned tables, sessions, host logs. The property is worth more now than when it was written.
2. **The delete response must state its boundary.** `{deleted: true}` alone reads as "everything is
   gone". A service that has backups cannot say that. This is the one part of PR #59 whose shape
   survives the target — with its text re-pointed at the hosted stores instead of at media.
3. **Deletion is per account, and must stay so.** With F-4's namespacing in place (row 4),
   "delete everything" is already scoped to one account's record; in a multi-tenant service that
   scoping is a correctness requirement, not a nicety.
4. **The hosted store's deletion path is the real F-5.** Rows 11–13: an account's own writing
   (drafts, submissions, assessments), its settings and its sessions have no deletion path, and
   `DELETE /api/v1/attempts/:id` leaves the immutable submission snapshot and the assessment
   behind. This is where F-5 becomes *more* important, and it is **blocked on Ron's policy**
   (Part 1.4).
5. **The `.rev` tombstone must not be swept up.** It is the one file the delete keeps (row 5) and
   it is load-bearing. A future "delete the whole directory" step would reintroduce the F-2 race.

### 1.3 The `reset-check` assertion — recommendation

**Recommendation: keep the merged semantics, unchanged. Do not adopt PR #59's reversal on this
branch.** `tools/reset-check.mjs` is therefore **not touched** by this slice, and the baseline
stays at **9** checks.

The merged check (`reset-check.mjs` L512–521) writes `progress.json.pre-recovery`, runs the
user-visible delete, and asserts the copy is **still there** — "the pre-recovery copy must be
untouched (this is the documented boundary)". PR #59 renames it to
`app-created-copies-removed-by-full-delete` and inverts the assertion.

Reasoning:

1. **The reversal buys deletion of a file the retained product never creates.** The only writer of
   `.pre-recovery` is `tools/recover-progress.js`, which §1.3 drops. Inverting the assertion makes
   the server delete a path that, in the SaaS target, cannot exist. That is not a guarantee; it is
   dead code with a test attached. The same is true of the `.before-ssd-sync-*.bak` half.
2. **The reversal is not wrong, it is untargeted — and it trades away the property that matters more
   now.** The merged check's real content is not "a file survives"; it is *"deletion is not total,
   and the app says so instead of implying otherwise"*. PR #59 replaces that with a narrower claim
   ("the app deletes the copies it created locally") at exactly the moment the app stops being
   single-user and local. Under SaaS the copies that survive are the hosted ones (rows 11–15) — a
   strictly larger set — so the assertion should be re-pointed, not narrowed.
3. **The reversal was flagged by its own author as needing approval, and it reverses a merged
   semantic.** Inheriting it because the base moved is precisely what the dispatch forbids.
4. **Its premise is a condition that has not happened.** PR #59 argues the baseline "could not stay
   at 9" because the fix removes the boundary. That is only true *if* the server deletes
   `.pre-recovery`. It does not here, so there is no contradiction to resolve and no reason to
   rewrite the assertion. The check stays true and the baseline stays 9.

**What the merged check still guarantees, stated plainly:** the app's delete **removes exactly the
files the server itself writes beside the record** — the record, its one-generation backup, and a
leftover temp file — and it **does not silently claim to have removed anything else**. A copy the
app's delete path does not create is not touched, and that boundary is asserted rather than implied
away. This slice keeps that guarantee *and*, separately, makes the delete **say** where its reach
ends (Part 2) — so the boundary is now asserted in two places instead of one.

**Follow-up for the coordinator, not for this slice:** when the dropped tools are actually deleted
from the tree (`SAAS-CONVERSION.md` §3 step 8 — "confirm the dropped list is actually absent"),
this check must be deleted **with** `tools/recover-progress.js`, because then the boundary it
records can no longer occur. That takes `reset-check` from 9 to 8. That is a deliberate, visible
change to a merged count and belongs to the step-8 slice, not to a re-scope performed while the
file still exists. **It is not done here, and the count is not changed here.**

### 1.4 What cannot be decided by an agent

Account-deletion retention policy is a product and legal decision for Ron. It is not derivable from
the code, and inventing it would be the defect this programme keeps finding. The following are
**blocked** and deliberately **not implemented**:

1. **What an account deletion must remove.** Hard-delete or anonymise? The learner's writing lives
   in `submissions.text` and `assessments.feedback`, and `submissions` carry an immutability trigger
   (`spikes/auth-runtime/schema.sql` L28–30): deleting them is allowed, rewriting them is not. Whether
   a deletion request means *remove these rows* or *detach them from the owner* is a policy call with
   a retention consequence either way.
2. **What may be kept, and for how long.** `usage_ledger` (billing), `assessments` (a disputed
   grade), `entitlements`, and the auth rows are plausible retention candidates with different
   owners (finance, product, legal). No agent may pick a number.
3. **Backups and point-in-time recovery.** Whether deletion must be propagated into database
   snapshots, and within what window, is a hosting/legal decision. Until it is answered, **no delete
   can honestly claim to be complete on a hosted service**, and none of my wording claims it.
4. **Logs.** The app writes none, but a host will capture stdout. Whether that is learner data and
   how long it lives is the same policy question.
5. **Sessions and credentials.** Whether account deletion revokes all sessions immediately
   (it does not today: `signOut` deletes one token row) and whether `"user"`/`"account"` rows are
   deleted or tombstoned.
6. **The legacy `progress.json` on a hosted deployment.** Whether the legacy record is migrated,
   deleted, or left unreachable once accounts are mounted (`A-01 MOUNT` explicitly does not migrate
   it today).
7. **A data-portability right.** §1.3 drops export as a *mechanism*, and states that if `P-03`
   requires a portability right it needs its own specification. Not mine to write.
8. **Whether a delete must reach a copy the app's own delete path does not create.** Today the
   shipped tree still contains `tools/recover-progress.js` (dropped by §1.3, not yet deleted), so a
   copy it wrote earlier can still sit beside the record, and the merged boundary asserts that the
   delete leaves it. That copy holds learner text. Whether a deletion request must reach it is part
   of "what must be removed" (item 1) and is **not decided here**: this slice keeps the merged
   assertion and, instead of deleting the copy, makes the delete **state** that it survives
   (Part 2, statement 3 of `outsideScope`). Deleting it would be reversing a merged semantic for a
   surface that is itself being removed.

Consequently, **not built in this slice**: any account-deletion route, any retention or purge job,
any change to what `.rev` keeps, any hard-delete of `submissions`/`assessments`, and any change to
the `.pre-recovery`/sync-copy boundary. Also not built: anything in the dropped surfaces.

---

## Part 2 — what was implemented, and why it is unblocked

The re-scope leaves one thing that is both inside F-5's surviving substance and independent of the
retention policy: **the delete path must be honest.** It must delete what it claims, and it must
state what it cannot reach. Neither half needs a policy decision — the reach is a fact of the code.

**`server.js`** — `DELETE /api/progress?scope=all`:

* the three candidates are now enumerated per request and each is **checked before removal**, so the
  response can name exactly what it removed instead of asserting success;
* a removal that **throws** is no longer swallowed. `deleted: true` is not returned when a copy the
  app claims to have deleted is still there: the response becomes `500`
  `{ok: false, code: 'delete_incomplete', deleted: false, removed, failed, outsideScope}`;
* the success response carries **`removed`** (the file names it actually deleted) and
  **`outsideScope`** — a list of statements naming what this endpoint cannot reach. The statements
  are derived from the request's own paths (they name the actual record and fence file) and are
  about **reach**, never about duration: no retention claim is made anywhere;
* the statements name the **browser cache**, a copy **another tool** left beside the record, and the
  **hosted stores** — a backup of the server or database, and the records the server keeps in the
  owned account database. They deliberately do **not** name the portable build, the removable media
  or a browser export: those are dropped (§1.3), and stating an obsolete boundary would be its own
  kind of dishonesty;
* the `.rev` tombstone is still kept on purpose, and the response now says so.

Nothing else in `server.js` changed: the merge-on-save guard, the revision fence, the F-4 account
scoping and the `scope=errors` path are byte-for-byte as they were.

**`tools/deletion-scope-check.mjs` + `tools/deletion-scope-check.test.mjs`** — the proof. It creates
the copies with the real processes first (two real saves make the `.bak`; the `.tmp` is written in
the exact shape the server writes it), runs the real user-visible delete through the real client
module, and asserts file by file. It also materialises the **pre-fix tree from git**, compares
`server.js` **byte-for-byte by sha256**, and runs the same probe there to show it discriminates.

---

## Acceptance checks — actual output

Run on this host, 2026-10-01, in the checkout of branch `codex/f5-rescope` (base `3e0a2a8`), all
`.mjs` run from a file, synthetic data only, no database, no provider call.

**Regression baseline — every count unchanged from the recorded baseline**

| Suite | Expected | Actual |
|---|---|---|
| `node tools/check.js` | 101 | **101 passed, 0 failed** |
| `node tools/writing-check.js` | 9 | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | 14 | **14 passed, 0 failed** |
| `node tools/reset-check.mjs` | 9 | **OK 9 check(s) passed** (`backup-copies-outside-deletion-path` unchanged) |
| `node tools/revision-check.mjs` | 8 | **OK 8 check(s) passed**, including discrimination |
| `node tools/server-origin-check.mjs` | 16 | **OK 16 check(s) passed** |
| `node tools/keymask-check.mjs` | 12 | **OK 12 check(s) passed** |
| `node tools/progress-equal-check.mjs` | 10 | **OK 10 check(s) passed**, including discrimination |
| `node tools/progress-scope-check.mjs` | 7 | **OK 7 check(s) passed**, including discrimination |
| `node tools/repository-check.mjs` | passed | **passed — 310 tracked files; 239 text blobs screened** (was 307/236 at the base: the three new files) |

**New checker — `node tools/deletion-scope-check.mjs` → 10/10**

```
  tree @ /opt/data/workspaces/f5-rescope/repo
  PASS  app-created-copies-exist-before-the-delete  [created first: progress.json, progress.json.bak, progress.json.tmp, progress.json.pre-recovery]
  PASS  delete-removes-the-record-and-its-own-copies  [record, one-generation backup and leftover temp removed; no text left behind]
  PASS  delete-leaves-a-copy-another-tool-wrote  [progress.json.pre-recovery survived, as the merged reset-check boundary asserts]
  PASS  delete-reports-exactly-the-files-it-removed  [removed exactly: progress.json, progress.json.bak, progress.json.tmp]
  PASS  delete-states-what-it-cannot-reach  [4 boundary statement(s), including backups and the browser copy]
  PASS  delete-keeps-the-write-fence-and-it-holds-no-learner-text  [fence kept: rev 12, deletedThrough 12; no learner text]
  PASS  get-reports-no-record-after-the-delete  [GET reports found:false]
  PASS  delete-reaches-only-the-named-account  [removed A's record only; B's record and the legacy record intact]
  PASS  an-unremovable-copy-is-reported-not-claimed  [reported 500 delete_incomplete; failed: progress.json.bak]
  PASS  probe-discriminates-on-prefix-tree  [pre-fix ee25d5c40611 fails 3 honesty check(s) and passes all 6 control(s)]
  OK    10 check(s) passed, including discrimination against the pre-fix tree.
```

**Discrimination — the same probe, pre-fix tree materialised from git**

`node tools/deletion-scope-check.mjs` materialises `server.js`, `public/js/store.js`,
`public/js/progress-merge.js` and `public/js/blueprint.js` from `git show 3e0a2a8:<path>` into a temp
directory and asserts the pre-fix `server.js` sha256 **before it trusts the comparison**:

* recorded: `PREFIX_SERVER_SHA256 = ee25d5c40611b3a88d85b500af1609c151a3764786e8b31b97ee3efae9fb3a7e`
* printed by the run: `pre-fix server.js sha256 ee25d5c40611b3a88d85b500af1609c151a3764786e8b31b97ee3efae9fb3a7e`
  (and `git show 3e0a2a811f2199bcf72565edc68634225bb7daa7:server.js | sha256sum` gives the same value
  for the pre-fix blob; `git diff` confirms the two trees' `server.js` differ)

```
  BEFORE/AFTER - same probe, pre-fix tree
  PASS  app-created-copies-exist-before-the-delete
  PASS  delete-removes-the-record-and-its-own-copies
  PASS  delete-leaves-a-copy-another-tool-wrote
  FAIL  delete-reports-exactly-the-files-it-removed  [the removed list must be exactly the files this server writes: expected ["progress.json","progress.json.bak","progress.json.tmp"], got []]
  FAIL  delete-states-what-it-cannot-reach  [the delete must return an outsideScope list, not only deleted:true]
  PASS  delete-keeps-the-write-fence-and-it-holds-no-learner-text
  PASS  get-reports-no-record-after-the-delete
  PASS  delete-reaches-only-the-named-account
  FAIL  an-unremovable-copy-is-reported-not-claimed  [an incomplete delete must not report success: expected 500, got 200]
```

The pre-fix tree fails **exactly the three honesty checks** and passes **all six controls** — so the
probe discriminates the fix rather than failing wholesale. The in-suite
`probe-discriminates-on-prefix-tree` check enforces that shape: it refuses to pass if the pre-fix
tree starts passing an honesty check, or if a control stops passing there.

**Test wrapper — `node --test tools/deletion-scope-check.test.mjs` → 12 tests, 12 pass, 0 fail, 0 skipped**

**Repository gates**

* `git diff --cached --check` → clean (no output).
* `git merge-base --is-ancestor origin/codex/ownapi-03-persistent HEAD` → yes, verified before commit.
* LF verified: `grep -c $'\r'` returns **0** for every changed file.
* Changed paths: `server.js` (M), `tools/deletion-scope-check.mjs` (A),
  `tools/deletion-scope-check.test.mjs` (A), `work/implementation/F5-RESCOPE.md` (A).
  `tools/reset-check.mjs` is **not** among them — see §1.3.

## What this document does not do

It closes no privacy, security or legal gate. `P-03` remains a human gate. It creates no retention
policy and no account-deletion path. It does not delete the dropped tools, and it does not change
any merged count.
