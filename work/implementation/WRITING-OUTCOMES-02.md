# WRITING-OUTCOMES-02 — truthful mock-writing outcomes

- **Task:** `writing-outcomes-02-openclaw-20260930-a` (slot 3, OpenClaw/Hetzner)
- **Coordinator:** `COORD-TAKEOVER-20260930`
- **Branch:** `codex/writing-outcomes-02`
- **Base used:** `origin/main` @ `41b5efb3b967dc529b6a05c4ff47d99fb757fb94`
  — re-checked on this host (`git rev-parse origin/main` = `41b5efb3b967dc529b6a05c4ff47d99fb757fb94`).
- **Seed material:** the adopted `writing-outcomes-01` draft (`SEED-exam-lf.patch`, `SEED-mock-outcome.js`),
  treated as an untested draft, not as correct.

## What changed

| Path | Change |
| --- | --- |
| `public/js/exam.js` | Mock writing/outcome path: unassessed-when-absent, provisional feedback, no whole-exam claim, completion gate, text preservation. |
| `public/js/mock-outcome.js` | New dependency-free module: `assessMockWriting`, `isProvisionalFeedback`, `summarizeMockOutcome`, `createCompletionGate`, `WRITING_MAX`, `WRITING_REASONS`. |
| `tools/mock-outcome-check.mjs` | Focused offline checks plus a byte-for-byte discrimination run against the pre-fix `exam.js`. |
| `tools/mock-outcome-check.test.mjs` | `node --test` wrapper asserting acceptance and discrimination. |
| `tools/mock-outcome-browser-check.mjs` | Isolated headless-Chromium evidence (desktop + phone). |
| `work/implementation/WRITING-OUTCOMES-02.md` | This record. |

`public/js/store.js`, `public/js/progress-merge.js`, `server.js`, `IMPLEMENTATION_PLAN.md` and
`work/BOARD.md` were **not touched**.

## Required behaviour → implementation

1. **Absent/failed writing stays unassessed.** `assessMockWriting` returns
   `status: 'unassessed', points: null, aiResult: null` with a stable `reason`
   (`empty` / `too_short` / `unavailable` / `feedback_failed` / `malformed_feedback`) and the
   learner text preserved. The offline heuristic is never converted into points and is never
   recorded as an assessed outcome.
2. **Successful AI feedback is provisional.** `status: 'provisional'` with the rubric points; the
   UI says "vorläufig … kein Prüfungsergebnis" and "nicht fachlich freigegeben".
3. **Objective points keep their own denominator.** The result shows "Objektive Punkte … / 180"
   (LV · SB · HV) and "Richtig x / y", computed only from objective parts.
4. **No whole-exam pass/fail, band or readiness percentage.** The `Bestanden?` tile, the
   `gradeBand`-derived whole-exam label and the readiness prediction in the mock intro were removed.
   `summarizeMockOutcome` deliberately returns no `passed`/`band`/`grade`/`readiness` key.
5. **Submitted text preserved.** Success, failure and absence all keep `text`; the result renders it
   in the `Schreiben` card and in "Antworten durchsehen".
6. **Duplicate/late completion guarded.** `createCompletionGate` plus an `isCurrent` guard
   (session identity + phase + block index) allow exactly one collect/commit per block and drop
   results that resolve after the block advanced. `mockPreparation` fences a double `startMock`.
7. **Appearance preserved.** The learner card/table markup is unchanged in structure; writing status
   is a pill, the detail checks moved into a collapsed `<details>`.

## Defects found in the adopted draft (and fixed)

The seeded draft was never run. Two real problems were found and corrected:

1. **Dead "Neuer Mocktest" button.** `#view-actions` is a **sibling** of `#view`
   (`public/index.html:65` vs `:67`), so the draft's `on(el.querySelector('[data-new-mock]'), …)`
   always received `null` and never attached a handler. Fixed to use the element returned by
   `setViewActions`. Covered by `mock-result-button-is-wired-outside-the-view` (source) and
   `new-mock-button-restarts-the-mock` (browser).
2. **CRLF seed patch.** As the coordinator's correction said, `SEED-exam.patch` has CRLF and does not
   apply to the LF checkout. `SEED-exam-lf.patch` applies cleanly to `HEAD`
   (`git apply --check` verified on a detached worktree at the base commit). The working tree already
   contained the adopted draft; it was kept and finished rather than re-applied.

