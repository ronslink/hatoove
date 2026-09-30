# Handoff: PRE-03 / pre03-20260930-b

- Outcome: complete — ready for coordinator review, import and push
- Owner and host: Hermes in `hermes-agent` (Docker on WSL2), global slot 3
- GitHub issue / PR: https://github.com/ronslink/hatoove/issues/2 (no PR; coordinator opens it)
- Branch / base SHA / final commit SHA: `codex/pre-03-hermes-b` / `2feaba6f315450230a0c7112681a4a47b463f1ce` / recorded below after commit
- Worktree and preserved outputs: `/opt/data/workspaces/hatoove-pre-03` (preserved, not deleted); bundle export at `/projects/hatoove-handoff/pre03-20260930-b.bundle`
- Current assignment expiry (UTC): 2026-09-30T18:01:00Z
- Child agents, slots and final state (or none): none — Hermes child budget is zero for this project; no delegation performed

## Result

Preparation exercise PRE-03 for the Hermes worker handoff path. No product code was edited. The only tracked change is this report; the only export is the Git bundle.

Purpose: prove that the Hermes worker can execute the repository's required offline guards against a coordinator-prepared worktree, produce a scoped report commit, and hand the branch back by Git bundle, without GitHub access, without touching shared or product paths, and without changing global configuration.

The previous execution of this exercise stopped after its checks because the coordinator-created clone/worktree was root-owned and no commit was possible. The coordinator corrected ownership to UID/GID 10000 and prepared a fresh branch. This execution confirms the correction holds for both the worktree and the Git metadata.

### Pre-edit confirmation (as required by the assignment)

| Item | Assigned | Observed | Match |
|---|---|---|---|
| Branch | `codex/pre-03-hermes-b` | `codex/pre-03-hermes-b` | yes |
| Base SHA | `2feaba6f315450230a0c7112681a4a47b463f1ce` | `2feaba6f315450230a0c7112681a4a47b463f1ce` | yes |
| Worktree | `/opt/data/workspaces/hatoove-pre-03` | `/opt/data/workspaces/hatoove-pre-03` | yes |
| Runtime identity | UID/GID 10000 | `uid=10000(hermes) gid=10000(hermes)` | yes |

`git worktree list` reports the shared clone at `/opt/data/workspaces/hatoove` on `[main]` and this worktree on `[codex/pre-03-hermes-b]` at the same base SHA, so the two writing surfaces are separate checkouts as the workflow requires.

### Changed paths

| Path | Change | Scope |
|---|---|---|
| `work/exercises/PRE-03/pre03-20260930-b/RESULT.md` | added | the single allowed tracked change |

No other tracked path was created, edited or staged. `.qa/` holds the temporary check transcript and is ignored by `.gitignore`, as permitted.

## Acceptance evidence

### Runtime versions (captured in this worktree)

| Component | Version / value |
|---|---|
| Node.js | v26.5.1 (`/usr/local/bin/node`) |
| npm | 11.17.0 (invoked for version reporting only; no install performed) |
| Git | 2.47.3 |
| Kernel | Linux 6.6.87.2-microsoft-standard-WSL2, x86_64 |
| Date at start of checks | 2026-09-30T17:00:49Z |
| Repository identity for the commit | `Hatoove Hermes <hatoove-hermes@localhost>` (repository-local, pre-set by the coordinator) |

`package.json` declares `engines.node >= 20`, so the Node 26 runtime is within the declared range.

### Required checks — actual observed results

| Acceptance item | Check or command | Observed result | Evidence / limitation |
|---|---|---|---|
| Secret/exclusion guard on the checkout | `node tools/repository-check.mjs` | pass, exit 0 | `Repository check passed: 133 tracked files; 113 text blobs screened. This is not a complete secret audit.` |
| Legacy behavior regression suite | `node tools/check.js` | 101 passed, 0 failed, exit 0 | `All checks passed.` Full transcript at `.qa/check.out` (ignored). One non-fatal `ExperimentalWarning: localStorage is not available because --localstorage-file was not provided.` |
| Writing-subtest regression suite | `node tools/writing-check.js` | 9 passed, 0 failed, exit 0 | Nine PASS lines, e.g. `PASS offline rotation alternates du/Sie and visits six different topics before repeating` |
| Formative-feedback regression suite | `node tools/feedback-check.js` | 14 passed, 0 failed, exit 0 | `14 passed, 0 failed (/opt/data/workspaces/hatoove-pre-03/public/js/ai.js)` |
| Guard re-run on the staged snapshot | `node tools/repository-check.mjs` after `git add` | pass, exit 0 | Recorded below; this is the run that gates the commit |
| Bundle integrity | `git bundle verify` | pass | Recorded below |

Observed counts match the recorded baseline in `AGENTS.md` / `docs/AGENT_WORKFLOW.md` exactly: 101 + 9 + 14, with 0 failures. No test was skipped, and no failure was encountered or repaired.

### Agent preflight versus product verification

This is explicitly a **preflight of the agent handoff path**, not product verification, and the results must not be read as either of the following:

