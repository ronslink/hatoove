# PRE-02: OpenClaw worker handoff

Completed historical dispatch. [Issue #1](https://github.com/ronslink/hatoove/issues/1) is closed; worker commit `54be708` was independently reviewed and merged through [PR #3](https://github.com/ronslink/hatoove/pull/3) as `29d5da2`. This file does not authorize another run.

- Execution: `pre02-20260930-a`
- Owner: OpenClaw on Hetzner; global slot 2; no children.
- Issued: 2026-09-30 16:54 UTC. Checkpoint: 17:09 UTC. Expires: 17:54 UTC.
- Base: `2feaba6f315450230a0c7112681a4a47b463f1ce`
- Branch: `codex/pre-02-openclaw`
- Worktree: `/root/workspaces/hatoove-pre-02`
- Allowed tracked change: `work/exercises/PRE-02/pre02-20260930-a/RESULT.md` only.
- Temporary task files may use this worktree's ignored `.qa/` directory.

Read AGENTS.md and docs/AGENT_WORKFLOW.md. Acknowledge this execution on the assigned GitHub issue before editing. Confirm the exact branch, base and worktree. Do not run other agents, live model benchmarks, application servers, deployment, package installation or credential/config discovery. Do not edit product code, central board or any other tracked path. Do not change global configuration.

Run `node tools/repository-check.mjs`, `node tools/check.js`, `node tools/writing-check.js`, and `node tools/feedback-check.js`. Capture actual outcomes and runtime versions in the allowed report. Distinguish an agent preflight from product verification. Record any failures; do not repair source.

Create the report, stage only it, rerun the repository guard on the staged snapshot, and commit using a repository-local or per-command agent identity. Push only the assigned branch and open one PR against main, linked to the assigned issue. Use `gh --body-file` for multiline bodies. Do not merge. Return acknowledgement, report path, final SHA, PR URL, check counts and limitations. Stop when done; preserve the worktree. Stop work if this assignment expires.

This dispatch authorizes the worker's issue acknowledgement, progress comments and scoped PR. It does not authorize external chat/email delivery. The coordinator independently inspects the branch before integration.
