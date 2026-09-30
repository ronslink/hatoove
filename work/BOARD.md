# Hatoove work board

The local coordinator owns this board. Detailed assignments live on linked GitHub issues; PRs and merged source provide completion evidence. Follow the [workflow](../docs/AGENT_WORKFLOW.md), [task template](TASK_TEMPLATE.md) and [handoff template](HANDOFF_TEMPLATE.md).

Repository: **[private `ronslink/hatoove`](https://github.com/ronslink/hatoove)**. Curated baseline `2feaba6` is published and its Linux/Windows CI passed. Remote assignments are linked below. No production deployment or recurring runner is scheduled.

## Preparation

| ID | Task / owner | State and prerequisites | Completion evidence |
|---|---|---|---|
| PRE-01 | Curated source, private repository, guidance and CI / coordinator | Done | Private baseline `2feaba6`; 133 source files, no gitlinks; source guard and negative excluded-file check passed; 124 regression checks; [Linux/Windows CI](https://github.com/ronslink/hatoove/actions/runs/36747230832) passed |
| PRE-02 | OpenClaw write/PR exercise / Hetzner worker | Done, [issue #1](https://github.com/ronslink/hatoove/issues/1) | Actual agent run, 124 checks, scoped commit `54be708`; independently reviewed and merged [PR #3](https://github.com/ronslink/hatoove/pull/3), CI passed |
| PRE-03 | Hermes write/PR exercise / Hermes worker | Done, [issue #2](https://github.com/ronslink/hatoove/issues/2) | Ownership failure repaired; fresh execution `pre03-20260930-b` produced 124 passing checks and scoped commit `b7db454`; bundle digest/one-commit history/snapshot guard verified; reviewed [PR #4](https://github.com/ronslink/hatoove/pull/4), CI passed |
| PRE-04 | Previous-app visual and mobile reference / coordinator | Desktop reference and acceptance recorded; responsive implementation remains | [Reference and mobile acceptance](../docs/design/REFERENCE_UI.md); real-device checks remain outstanding |
| PRE-05 | Durable pilot contracts and first implementation slices / coordinator | Ready after PRE-01; incorporate PRE-04 UI decisions | Owned attempts/drafts, revisions, idempotency and feedback states specified; objective/audio boundary defined; implementation tasks have paths, dependencies and failure checks |
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

Global cap: **4 active agents including the coordinator and all children/reviewers**. All remote preparation runs have ended; no remote worker or child is assigned now. New tasks require fresh allocations. Existing Hermes installation allows four children and depth two with automatic worktree isolation off; these host defaults do not grant this project permission to use them.

| Task | Execution ID | Owner / host | Slot | Branch / base SHA | Checkpoint / expiry UTC | Issue / PR |
|---|---|---|---|---|---|---|
| Coordination | Session integration | Local coordinator | 1 | `codex/coordinator-cadence` / `2feaba6` | Session-managed | Coordination PR pending |

Update status only from observed evidence. Distinguish a tooling inventory, a successful agent exercise, and a verified product behavior.

Next ready coordinator task: PRE-05, the durable pilot contracts/auth-runtime spike, using the preserved UI reference from PRE-04. Allocate bounded worker checks after its interfaces and paths are defined. Product implementation and real-device acceptance have not been completed by repository preparation.