- **Not exam validation.** `AGENTS.md` records that these suites test legacy behavior and do not establish exam validity. A green run says the working tree still behaves as it did at the base commit; it says nothing about telc B1 correctness, content quality or pedagogical suitability.
- **Not product acceptance.** No UI, desktop, mobile, iPhone/Android, audio, keyboard or browser evidence was produced. No application server was started, no live model benchmark was run, no deployment or recovery/sync/portable-build script was executed, and no credential or configuration file was inspected. No learner data was touched.
- **What it does prove.** That this worktree, as UID/GID 10000, can read the guards, execute them to completion, write inside the worktree, stage a scoped path, commit with the repository-local identity, and export a verifiable bundle — i.e. the capability the previous execution could not demonstrate because of the root-owned checkout.

### Scope discipline

| Constraint | Status |
|---|---|
| Only `work/exercises/PRE-03/pre03-20260930-b/RESULT.md` changed (tracked) | honoured |
| Export limited to `/projects/hatoove-handoff/pre03-20260930-b.bundle` | honoured |
| Temporary files only in ignored `.qa/` | honoured |
| No product code, central board (`work/BOARD.md`) or other tracked path edited | honoured |
| No delegation / no child agents | honoured |
| No live model benchmarks, no application servers, no package installs | honoured |
| No deploy, no push, no merge, no force-push | honoured |
| No credential, `.env` or machine-config inspection; no GitHub authentication attempted | honoured |
| No sudo, no privilege-escalation investigation | honoured |
| No global configuration change | honoured |

## Commit, export and integrity

| Item | Value |
|---|---|
| Staged path list (exactly one entry) | `work/exercises/PRE-03/pre03-20260930-b/RESULT.md` |
| Staged-snapshot guard | `node tools/repository-check.mjs` — pass, exit 0 (run after `git add`, before `git commit`) |
| Commit identity | `Hatoove Hermes <hatoove-hermes@localhost>` (repository-local; inherited from the clone's Git config, not changed) |
| Commit message | `PRE-03: record Hermes worker preflight (pre03-20260930-b)` |
| Final commit SHA | returned in the handoff response; recorded by the bundle's ref metadata |
| Parent / base | `2feaba6f315450230a0c7112681a4a47b463f1ce` |
| Bundle path | `/projects/hatoove-handoff/pre03-20260930-b.bundle` |
| Bundle verification | `git bundle verify` — pass, reporting one ref `refs/heads/codex/pre-03-hermes-b` and its prerequisite commit |
| Bundle SHA-256 | returned in the handoff response, not embedded here |
| Bundle size | returned in the handoff response, not embedded here |
| Worktree after completion | preserved at `/opt/data/workspaces/hatoove-pre-03`, checked out on `codex/pre-03-hermes-b` |
| Background processes left running | none |

Because a commit cannot embed its own SHA, the final commit SHA and the bundle digest are returned in the handoff response and read back from the bundle rather than written into this file; the identifying facts that are stable before the commit (base SHA, branch, commit message, exact staged path) are recorded above.

The bundle is a self-contained export of the single branch `codex/pre-03-hermes-b`. The coordinator can import it without altering the commit SHA, verify the diff is limited to the one report path, push the branch and open the PR for independent review.

## Open matters

- **Remaining defects or blocked decisions:** none. The prior blocker (root-owned clone/worktree) is resolved and did not recur; both the worktree and Git metadata were writable as UID/GID 10000 for the whole execution.
- **Failed checks and relevant diagnostic summary:** none. All four required checks exited 0. The only diagnostic emitted was a benign Node `ExperimentalWarning` about `--localstorage-file` from `tools/check.js`; it does not affect the result.
- **Interpretation caveat:** the 101/9/14 counts are a legacy regression baseline, not evidence of exam validity; no source was repaired even though none needed repair.
- **Interface/contract implications:** none. No shared file, contract or interface was touched. `public/js/exam.js` was not opened for editing.
- **Evidence not produced (out of scope for this preparation exercise):** UI/desktop/mobile screenshots, iPhone Safari and Android Chrome device checks, live provider calls, audio checks and entitlement/debit flows.
- **Suggested next task:** the coordinator imports this bundle, confirms the commit is unchanged and the diff is one file, pushes `codex/pre-03-hermes-b`, and opens the PR against issue #2; then this preparation exercise can be marked complete and the file cleaned up or retained as the recorded evidence.
- **Running processes stopped or still active, with identifiers:** none active. No server, watcher or background job was started.

## Integration request

- **Independent review requested from:** the coordinator (or an allocated reviewer with a spare slot). Hermes does not approve its own work.
- **Current-base verification needed:** yes — the coordinator should re-run `node tools/repository-check.mjs` against its imported snapshot. This exercise proves the guard passes on this exact commit, but the coordinator owns the current-base check before merge.
- **Assignment current, or stale work offered for explicit adoption:** the assignment was current at 2026-09-30T17:01Z; the work was completed before the 18:01Z expiry. If the coordinator judges the execution stale on receipt, this report should be treated as work offered for explicit adoption under the current task, not as an authorized merge.
