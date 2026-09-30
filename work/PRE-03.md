# PRE-03: Hermes worker handoff

Completed historical dispatch. [Issue #2](https://github.com/ronslink/hatoove/issues/2) tracks the stopped ownership-failure attempt and this successful retry. Original worker commit `b7db454` was verified unchanged from its bundle and independently reviewed through [PR #4](https://github.com/ronslink/hatoove/pull/4). This file does not authorize another run.

- Execution: `pre03-20260930-b`
- Owner: Hermes in `hermes-agent`; global slot 3; no children for this exercise.
- Issued: 2026-09-30 16:59 UTC (actual dispatch; initial retry text used 17:01). Checkpoint: 17:16 UTC. Expires: 18:01 UTC.
- Base: `2feaba6f315450230a0c7112681a4a47b463f1ce`
- Branch: `codex/pre-03-hermes-b`
- Worktree: `/opt/data/workspaces/hatoove-pre-03`
- Allowed tracked change: `work/exercises/PRE-03/pre03-20260930-b/RESULT.md` only.
- Allowed export: `/projects/hatoove-handoff/pre03-20260930-b.bundle`.
- Temporary task files may use this worktree's ignored `.qa/` directory.

Read AGENTS.md and docs/AGENT_WORKFLOW.md. Acknowledge this execution at the start of your response for coordinator relay to its GitHub issue. Confirm the exact branch, base and worktree before editing. Do not delegate, run live model benchmarks, start application servers, deploy, install packages, inspect credentials/configs or attempt GitHub authentication. Do not edit product code, central board or other tracked paths. Do not change global configuration.

Run `node tools/repository-check.mjs`, `node tools/check.js`, `node tools/writing-check.js`, and `node tools/feedback-check.js`. Capture actual outcomes and runtime versions in the allowed report. Distinguish an agent preflight from product verification. Record failures; do not repair source.

Create the report, stage only it, rerun the repository guard on the staged snapshot, and commit using the repository-local agent identity already set. Export your branch with `git bundle create /projects/hatoove-handoff/pre03-20260930-b.bundle codex/pre-03-hermes-b`. Verify the bundle and return its path, final SHA, report path, counts and limitations. No push or merge. Stop when done; preserve the worktree. Stop work if this assignment expires.

The coordinator will relay your acknowledgement/results, verify and import the bundle without changing its commit, push the branch and open the PR for independent review. GitHub credentials are not needed in the container.

Assigned issue: https://github.com/ronslink/hatoove/issues/2
The previous execution stopped after checks because the coordinator-created clone/worktree was root-owned. It made no commit. The coordinator has corrected ownership to UID/GID 10000, verified both worktree and Git metadata are writable as that user, and prepared the fresh branch above. Do not use sudo or investigate privilege escalation. Complete the scoped report/commit/bundle; return any new blocker immediately.