## Acceptance evidence

### 1. Focused tests

`node tools/mock-outcome-check.mjs` → **19 checks**, all green. Covered: missing writing,
too-short writing, unavailable provider, failed provider, malformed response, successful writing,
legitimate zero (distinct from missing), unassessed-not-zero, objective-only aggregation,
"no pass/fail/band/readiness claim", duplicate completion, stale completion, late result after
advance, source-level no-pass-fail and no-heuristic-attempts, plus the action-bar wiring.

`node --test tools/mock-outcome-check.test.mjs` → **21/21 pass**.

### 2. Discrimination (byte-for-byte, not logically)

The checks are run a second time against the **real pre-fix `public/js/exam.js`**, materialized from
git at the base commit. The pre-fix `gradeMockWriting` function span is extracted from those bytes and
**evaluated** (not re-implemented), and both the whole file and the span are asserted against recorded
sha256 digests:

- `public/js/exam.js` (base blob) sha256 `a4ae5192a133d4373e142ee6e90ddb0805befb6358650730071b7d584a27704e`
- extracted `gradeMockWriting` span sha256 `2cd1e95287baf700d82569aee92a777511054efedaf0604afb8e6910ee08b99f`
- `public/js/engine.js` is untouched; base and current bytes share sha256 `7aef13a5…`.

Result on the pre-fix tree: **15/15 defect checks FAIL**, and the **4 control checks still PASS**
(so the probe is not a constant). Example pre-fix failures:

```
FAIL unassessed-writing-is-not-zero-points        [expected null, got 18]
FAIL summary-claims-no-pass-fail-grade-or-readiness [got ["passed","band"]]
FAIL duplicate-completion-commits-once            [collect ran 2x]
FAIL mock-result-source-makes-no-pass-fail-claim  [the mock result must not ask "Bestanden?"]
```

### 3. Baseline unchanged

`check.js` 101 · `writing-check.js` 9 · `feedback-check.js` 14 · `server-origin-check.mjs` 16/16 ·
`reset-check.mjs` 9/9 · `revision-check.mjs` 8/8 · `owned-client-check.mjs` 31/31 ·
`owned-api-check.mjs` 24/24 · `keymask-check.mjs` 12/12 · `progress-equal-check.mjs` 10/10 (OK).
All exit 0.

### 4. Repository hygiene

`node tools/repository-check.mjs` → passed (272 tracked files, 201 text blobs screened).
`git diff --cached --check` clean before commit.

### 5. UI evidence (obtained)

`node tools/mock-outcome-browser-check.mjs` → **11/11 pass**, headless Chromium, offline provider,
own disposable source-only copy on an isolated port (4329/4330; live ports refused), synthetic text
only. Observed at desktop 1440×1120 and phone 390×844:

- writing shown as **"nicht bewertet / unbewertet"**, never a fabricated score;
- **no `Bestanden?` and no grade band**; only "Objektive Punkte … / 180" and "Richtig 0 / 60";
- the synthetic brief remains visible in the `Schreiben` card (and in "Antworten durchsehen");
- no horizontal overflow on either viewport; "Neuer Mocktest" returns to the intro; no console errors.

Screenshots (uncommitted, kept out of the repo): `.openclaw/tmp/wo02-ui/desktop-result.png`,
`.openclaw/tmp/wo02-ui/phone-result.png`.

## Not verified / not claimed

- **No real browser/device/keyboard/audio run.** Evidence is headless Chromium with emulated
  viewports; the earlier `writing-browser-check.js` harness could not find the browser (this host's
  Chromium is at `/snap/bin/chromium`, not in its candidate list), so the new script launches its own.
  No iPhone/Android hardware, real keyboard, dictation or audio was exercised.
- **No live AI / provider call.** Only the offline path was exercised; provisional-feedback rendering
  with a real provider response was **not** observed in a browser (the valid-feedback shape is tested
  at module level only).
- **No exam validity claim.** `E-01` remains a draft and unreviewed; nothing here asserts telc fidelity.
- **Not independently reviewed.** Per Ron's instruction reviews are batched at the end; this branch is
  unmerged.
- **Durable browser recovery** is out of scope (separate `draft-session-01` task).

This closes no educational, security or privacy gate.
