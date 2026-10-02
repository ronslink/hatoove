# Hatoove agent workflow

The local coordinator owns architecture, contracts, integration and the major learner journey. OpenClaw on Hetzner and Hermes in Docker perform bounded tasks and independent checks. The objective is a multi-user SaaS pilot using the supplied Hatoove designs, with mobile support and removal of the old single-user schema/runtime. [PILOT_BUILD_PLAN](../PILOT_BUILD_PLAN.md) governs scope, [MASTER-PLAN](../MASTER-PLAN.md) sets order and records progress, and [MFP-DESIGN-DECISIONS](../work/implementation/MFP-DESIGN-DECISIONS.md) governs required screens/states, R11/R13–R16, fonts and design acceptance. The writing-first `FUNCTIONAL-ROADMAP` is withdrawn (MASTER-PLAN §10). DESIGN-WIRE-01 is the broader reference inventory, not a fourteen-screen launch assignment.

Use the [revised implementation plan](../IMPLEMENTATION_PLAN.md), [board](../work/BOARD.md), [task template](../work/TASK_TEMPLATE.md) and [handoff template](../work/HANDOFF_TEMPLATE.md). Product requirements remain in the [pilot plan](../PILOT_BUILD_PLAN.md). This workflow does not authorize publication, deployment or live domain changes.

The [dispatch runbook](AGENT_RUNBOOK.md) records the installed one-shot interfaces, persistent paths, non-root Hermes ownership requirement and credential-free Git bundle handoff.

**Runtime:** use Docker Compose for the server stack. Host-only installation/bootstrap scripts are retired; test against isolated Compose projects and synthetic records. Never remove an existing volume as setup.

## Canonical local location

New local work uses `D:\Hatoove`; coordinator tasks/results use `D:\Hatoove\handoff\ron-agent`. Follow [WORKSPACE_LOCATION](WORKSPACE_LOCATION.md) for relocated designs and recovery evidence. The original heartbeat remains paused, and no old lease is renewed by the move. Independent remote/container checkouts remain independent.

## Hosts and current evidence

