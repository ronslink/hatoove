# WRITING-OUTCOMES-02 — implementation comparison, measured (#53 vs #54)

| | |
|---|---|
| Coordinator | `COORD-TAKEOVER-20260930` (Ron-controlled local agent) |
| Date | 2026-10-01 |
| Machine | Ron's Windows host (this coordinator) |
| Base | `origin/main` @ `41b5efb3b967dc529b6a05c4ff47d99fb757fb94` |
| Candidate A | `origin/codex/writing-outcomes-02` @ `72994ad` — PR #53 |
| Candidate B | `origin/codex/writing-outcomes-02-openclaw-a` @ `793f3c6` — PR #54 |

**This is a coordinator measurement, not an independent review.** It exists so that one can be done properly and
so that nobody has to re-derive these numbers. Both candidates were run by the coordinator on this host.

## Why there are two candidates

`WRITING-OUTCOMES-02` was dispatched once (execution `writing-outcomes-02-openclaw-20260930-a`) with a seeded
patch from the earlier paused `writing-outcomes-01` run. A second session on the same host produced a second,
complete implementation on a different branch. Both were pushed within 30 seconds of each other and both opened
draft PRs. Neither author adjudicated between them; both explicitly left that to the coordinator. The branch
collision is itself a coordination defect and is recorded as such in `work/implementation/WRITING-OUTCOMES-02.md`
on candidate B.

They are **different implementations**, not one branch plus an extra commit: `git diff` between them is
1216 insertions / 1042 deletions across all six shared paths.

## Measured results

| Evidence | A (#53) | B (#54) |
|---|---|---|
| `node tools/mock-outcome-check.mjs` | exit 0 · **16/16** fixed-tree checks; pre-fix tree: **15 checks fail, "expected 15"** | exit 0 · **19/19** fixed-tree checks; pre-fix: **15/15 defect checks fail + 4 controls pass** |
| `node --test tools/mock-outcome-check.test.mjs` | exit 0 · **20 tests, 20 pass, 0 fail** | exit 0 · **21 tests, 21 pass, 0 fail** |
| `node tools/mock-outcome-browser-check.mjs` | **exit 1 — cannot run unattended.** Requires a URL argument and a caller-started server, and hard-codes a Linux `chromium-browser` candidate list (its own header says so). With no argument it dies at import: `TypeError: Invalid URL ... input: ''` | **exit 0 — self-contained, 11/11 pass.** Materialises its own disposable source-only copy, refuses live ports, forces the provider offline, starts the copy itself, and takes `--port` |
| Browser evidence on this host | **not obtainable** by the checker as shipped | 11/11 with `CHROME_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe`; without it the checker reports `No Chromium found; set CHROME_PATH` (a host fact, not a code defect) |
| `new-mock-button-restarts-the-mock` | not covered | **covered and passing** |
| `check.js` / `writing-check.js` / `feedback-check.js` | 101 / 9 / 14 | 101 / 9 / 14 |
| `reset` / `revision` / `server-origin` / `keymask` / `progress-equal` | 9 / 8 / 16 / 12 / 10 | 9 / 8 / 16 / 12 / 10 |
| `owned-client` / `owned-api` | 31 / 24 | 31 / 24 |
| feedback / objective / blueprint fixture checks | structurally sound | structurally sound |
| `repository-check.mjs` | passed | passed — 277 tracked files, 206 text blobs screened |

Neither candidate regresses the baseline. The difference is in the checkers and the browser proof, plus candidate
B's additional defect fix.

## The defect candidate B fixes and A does not

Candidate B's own report claims the "Neuer Mocktest" restart button was dead because `#view-actions` is a sibling
of `#view`. The coordinator did **not** take that claim on trust: candidate B's browser check contains
`new-mock-button-restarts-the-mock` and it **passes on this host**, driving the real page in headless Chromium and
asserting the button returns the learner to the intro. Candidate A has no equivalent check and its browser script
cannot be run unattended here, so the defect is neither confirmed nor excluded for A.

## Coordinator's working conclusion — to be independently adjudicated

Candidate B (#54) is the better candidate on every measured axis. **This is not the merge decision**: the rule is
an independent exact-head review, and candidate B's author (OpenClaw) must not be that reviewer. This record is
handed to the reviewer as input, not as a substitute.

## Not established by any of the above

- No exam fidelity, no educational validity, no content or language correctness. `E-01` remains a draft.
- No real phone, tablet, hardware keyboard, dictation or audio. Headless Chromium with emulated viewports only.
- No live provider call: every run forced the provider offline. Provisional-feedback rendering with a **real**
  provider reply was not observed in a browser by anyone.
- Neither candidate is wired into any other workstream; neither closes a gate.
