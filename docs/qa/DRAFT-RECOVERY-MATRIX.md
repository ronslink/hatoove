# DRAFT-RECOVERY-MATRIX — recoverable-writing acceptance specification

Created: 2026-09-30 · Execution `user04-20260930-a` · Issue [ronslink/hatoove#16](https://github.com/ronslink/hatoove/issues/16)
Status: **test specification only — unreviewed, not executed, not a pass report**

This is a **specification of expected behaviour and how it would be observed**, derived from the current
source and contracts. It is **not** evidence that any case passes. No case is marked passed, and the
coordinator owns storage, task-identity decisions and the `exam.js` implementation — nothing here
authorises a contract change.

## Evidence classes (kept strictly separate)

| Class | Meaning |
|---|---|
| **S — existing server fixture evidence** | Exercised today by `spikes/auth-runtime/test.mjs` against the local PostgreSQL contract. Server-side only; it does **not** establish browser behaviour. |
| **U — public UI behaviour** | **Currently missing.** The browser writing surface has no persistence path, so these cases cannot pass yet. Present in `public/js/exam.js` only as an in-memory `<textarea>`. |
| **D — device evidence required** | Keyboards, tab discard and process kill on real iPhone Safari / Android Chrome. Viewport emulation cannot close these. |

## Anchors

- **Contracts:** `docs/contracts/PILOT-V0.1.md:38-61` — Draft / Submission / Job / Assessment / Entitlement /
  Usage invariants; `PILOT-V0.1.md:53` submission identity `(owner,eventId)` and fingerprint
  `(attemptId,draftRevision)`; `PILOT-V0.1.md:57` lease token, tombstone, bounded claims.
- **Server fixtures:** `spikes/auth-runtime/test.mjs` — the executable subset.
- **Browser surface:** `public/js/exam.js:655` (`#writing-text` textarea), `exam.js:679-731` (word count,
  analyse, submit), `exam.js:1394` (`#mock-writing`), `public/js/store.js` (**no writing or draft field** in
  the durable progress blob — confirming the USER-01 D1 finding that writing text is not in durable state).

---

## 1. Matrix

| # | Case | Expected invariant | Synthetic setup | Observation | Proof boundary |
|---|---|---|---|---|---|
| **R1** | Prompt and text restored after **navigation** away and back | The exact prompt identity and the learner's exact text return; no silent truncation | One attempt, one task, text with umlauts, Arabic and a newline; navigate to another view then back | Re-read prompt id/title and textarea value; byte-compare with what was typed | **U** — not implemented in the browser today. Contract asserts it server-side; UI must be wired. |
| **R2** | Same after **reload** | Text identical after a full reload, including RTL and emoji | As R1, then `Page.reload` without submitting | Compare textarea value and cursor-safe length | **U** |
| **R3** | **Account switch / sign-out** clears private text | Signing out removes the text from the browser; a second account never sees it | Account A writes, signs out, account B signs in on the same browser | Account B's writing surface is empty; A's text is not readable from B | **U** for browser clearing; **S** for ownership rejection (`test.mjs`: cross-owner PUT → 404) |
| **R4** | Two tabs with **conflicting revisions** | The stale tab cannot overwrite the newer revision; the conflict is visible, not silent | Tab A revision 2, tab B revision 2, both save | One save succeeds, the other reports a conflict; final text equals the winner | **S** — `test.mjs` proves concurrent writes resolve to one increment (revision 2→3) and that a stale `expectedRevision` is rejected. **U** for the visible conflict message. |
| **R5** | **Offline / network failure** during save | The learner keeps the text and sees a recoverable state; retry uses the same event identity | Save with the network offline, then restore | Text retained; state marked unsaved/failed; no duplicate attempt created | **U** |
| **R6** | **Quota / storage failure** (localStorage full or private mode) | The text is not lost and the failure is surfaced; the server copy remains authoritative | Fill the origin quota or block storage, then type | No silent data loss; explicit failure state; subsequent save succeeds when space returns | **U** — `store.js:69-77` catches quota errors for the progress blob only; writing has no such path yet. |
| **R7** | Explicit **new / discard** | Discard is intentional and irreversible only after confirmation; a new attempt starts clean at revision 1 | Write text, choose discard, confirm | Text cleared; new attempt created; the discarded text is not resurrected by a late save | **U** |
| **R8** | **Submission double-click** | One submission and one debit; the second click is idempotent | Submit twice rapidly with the same event ID | Exactly one submission; one job; one debit | **S** — `test.mjs` concurrent submission replay asserts a single submission for the same event ID, and a mismatched fingerprint → 409 |
| **R9** | **Submission after reload** (uncertain response) | Retrying with the same event ID returns the same submission rather than creating a second | Submit, drop the response, reload, retry the same event ID | Same submission returned; no second job; no second debit | **S** — `test.mjs` replay path. **U** for the browser retry affordance. |
| **R10** | **Failed / unassessed result** | A failed assessment stays explicitly unassessed and recoverable; **no heuristic mark** | Force `provider_unavailable`, then `retry_exhausted` | Job reaches a classified terminal state; writing shows unassessed; text intact | **S** for classification (`test.mjs` malformed-feedback and safe-retry cases); **U** for the surface |
| **R11** | **Revision lineage** | A revision is a child attempt with a parent submission; the original stays immutable | Submit, then revise | New attempt has `parentSubmissionId`; the original submission is unchanged; historical rubric refs retained | **S** — `test.mjs` revision lineage asserts 201 and immutability (later PUT/snapshot change → 409) |
| **R12** | **Deletion with late worker completion** | Deletion wins: a tombstoned attempt is never completed, and a late worker cannot recreate it or debit | Delete the attempt while a job is in flight, then let the worker finish | No assessment created; no debit; job cancelled (`queued/running → cancelled on deletion`) | **S** — `test.mjs` "deletion defeats stale save, idempotency replay and late completion" |
| **R13** | **Cross-device return** | A second authenticated session retrieves the same saved draft/submission/assessment | Sign in on a second session with the same account | Identical draft text and revision | **S** — `test.mjs` "new session returns saved draft". **U** for any browser cache-clearing behaviour. |
| **R14** | **Real keyboard: caret, feedback and sticky controls** | With the onscreen keyboard open, the caret and feedback stay reachable and sticky controls do not cover the draft | Real iPhone Safari and Android Chrome, onscreen keyboard open | Visual and interaction check | **D** — explicitly **not** closable by emulation |
| **R15** | **Tab discard / process kill** | Text and pending state survive a discarded tab or killed browser process according to the retention policy | Discard the tab mid-draft; kill the browser process mid-submission | Recovery on return; no duplicate submission or debit | **D** — device/browser policy dependent |

---

## 2. What is established today versus what is missing

**Established server-side (class S).** Draft revisioning with conflict rejection, ownership isolation,
submission idempotency by `(owner,eventId)`, immutable revision lineage, allowance reservation, malformed
feedback handling, bounded retry, and deletion defeating late completion are all exercised by
`spikes/auth-runtime/test.mjs`. These are **server contract** results.

**Currently missing (class U).** The browser writing surface has **no persistence path at all**:
`public/js/store.js` contains no writing or draft state, so `exam.js`'s `<textarea>` value lives only in the
DOM. Consequently R1, R2, R3 (browser side), R5, R6, R7, R10 (surface), R14-adjacent UI states and the
browser half of R4/R8/R9/R13 **cannot pass today**. This restates the earlier USER-01 D1 finding without
treating it as a defect for this task: it is a known gap, and closing it is coordinator work.

**Device-only (class D).** R14 and R15 need a real iPhone and a real Android device. No emulated result may
be reported as covering them.

## 3. How each case would be run (synthetic setup)

All runs use a disposable source-only checkout, an explicitly assigned loopback port, a synthetic progress
file and synthetic learner text — never real progress, a real `.env` or a personal browser profile. Where a
case needs an authenticated session, it uses two synthetic accounts owned by the run. Where a failure must
be forced, the provider is stubbed: no live AI call is made, and no numeric writing score is asserted
anywhere, because the pilot's rubric is not calibrated.

Observation is recorded as the exact comparison performed (value equality, revision number, row counts for
submissions/jobs/debits, and the visible state label) so that a reader can tell what was checked rather
than trusting a summary.

## 4. Rules for reporting this matrix later

1. A case may be marked passed **only** with the actual observation recorded, including the comparison
   performed. Unrun cases stay unrun.
2. Class **S** results must not be presented as browser or device evidence.
3. Class **D** cases stay open until a real device run exists; emulation must never close them.
4. No overall pass, grade or readiness claim may be derived from any recovery case, because oral is
   unassessed and writing feedback is provisional.
5. This document is a specification. Changing storage, task identity or `exam.js` remains the coordinator's
   decision and is **not** authorised here.
