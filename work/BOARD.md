# Hatoove work board

The local coordinator owns this board. Detailed assignments live on linked GitHub issues; PRs and merged source provide completion evidence. Follow the [workflow](../docs/AGENT_WORKFLOW.md), [task template](TASK_TEMPLATE.md) and [handoff template](HANDOFF_TEMPLATE.md).

Repository: **[private `ronslink/hatoove`](https://github.com/ronslink/hatoove)**. Curated baseline `2feaba6` is published and its Linux/Windows CI passed. Remote assignments are linked below. No production deployment is scheduled. Ron-authorized coordinator heartbeat `continue-hatoove-implementation` is active every ten minutes; worker runs remain bounded.

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
| 1 | f02-20260930-a completed; progress-20260930 | Coordinator SQL slice merged PR18 ata58f6fb; independent review/final CI passed; updating master plan/board and preparing owned-client/draft slice. Dedicated synthetic DB stopped |
| 2 | c01d-20260930-a completed | Hermes runs ended; coordinator independently checked/package-reviewed the corrected two-file source7e24229 and merged PR20 on green CI. Slot free; no live Hermes task |
| 3 | user04r-20260930-a | Local read-only acceptance review of exact USER04 daaf55f/PR21, checkpoint19:00, expires19:15. Prior SQL270e1b8 review approved; OpenClaw PR15 closed and remote process ended |
| 4 | user04-20260930-a | Ron-controlled agent [five-task batch](implementation/USER-04.md), issue #19; branch codex/user04-source-fixtures, base7030a66; expires20:31 UTC. Five deliverables reported in PR21; checker edits still in progress and acceptance corrections in CURRENT. Preserve branch; no new grant until clean reviewed handoff |

The advisory reviewer supplied failure cases (idempotency races, transactional rollback, lease fencing, allowance reservation and deletion precedence); those are test advice, not diff approval. See [USER-01 disposition and next slices](implementation/PILOT-01-CSS.md). `public/js/exam.js` is reserved for coordinator-owned draft integration, with no active edits yet.

Ron-agent handoff: `C:/Users/ronon/.codex/hatoove-handoff/ron-agent`. Coordinator owns `CURRENT.md`/`QUEUE.md`; worker writes execution-specific `ACK.md`, `CHECKPOINT.md`, `RESULT.md`. Communication files only, outside source/OneDrive. CURRENT grants the USER-04 five-task sequence; other queue candidates do not grant edits. The coordinator heartbeat checks this folder; the user-controlled agent polls it as arranged by Ron.

Coordinator preparation closes with the merge of [PR #6](https://github.com/ronslink/hatoove/pull/6), following independent review and CI. The completed PRE dispatch files are historical records, not current execution grants.

Update this board and IMPLEMENTATION_PLAN.md progress together after meaningful transitions. Update status only from observed evidence. Distinguish a tooling inventory, a successful agent exercise, and a verified product behavior.

PRE-05 PR #11 merged ata9a4cfd; CSS PR #12 atbb30267; SQL PR #18 ata58f6fb; discovery PR #20 includes7e24229. Issues10/13/14 closed after acceptance of their bounded slices. Next: independently review USER04 corrections to source/fixtures PR17, then coordinator-owned client/draft recovery. The original CSS review overstated tablet/focus defects; only reproduced D5/D6 received changes. Text zoom, real-device acceptance and complete learner journey remain open.
