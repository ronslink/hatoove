# Hatoove work board

The local coordinator owns this board. Detailed assignments live on linked GitHub issues; PRs and merged source provide completion evidence. Follow the [workflow](../docs/AGENT_WORKFLOW.md), [task template](TASK_TEMPLATE.md) and [handoff template](HANDOFF_TEMPLATE.md).

Repository: **[private `ronslink/hatoove`](https://github.com/ronslink/hatoove)**, created and visibility verified. The initial curated commit is in progress. No remote task is assigned by this document alone. No production deployment or recurring runner is scheduled.

## Preparation

| ID | Task / owner | State and prerequisites | Completion evidence |
|---|---|---|---|
| PRE-01 | Curated source, private repository, guidance and CI / coordinator | In progress | Private visibility confirmed; reviewed initial commit; personal records and secrets excluded; source guard and current regression results recorded |
| PRE-02 | OpenClaw write/PR exercise / Hetzner worker | Ready after PRE-01 and explicit dispatch | Independent persistent clone/worktree; scoped result document; assigned check runs; branch pushed and linked PR opened with execution ID; coordinator reviews it |
| PRE-03 | Hermes write/PR exercise / Hermes worker | Ready after PRE-01 and explicit dispatch | Persistent clone/worktree; agent commits a scoped report and exports a Git bundle; coordinator verifies/imports/pushes it and opens the PR; actual runtime limitations recorded |
| PRE-04 | Previous-app visual and mobile reference / coordinator | Desktop reference and acceptance recorded; responsive implementation remains | [Reference and mobile acceptance](../docs/design/REFERENCE_UI.md); real-device checks remain outstanding |
| PRE-05 | Durable pilot contracts and first implementation slices / coordinator | Ready after PRE-01; incorporate PRE-04 UI decisions | Owned attempts/drafts, revisions, idempotency and feedback states specified; objective/audio boundary defined; implementation tasks have paths, dependencies and failure checks |
| PRE-06 | Optional Hermes child exercise / Hermes + one granted child | Deferred until PRE-03 succeeds and a global slot is granted | One child performs a bounded independent exercise; parent reports lifecycle/outputs; slot accounting and separate writing worktree verified; no nested spawning |

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

No remote execution is assigned yet. Global cap: **4 active agents including the coordinator and all children/reviewers**. Hermes child budget: **0** until PRE-06 is explicitly dispatched.

| Task | Execution ID | Owner / host | Slot | Branch / base SHA | Checkpoint / expiry UTC | Issue / PR |
|---|---|---|---|---|---|---|
| PRE-01 | Coordinator records at dispatch | Local coordinator | 1 | Initial baseline in progress | Session-managed | Pending repository creation |

Update status only from observed evidence. Distinguish a tooling inventory, a successful agent exercise, and a verified product behavior.
