# WO02-VERIFY — independent verdict on WRITING-OUTCOMES-02, and a correction to my own reasoning

| | |
|---|---|
| Reviewer | Hermes/Docker, execution **`wo02-verify-hermes-20261001-a`** — **not** the author of either candidate |
| Reviewed | candidate B `793f3c6c236d2544f06a8d722ca0785fded2e782` (PR #54); candidate A `72994ad444b3cddd9f2b50e7adabd2a6cffc1d87` (PR #53) |
| Verdict | **accept-with-notes for candidate B**, no blocking defect. A-vs-B recommendation: **B** |
| Delivered | report sha256 `bf95ebc7…`, probe sha256 `7290c2c3…`; raw logs and screenshots collected in the coordinator handoff folder |

The coordinator merged #54 (`8d6dc44`) on measured evidence **before** this verdict was available, and said so in
the merge record. The verdict now exists, it **upholds the choice**, and it **corrects the reasoning I gave**.

## The verdict's counts, reproduced independently on Linux

| Evidence | B `793f3c6` | A `72994ad` |
|---|---|---|
| `tools/mock-outcome-check.mjs` | 19/19, exit 0 | 16/16, exit 0 |
| `mock-outcome-check.test.mjs` | 21/21, 0 fail | 20/20, 0 fail |
| `mock-outcome-browser-check.mjs` | 11/11, exit 0 | **exit 1 unattended, both modes** |
| the reviewer's own probe (`tools/wo02-verify-probe.mjs`) | **14/14** | **10/14** |
| baseline | 101 · 9 · 14 · 16 · 9 · 8 · 31 · 24 · 12 · 10, repository-check passed | `check.js` 101 only |

These match what I measured on Windows, including the browser check's 11/11 and A's inability to run unattended.

## Correction to my own reasoning — recorded because the record must not carry a false claim

My merge note said candidate B "fixes a dead *Neuer Mocktest* restart button **#53 lacks**". **That is wrong, and
the reviewer proved it.** Candidate A never had the defect: it wires the button with
`document.querySelector('[data-new-mock]')`, and the reviewer ran A in a real browser and saw the button work.
The reviewer also proved the *check* discriminates by re-introducing the broken wiring into a **scratch copy of
B**, where exactly one check flips (13/14).

So the tie-breaker I published was not a real difference between the candidates. **The decision still stands, on
a better reason the reviewer supplied.**

## The reason the decision holds — a defect candidate A has and B does not

**D1: candidate A's completion gate can lock permanently.** `createCompletionGate` in A is used without a
rejection handler, so after a `collect` that throws, the gate stays locked forever: a retry rejects with the
original error and nothing is ever committed. B recovers. The reviewer gives a deterministic reproduction in its
non-browser probe (`M8`). The UI reachability of D1 was **not** established — it is a latent defect in A, not a
proven user-visible failure.

**D2 (partial requirement miss in A):** in an unassessed result, A renders the learner's text only inside a
collapsed `<details>` ("Antworten durchsehen") — present but hidden — where B shows it inline. Requirement 4 is
met by B and only partially by A.

**A's branch stays retained**, so if it is ever revived D1 must be fixed first. It is recorded here so nobody
re-merges it as-is.

## Notes against B's own report — accuracy, not code

- **N1:** 3 of B's 15 claimed "pre-fix failures" are measured against an **author-written stub gate**, not the
  base tree. The tool header discloses this; the report did not.
- **N2:** B reports `272/201` tracked files; the committed tree is `277/206` — the pre-`git add` count.
- Neither is a code defect. Both are the class of overclaim this programme keeps catching, so they are recorded.

## What the reviewer could not verify

The seed patch bytes (absent from its workspace) · provisional rendering against a **real** provider reply (module
level only, no live call) · "appearance preserved" beyond overflow/console checks (no before/after visual diff) ·
any real device, keyboard, dictation or audio · that the base tree *behaviourally* lacked a completion gate
(source fact only) · D1's reachability through the UI.

## Consequence for the record

- `work/implementation/WRITING-OUTCOMES-02.md` (candidate B's own record) **overclaims twice**; this document is
  the correction, and it does not edit the author's file.
- The reviewer's independent probe is adopted into the repository as `tools/wo02-verify-probe.mjs` — it is
  candidate-neutral (the same file ran against A, B and a mutated scratch tree) and it is the first artefact in
  this programme that can grade *another candidate's* checker rather than its own.
- No gate is closed. `E-01` remains an unreviewed draft; writing feedback remains provisional; no exam-validity
  claim is made anywhere in this slice.