| Host | Verified inventory | Still to prove |
|---|---|---|
| Local coordinator | Canonical source: `D:\Hatoove`; private baseline published; 124 offline checks and Linux/Windows CI passed | Product implementation and device evidence |
| Hetzner, SSH alias `hetzner` | OpenClaw 2026.8.2, Node 22, Git and `gh`; GitHub identity `ronslink`; actual scoped worker run, 124 checks and [PR #3](https://github.com/ronslink/hatoove/pull/3) reviewed/merged | Product-specific task capability; unrelated filesystem MCP/memory startup warnings remain outside this setup |
| Local Docker `hermes-agent` | Hermes 0.21.1, Node 26, Git; persistent `/opt/data`; `G:/Hermes/Projects` mounted at `/projects`; actual worker run, 124 checks, commit/bundle and [PR #4](https://github.com/ronslink/hatoove/pull/4) verified after fixing project ownership to UID/GID 10000; [one synchronous read-only child](../work/exercises/PRE-06/pre06-20260930-a/RESULT.md) verified | Browser tooling, multi-child concurrency and child writing handoff; no direct GitHub login |

Inventory is not proof of agent execution or delegation. Prove each worker's write/PR path with the preparation exercises before assigning product implementation. Hermes has no working GitHub credential in the initial probe. Its approved handoff is a Git bundle through `/projects/hatoove-handoff`, imported and reviewed by the coordinator, who pushes the branch and opens the PR. Do not copy host tokens or SSH keys into the container. Keep credentials out of logs, task records and source.

The private GitHub repository [ronslink/hatoove](https://github.com/ronslink/hatoove) has been created and its private visibility verified. The coordinator publishes the curated initial commit before remote clones start. GitHub task records, PRs and merged source are the shared record; chat is for dispatch and discussion, not the only record of a decision.

## Ownership and concurrency

- The coordinator is the only assignment writer and integration owner. Workers do not self-claim tasks or edit the shared board.
- Start with a global cap of **four active agents total**, counting the coordinator, workers, reviewers and all children on every host. The usual allocation is coordinator + OpenClaw + Hermes, with one spare slot for an independent reviewer or approved child.
- Hermes has a child budget of **zero** until a delegation exercise succeeds and the coordinator grants one slot. No nested spawning. An active parent and child count separately.
- PRE-06 has now demonstrated one synchronous read-only child. Future tasks may request a single child slot; grants remain explicit and expire with the task. Multiple simultaneous children and child code-writing handoffs have not been validated.
- Record active slots with each assignment. A blocked agent holding an active process still occupies its slot until stopped or explicitly made idle.
- Each host uses an independent clone. Every writing task has its own branch and worktree; never share a checkout between agents. Children that write need their own worktree. Use task-specific temporary directories and test ports.
- Keep remote working copies in persistent host storage. OpenClaw uses `/root/workspaces/hatoove` and Hermes uses `/opt/data/workspaces/hatoove`, each with task-specific worktrees beside the clone. The G-drive mount is for bundles/reports, not a shared writable checkout. The separate `D:\B1_Prep` copy is not the canonical source.
- Each task lists exact allowed paths. Reserve shared files such as `public/js/exam.js` for one active implementation task at a time. Cross-cutting changes and interface extraction belong to the coordinator.

## Dispatch and recovery

The coordinator records one current assignment on the linked GitHub issue using the task template. It includes a unique execution ID, owner/host, base SHA, branch, allowed paths, acceptance checks, occupied slot, checkpoint and expiry in UTC. Workers acknowledge that record before editing. For Hermes, the coordinator relays its returned acknowledgement/checkpoints onto the issue because it has no GitHub access. A label or an uncoordinated edit to a shared file is not a claim.

1. Confirm dependencies, specification, path ownership and slot availability. Dispatch only then.
2. Worker uses a verified worktree from the specified base SHA and works on the assigned branch. It records material decisions and checkpoints on the issue, and opens a linked PR when ready. A coordinator may prepare the worktree and relay these records; a bundle handoff preserves the worker commit SHA and is reviewed before the coordinator pushes it.
3. Default checkpoint interval is 15 minutes while active; default assignment expiry is 60 minutes after the latest coordinator-issued lease or renewal. Worker checkpoint comments do not silently extend an expired assignment. The coordinator can set a longer interval for an identified long-running check.
4. On expiry or revocation, stop new work and pushing; preserve the worktree and report its state. The coordinator marks the execution stale. Do not automatically reassign: first confirm the old process stopped or explicitly revoke its execution and merge eligibility. A replacement gets a new execution ID and branch.
5. A stale execution cannot merge, even if its tests pass. Useful work can be inspected and explicitly adopted by the coordinator under the current task. Never force-push away another execution's work.

These are session operating rules, not a request to create timers, recurring jobs or deployment automation. If the coordinator is unavailable, an expired worker waits with its work preserved.

## Review and integration cadence

At the start of a work session, the coordinator refreshes the board and main branch, checks host availability and assigns ready work. During the session, workers report checkpoints, blockers and review readiness; the coordinator handles contract questions and PR review as they arrive. At the end, record completed work, live executions, blockers and the next ready tasks.

Every PR links its task and execution ID, reports changed paths and actual test results, and distinguishes verified behavior from limitations. UI PRs include desktop and phone evidence against the supplied design reference and declared functional states. An agent does not approve its own implementation. The coordinator merges in dependency order after independent review, current-base checks and resolution of required findings, then updates the board. Workers do not push directly to main.

GitHub's branch-protection API returned HTTP 403 on 30 September 2026: this private repository needs GitHub Pro for that feature. Keep the repository private. CI is active, but PR-only integration, review, assignment leases and concurrency are coordinator-enforced operating rules, not GitHub-enforced permissions. No account upgrade or visibility change is part of setup. Existing host credentials are not claimed to be narrowly scoped worker identities.

Do not run live AI, email or payment calls to prove ordinary changes. Use fixtures or stubs and report what they establish. The recorded regression baseline is `node tools/check.js` (101), `node tools/writing-check.js` (9) and `node tools/feedback-check.js` (14); rerun relevant checks and report current results rather than assuming those counts remain unchanged.

## Product work after preparation

Begin each implementation task when its dependencies and concrete specification are ready. Adopt the new shared design system, adapt every retained view for phones/tablets, and retain the Node/Postgres pilot direction. Remove old singleton/file/blob persistence and local-user compatibility through the ordered SaaS cutover; do not copy those assumptions into new screens. Do not start a framework migration or restore the older Workers/D1 proposal as an incidental task choice.

The coordinator owns the first-release journey: email/password account entry and recovery, exam/date/language setup, task discovery, saved writing drafts, durable pending/failed/assessed feedback, history/revision, export/delete and return on another device. Objective practice is conditional MFP-13; fixed listening audio and broader practice follow later. Workers can supply scoped responsive fixes, reviewed fixtures, content audits and independent recovery checks. Avoid simultaneous changes to the same legacy module.

Mobile acceptance includes narrow layouts, touch controls, the onscreen keyboard, fixed-audio loading/recovery and draft preservation. Browser viewport checks do not substitute for iPhone Safari and Android Chrome device evidence. Keep those evidence types separate. Writing acceptance includes refresh/navigation/network interruption, duplicate submission, pending/failed feedback, preserved original and revision, and one successful entitlement debit.

Speaking, production publication and live domain traffic remain outside this preparation and pilot implementation workflow. Record any scope or architecture decision in the task/PR before dependent work proceeds.
