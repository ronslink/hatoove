# PRE-06: One Hermes child, bounded capability check

Completed historical dispatch. [Issue #5](https://github.com/ronslink/hatoove/issues/5); [coordinator-verified result](exercises/PRE-06/pre06-20260930-a/RESULT.md). Exactly one synchronous read-only child completed. No ongoing child allocation remains; this file does not authorize another run.

- Execution: `pre06-20260930-a`
- Owner: Hermes parent, slot 2; exactly one granted child, slot 3; coordinator slot 1.
- Lease: dispatch through 2026-09-30 18:15 UTC; run budget 180 seconds.
- Parent checkout: `/opt/data/workspaces/hatoove/.worktrees/pre06-parent`, branch `codex/pre-06-hermes-parent`.
- Child checkout: `/opt/data/workspaces/hatoove/.worktrees/pre06-child`, detached at `2feaba6f315450230a0c7112681a4a47b463f1ce`.
- Both checkouts are pre-created and owned by UID/GID 10000. No tracked edits are allowed.
- Parent may write one handoff file: `/projects/hatoove-handoff/pre06-20260930-a.md`.

Read AGENTS.md. PRE-03 commit/bundle handoff has succeeded and been independently inspected. This explicit grant permits exactly one child for this exercise, overriding the normal zero-child allocation only for this run. Do not spawn grandchildren, multiple children, replacement children or other processes/servers. No live benchmarks, credential/config inspection, installs, Git mutations, push, merge or deployment. Do not use sudo.

Use the actual `delegate_task` tool once to spawn exactly one child. Give it this self-contained task:

"Your only task is read-only verification in `/opt/data/workspaces/hatoove/.worktrees/pre06-child`. Do not delegate. Explicitly run your terminal command from that exact directory. Report `pwd`, `git rev-parse HEAD`, `git status --porcelain`, and the result of `node tools/writing-check.js`. Read AGENTS.md and report the project-wide agent cap and the no-speaking pilot scope. Do not edit files, inspect credentials/config, access network, install, commit or start servers. Return the marker HATOOVE-CHILD-PRE06, actual check count, exact worktree/base and any limitation. Your parent cannot substitute its own results for yours."

Wait for actual child completion. Use returned child/delegation identifiers and status as evidence; do not claim that a requested spawn is a completed spawn. If the delegate tool is unavailable or errors, stop and report the limitation without simulating it.

Parent verifies the returned checkout/base match the assignment and both worktrees remain clean. Write the handoff file with acknowledgement, actual delegation/child ID, completion status, child answer/checks, observed child count, separate worktree paths and limitations. If the child has not completed by wrap-up, stop it with the tool and report the partial state. Return the report path and concise outcome; stop the session. No Git commit is needed for this read-only child exercise. The coordinator will inspect and preserve the result.
