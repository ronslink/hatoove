# Hatoove work board

The local coordinator owns this board. Detailed assignments live on linked GitHub issues; PRs and merged source provide completion evidence. Follow the [workflow](../docs/AGENT_WORKFLOW.md), [task template](TASK_TEMPLATE.md) and [handoff template](HANDOFF_TEMPLATE.md).

Repository: **[private `ronslink/hatoove`](https://github.com/ronslink/hatoove)**. Curated baseline `2feaba6` is published and its Linux/Windows CI passed. Remote assignments are linked below. No production deployment is scheduled. Ron-authorized coordinator heartbeat `continue-hatoove-implementation` is active every five minutes; worker runs remain bounded.

## Preparation

| ID | Task / owner | State and prerequisites | Completion evidence |
|---|---|---|---|
| PRE-01 | Curated source, private repository, guidance and CI / coordinator | Done | Private baseline `2feaba6`; 133 source files, no gitlinks; source guard and negative excluded-file check passed; 124 regression checks; [Linux/Windows CI](https://github.com/ronslink/hatoove/actions/runs/36747230832) passed |
| PRE-02 | OpenClaw write/PR exercise / Hetzner worker | Done, [issue #1](https://github.com/ronslink/hatoove/issues/1) | Actual agent run, 124 checks, scoped commit `54be708`; independently reviewed and merged [PR #3](https://github.com/ronslink/hatoove/pull/3), CI passed |
| PRE-03 | Hermes write/PR exercise / Hermes worker | Done, [issue #2](https://github.com/ronslink/hatoove/issues/2) | Ownership failure repaired; fresh execution `pre03-20260930-b` produced 124 passing checks and scoped commit `b7db454`; bundle digest/one-commit history/snapshot guard verified; reviewed [PR #4](https://github.com/ronslink/hatoove/pull/4), CI passed |
| PRE-04 | Previous-app visual and mobile reference / coordinator | Desktop reference and acceptance recorded; responsive implementation remains | [Reference and mobile acceptance](../docs/design/REFERENCE_UI.md); real-device checks remain outstanding |
| PRE-05 | Durable pilot contracts and first implementation slices / coordinator | First spike validated, [PR #11](https://github.com/ronslink/hatoove/pull/11), [issue #7](https://github.com/ronslink/hatoove/issues/7), execution pre05-20260930-a | [Contract 0.1.0](../docs/contracts/PILOT-V0.1.md) and [results/review disposition](implementation/PRE-05-RESULT.md); final integration recorded on PR; broader ownership/UI/human gates remain |
| PRE-06 | Hermes child exercise / Hermes + one granted child | Done, [issue #5](https://github.com/ronslink/hatoove/issues/5) | One actual synchronous child completed; direct trace inspection, separate clean worktrees and 9 writing checks; [verified evidence](exercises/PRE-06/pre06-20260930-a/RESULT.md). Multi-child concurrency and child writing remain unverified |

Preparation exercises use distinct paths such as `work/exercises/PRE-02/<execution-id>/RESULT.md` and `work/exercises/PRE-03/<execution-id>/RESULT.md`, finalized in their dispatch records. They do not change product code. The coordinator can run PRE-04/PRE-05 while worker exercises proceed.

## Product task candidates

These are the next implementation slices, not current worker assignments. Convert each into a fully specified task and start when its listed dependencies and specification are ready. Major implementation remains with the coordinator; worker contributions are separately scoped.

| ID | Deliverable / primary owner | Dependencies | Required outcome |
|---|---|---|---|
| PILOT-01 | Preserve logged-in appearance and adapt phone/tablet layouts / coordinator; bounded worker CSS/checks | PRE-04, relevant worker preflight | Familiar dashboard and practice appearance; usable navigation, touch and writing layout; desktop/mobile evidence without horizontal clipping |
| PILOT-02 | Authentication, owned attempts and recoverable drafts / coordinator | PRE-05 | Two-account isolation, account-scoped cache, saved draft after reload/navigation, cross-device return; no private state after sign-out |
| PILOT-03 | Reviewed objective practice with fixed audio / coordinator; worker fixtures/audits | PRE-05, PILOT-02 | Server marking matches reviewed keys; one recording across browsers; interrupted playback/session recovers; content review evidence retained |
| PILOT-04 | Durable writing feedback and revision / coordinator; worker failure checks | PRE-05, PILOT-02 | Idempotent submission, saved pending/result/failure states, recoverable retries, preserved revision lineage and correct usage accounting with provider stubs |
| PILOT-05 | Complete learner journey and independent verification / coordinator + independent checker | PILOT-01 through PILOT-04 | Exam/date/language setup through practice, feedback, revision and return; phone/desktop recovery evidence; formative limitations clear |

Use the [pilot plan](../PILOT_BUILD_PLAN.md) for detailed scope. Speaking is excluded. Product implementation readiness does not grant production deployment permission.

## Active executions

Global cap: **4 active agents including the coordinator and all children/reviewers**. Preparation executions are historical. Current allocations below are for 30 September 2026; leases are recorded separately per execution. No recursive spawning.

| Slot | Execution | Current assignment/status |
|---|---|---|
| 1 | COORD-TAKEOVER-20260930 | **Ron's locally controlled agent is now the coordinator** (issue [#27](https://github.com/ronslink/hatoove/issues/27); ACK in the shared handoff). Owns allocation, architecture/contracts, central records and integration after independent review and green CI; maintains CURRENT.md every 5 minutes. Original coordinator implementation paused at Ron's request; `codex/writing-outcomes-01` preserved/unmerged |
| 2 | ocli-20260930-a | Hermes OWNED-CLI-01 / issue23: base `074aebf`, branch `codex/owned-client-01` = **`009d931`**. Complete and terminated cleanly; branch pushed to origin. **Independently reviewed by OpenClaw `ocli-r1b` = accept-with-notes, PR #30**, all 8 focus items PASS against its own 180-assertion adversarial suite; three low-severity notes await coordinator action. Future runs 160/2400 |
| 3 | sec-01-openclaw-20260930-a | OpenClaw **running** the F-1 boundary fix on `codex/sec-01-origin` from `82ae9c2`: reject cross-origin non-GET `/api/**`, require JSON content type, constrain `baseUrl` to https/loopback, new `tools/server-origin-check.mjs`. Finding from the read-only audit PR #37; high severity but loopback-only, not remotely exploitable. Expires 22:00 UTC |
| 4 | privacy-audit-01-claude-20260930-a | Claude **completed** a read-only privacy and data-integrity audit of merged main: report `work/implementation/P-03A-PRIVACY-AUDIT.md` on `codex/privacy-audit-01`, draft PR #37. One high finding (**F-1**, `server.js` has no Origin/Host/CSRF/content-type check and `POST /api/config` can retarget `baseUrl` so the DeepSeek key is sent elsewhere — loopback-only, not remotely exploitable; fix now running as `sec-01`), two medium (**F-2** reset/clear delete nothing; **F-3** learner text sent to the provider without disclosure), plus low/informational. **No secret committed, now or in git history.** Input to the human P-03 gate; closes nothing. The previous `integ-stack` work is complete: PR #35 merged as `82ae9c2` |
| — | integ-stack-20260930-a | **MERGED.** PR #35 → `82ae9c2`: ordinary merge of `2bcf749` into `074aebf`, 13 files added, 0 deletions. Independent review PR #36 = accept-with-notes, no blocking notes; CI green including the `postgres` job running `isolation.test.mjs` 11/11. Superseded stacked PRs #17/#21 closed. The earlier hand-rebuild PR #33 was rejected (PR #34) for reverting seven files and would have deleted the isolation CI step |
| — | user04-r3-clawd-20260930-a | **Clawdbot** (local, `d:\clawdbot` workspace) delta recheck `cba0f0c..c8c86dc` → **accept-with-notes**, report `work/implementation/USER04-R3-REPORT.md` on `codex/user04-r3-review-clawd`, draft **PR #31**. Found the `NEW-1` regression in my correction code and caught a wrong per-suite count in my commit message. Complete |

The advisory reviewer supplied failure cases (idempotency races, transactional rollback, lease fencing, allowance reservation and deletion precedence); those are test advice, not diff approval. See [USER-01 disposition and next slices](implementation/PILOT-01-CSS.md). `public/js/exam.js` remains reserved for the coordinator; unfinished mock-outcome edits are preserved in its isolated worktree and paused at Ron's request.

Ron-agent handoff: `C:/Users/ronon/.codex/hatoove-handoff/ron-agent`. Coordinator owns `CURRENT.md`/`QUEUE.md`; worker writes execution-specific `ACK.md`, `CHECKPOINT.md`, `RESULT.md`. Communication files only, outside source/OneDrive. CURRENT grants the USER-04 five-task sequence; other queue candidates do not grant edits. The coordinator heartbeat checks this folder; the user-controlled agent polls it as arranged by Ron.

Coordinator preparation closes with the merge of [PR #6](https://github.com/ronslink/hatoove/pull/6), following independent review and CI. The completed PRE dispatch files are historical records, not current execution grants.

Update this board and IMPLEMENTATION_PLAN.md progress together after meaningful transitions. Update status only from observed evidence. Distinguish a tooling inventory, a successful agent exercise, and a verified product behavior.

PRE-05 PR #11 merged ata9a4cfd; CSS PR #12 atbb30267; SQL PR #18 ata58f6fb; discovery PR #20 includes7e24229. Issues10/13/14 closed after acceptance of their bounded slices. Next: independently review USER04 corrections to source/fixtures PR17, then coordinator-owned client/draft recovery. The original CSS review overstated tablet/focus defects; only reproduced D5/D6 received changes. Text zoom, real-device acceptance and complete learner journey remain open.

## Coordinator ownership transfer — 2026-09-30 19:07 UTC

Ron explicitly appointed his locally controlled agent to take over coordination between Hermes and OpenClaw and requested a substantial task batch. [Issue27](https://github.com/ronslink/hatoove/issues/27) records the transfer. The new coordinator owns task allocation, architecture/contracts, central records and integration after independent review and greenCI; the original coordinator's implementation is paused and its unfinished changes remain preserved/unmerged. The new coordinator must ACK in the shared handoff and maintain CURRENT.md every5minutes. Twelve ordered delivery workstreams and exact worker/branch/process state are in C:/Users/ronon/.codex/hatoove-handoff/ron-agent/COORDINATOR-HANDOFF.md and QUEUE.md. Earlier references to the original chat as the sole coordinator are superseded by this user instruction. Existing worker leases, the global4agentcap and production/human-review gates remain.
