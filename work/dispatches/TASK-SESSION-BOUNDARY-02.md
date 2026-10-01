# SESSION-BOUNDARY-02 — the three defects the independent review found

Worker: **Claude**. Execution id: `session-boundary-02-claude-20261001-a`.
Coordinator: `COORD-TAKEOVER-20260930`. Issued 2026-10-01. **Checkpoint 30 minutes · Expires 180 minutes.**

## Base

**`origin/codex/session-boundary-01` @ `521e383`** — your own branch from the previous slice. Record the SHA.

## What the independent review found

`session-boundary-review-hermes-20261001-a` attacked your work at `521e383`. Its verdict, in its own words:

> The two load-bearing properties of S4 — **ordering** (identity before learner data) and **progress fencing** (a
> late `/api/progress` answer after sign-out or a switch does not land) — **hold, and survive deliberate attack**,
> including the case the worker's own check does not cover (a cached account record on disk with the identity call
> held open).

That is the hard part, and it held. But it found **three defects**, and two are HIGH. **They are this task.** The
report is at `C:\Users\ronon\.codex\hatoove-handoff\ron-agent\reports\session-boundary-review-hermes-20261001-a\`
and is quoted here in enough detail that you do not need it — but read it if you can, because its reasoning is
better than a summary of it.

### F1 — HIGH · "sign-out clears private state" is **conditional**, and the untested branch leaks plaintext

`store.clearAccountScope({ forget: flushed })` at `public/js/account.js:252`, where `flushed` is true **only if the
last save reached the server within 4 s** (`account.js:243-249`). With `forget: false`, the account's namespaced
record — **notebook prompts, answers, history, ability nodes and settings** — stays as **plaintext in
`localStorage` under `b1prep.state.v1::<accountId>`**.

Reproduced twice by the reviewer, both ordinary situations:

- **offline sign-out** → *"signing out while offline leaves the account plaintext in localStorage"*;
- **the final save held past the 4 s budget** → plaintext survives sign-out, **and is still there after the held
  answer finally lands**.

**The sharpest part of the finding is the mismatch, not the bug:** `tools/session-boundary-browser-check.mjs:372`
asserts `sign-out-leaves-no-account-text-in-storage` **unconditionally**, and the property is true **only on the
branch that check happens to exercise** (server up, save confirms in time). The confirmed branch genuinely works —
the reviewer verified it and its mutant fails exactly that check. **So the defect is that the property is
conditional in the code and unconditional in the check and the acceptance claim.**

**Required:** on sign-out, account switch **and** expiry, the previous account's record must not remain readable
**regardless of whether the final save succeeded**. The learner must be told the truth about a save that did not
reach the server — but **not by keeping their plaintext on disk indefinitely**. Choose deliberately between
discarding it, or keeping it in a form that is not the account's readable plaintext, and **say which and why**. If
you keep anything, the browser check must assert the property for the **offline** and **held-save** branches too,
not only the confirming one.

### F2 — HIGH · a late response **does** land after sign-out, through the **writing view**

The progress path is genuinely fenced. But there is a **second, unfenced writer**: `public/js/exam.js:757-786`.
After `await ai.gradeWriting({task, text, analysis})` — a real network round trip, **outside the session boundary** —
the feedback handler calls `store.recordAttempt(...)` (×5) and `store.addError(...)`, and `addError` puts the
learner's **own text** (`corr.original`) into the notebook record.

Nothing on that path consults the boundary, `client.generation` or the store's scope, and the store's mutators are
not gated on scope — `recordAttempt` and `addError` write into `state` unconditionally. Reproduced: after a real
sign-out, the late entry **lands in learner state in memory** and is what `notebookView` (which renders
`store.listErrors()`) **draws while the page is signed out**.

Bounded, and say so precisely rather than either exaggerating or hiding it: it is **not** persisted to
`localStorage` for a signed-out page, and a subsequent account does **not** inherit it. **The leak is on the page
the learner is looking at, which is exactly what the fence exists to prevent.**

**Required:** the writing path must go through the boundary like every other learner-state writer — which is also
what the S4 claim ("all API clients", "clear private state and fence late responses") already asserts. The reviewer
noted that the obvious fix (make `addError` refuse when signed out) makes its mutant fail precisely those two
checks, so **that fix is detectable** and you should aim for it.

**`public/js/exam.js` is now yours for this specific purpose.** It was off-limits in the previous slice; it is not
now. Change **only** the writing feedback path — do not restyle, refactor or re-scope the rest of the file. If the
change turns out to need more of `exam.js` than the writing path, **stop and report** rather than expanding.

### F3 — MEDIUM · the single-user path is not "exactly as before"

A new `resolve()` in the `visibilitychange` handler **re-reconciles the single-user record on every tab return** and
can replace the in-memory state mid-session. That is a real behaviour change for a local install.

**Required:** either make the reconciliation not replace in-memory state mid-session, or **correct the claim** as
the previous slice did for the runtime refusals — but note that slice's lesson: **do not weaken hardening to make a
sentence true.** If the re-reconcile is genuinely hardening, keep it and state precisely when it can change state,
rather than claiming byte-identical behaviour.

### F4 — LOW · the settings save silently stops sending `theme`

Fix it, or record why not.

### F7 — the record's base SHA is not a real object, and the required output is absent

**`work/implementation/SESSION-BOUNDARY-01.md` states a base SHA that is not an object in the repository.** This is
the **second time** a record of yours has cited an unverifiable SHA. Correct it, and **check every SHA you cite
against `git cat-file -e` before you write it down.** The record is also missing output the brief required.

## Acceptance — report ACTUAL output

1. **A check for each of F1, F2, F3** that **fails on `521e383` and passes on your head.** That is the standard
   this programme uses, and the reviewer already supplied mutants: **M3** fails the F1 check, **M7** fails the F2
   checks. Use them.
2. **F1's check must cover the offline and held-save branches**, not only the confirming one. That omission is the
   defect.
3. **Baseline unchanged**: `check.js` 101 · writing 9 · feedback 14 · server-origin 16 · keymask 12 ·
   `reset-check.mjs` **8** (deliberately reduced) · revision 8 · progress-equal 10 · owned-client 31 · owned-api 24 ·
   draft-session 18 · mock-outcome 19 · progress-scope 7 · design-check exit 0 · provider-config 11 ·
   repository-check passes. Plus your own `session-boundary-check` 6/6 and `session-boundary-browser-check` 19/19,
   **or a stated reason with evidence if a count must change.**
4. `git diff --cached --check` clean; every `.mjs` from a file; **LF, not CRLF**.

## Deliverable

- Branch `codex/session-boundary-02` from `521e383`, or continue on `codex/session-boundary-01` — say which and why.
- Allowed: `public/js/account.js`, `public/js/store.js`, `public/js/app.js`, **`public/js/exam.js` (writing feedback
  path only)**, `tools/session-boundary-check.mjs`, `tools/session-boundary-browser-check.mjs`,
  `work/implementation/SESSION-BOUNDARY-01.md` (append only).
- **Do not touch** `server.js`, `server/**`, `public/js/owned-client.js`, `.github/**`, `package.json`, other records.
- **Commit and push after F1, after F2, after F3 — separately.** This rule has saved two runs already.

## Boundaries

- **Synthetic accounts and a stubbed provider only.** No live AI call, no real credential, no real learner record.
  Never touch `D:\B1_Prep`.
- No deployment, no production access.
- **This closes no gate.** Issue #63 is explicitly not a production-security approval, and `P-03`/`X-01` stay open.
- **State plainly what you could not verify.** The reviewer could not run your two checkers (no PostgreSQL, no
  browser in its container); you can, so the database-backed evidence is yours to supply.
