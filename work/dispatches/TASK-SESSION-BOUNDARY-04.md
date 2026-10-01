# SESSION-BOUNDARY-04 — N-1: a second tab re-creates the account's record after the forget

Worker: any. Execution id: `session-boundary-04-*-20261001-a`.
Coordinator: `COORD-TAKEOVER-20260930`. **Checkpoint 30 minutes · Expires 150 minutes.**

## Base

**`origin/codex/ownapi-03-persistent` @ `34c992c`** — the candidate, which already contains the session boundary and
the N-2 fix. Record the SHA.

## The finding (N-1, medium) — from the independent fix review

> **N-1** — Another page/window of the same browser re-creates the account's record (with its text) in `localStorage`
> after the sign-out forget — the fix removes the key once and does not fence other pages. Present on the base tree
> too (not introduced here), not disclosed in the record. **Severity: medium. Executed: yes (`S7b`, `S17`, both
> trees).**

**It is not introduced by the session boundary — it predates it.** That does not make it less real: after a sign-out
the learner's text is supposed to be gone from the browser, and a second tab puts it back.

## The mechanism, read from the code rather than guessed

`store.forgetAccountRecords()` (`public/js/store.js:236`) enumerates `localStorage` and calls `removeItem` for every
key starting with `b1prep.state.v1::` (`:121`, `scopedStorageKey`). That is **a one-off sweep, in the tab that ran
it.**

**Every other tab is untouched, and it is still signed in from its own point of view.** A second tab that already
loaded the account holds the record **in memory**, and its ordinary debounced write path will call `setItem` for
`b1prep.state.v1::<accountId>` — **re-creating the very key the forget removed, with the learner's text in it.**
Nothing in `persist()` consults whether this browser has since signed out, because until now nothing recorded that
fact where a second tab could see it.

So the defect is not "the sweep is incomplete". It is **that the forget is not communicated to the other tabs, and
the write path is not fenced against a forget that happened elsewhere.**

## What the fix needs — and the two halves are both required

1. **A durable marker that a write path can consult.** Something in `localStorage` that says *this browser is signed
   out as of <moment/epoch>*, written **before or with** the sweep and removed on the next successful sign-in. It
   holds **no learner text** — the same rule the pending-reset flags already follow (`:233`) — so keeping it is
   consistent with the existing design.
2. **`persist()` must refuse while that marker is present.** Without this half, the marker changes nothing.
3. **A `storage` event listener so the other tab notices.** Without this half, the second tab keeps its state in
   memory and only stops writing — the learner is still looking at the previous account's data. **The honest
   behaviour is that the other tab goes to the signed-out state**, which is also what the session boundary does for
   the tab that signed out.
4. **Remove the marker on a successful sign-in**, or the next learner on that browser cannot save at all — which
   would turn a privacy fix into a data-loss bug. **Treat that as the primary risk of this slice.**

## Acceptance — report ACTUAL output

1. **A check that fails on `34c992c` and passes on your head**, using the reviewer's `S7b`/`S17` reproduction from
   `reports/session-boundary-02-review-hermes-20261001-a/` as the starting point. **It must drive two real tabs** —
   if the check only simulates a second writer, it is not testing the thing that actually fails.
2. **The control that matters most: the next sign-in can still save.** Prove a fresh sign-in after a forget writes
   its record successfully. A fix that blocks all writes is worse than the bug.
3. **A control that no text returns**: after the forget and after the second tab has had a chance to write, a scan of
   `localStorage` finds **no** account namespace key containing the learner's marker string.
4. **Baseline unchanged**: `check.js` 101 · writing 9 · feedback 14 · server-origin 16 · keymask 12 ·
   `reset-check.mjs` **8** · revision 8 · progress-equal 10 · owned-client 31 · owned-api 24 · draft-session 18 ·
   mock-outcome 19 · progress-scope 7 · design-check exit 0 · provider-config 11 · repository-check passes.
   `session-boundary-check` **12** and `session-boundary-browser-check` **38** must still pass.
5. LF not CRLF; `git diff --cached --check` clean; every `.mjs` run from a file.

## Deliverable

- Branch `codex/session-boundary-04` from `34c992c`.
- Allowed: `public/js/store.js`, `public/js/account.js`, `public/js/app.js`,
  `tools/session-boundary-browser-check.mjs`, `tools/session-boundary-check.mjs`,
  `work/implementation/SESSION-BOUNDARY-01.md` (append only).
- **Do not touch** `server.js`, `server/**`, `public/js/exam.js`, `public/js/owned-client.js`, `public/js/ui.js`,
  `.github/**`, `package.json`.
- **Commit and push after each numbered step, separately.** This rule has already saved two runs.
- Open a **draft PR** — and note that **a branch with no PR gets no CI**, which cost this programme a check cycle
  already.
- **If the marker half works but the `storage`-event half cannot be made reliable, stop at a pushed milestone and
  report that** rather than shipping a marker that leaves the other tab displaying the previous learner's data.

## Boundaries

- Synthetic accounts and a stubbed provider only. No live AI, no real credential, no real learner record. Never touch
  `D:\B1_Prep`.
- No real devices: this is a cross-tab property and can be proven with two headless pages; **say plainly that a real
  phone or a bfcache restore was not exercised.**
- No deployment, no production access. **This closes no gate**; issue #63 is explicitly not a production-security
  approval, and `P-03`/`X-01` stay open.
- **State plainly what you could not verify.**
