# <TASK-ID>: <concrete outcome>

## Specification

- Status: candidate / ready / assigned / working / review / blocked / done
- Owner role:
- Dependencies and evidence that they are complete:
- Goal and learner benefit:
- Allowed paths (specific files or exclusive directories):
- Shared files reserved by this task:
- Out of scope:
- Contract/specification references and versions:
- Required runtime and host capabilities:

## Current assignment — coordinator writes

- GitHub issue:
- Execution ID (unique for each assignment/reassignment):
- Owner agent and host:
- Global slot(s); parent/child relationship if any:
- Base commit SHA:
- Branch: `codex/<task-id>-<execution-id>-<slug>`
- Independent clone and worktree:
- Temporary paths and test port(s), if needed:
- Issued at / next checkpoint / expires at (UTC):
- Child allowance: 0 unless explicitly granted; no nested spawning
- Revoked or superseded execution, if any:

The worker acknowledges this assignment on the issue before editing, or returns the acknowledgement to the coordinator for relay when it has no GitHub access. Record checkpoints there. Only the coordinator renews, changes or revokes the assignment. Expired/revoked executions stop new work and pushing; stale work cannot merge. Preserve the checkout and report it.

## Acceptance and evidence

- [ ] <Observable behavior and the check that establishes it>
- [ ] <Failure/recovery or boundary case relevant to the change>
- [ ] <Existing regression checks relevant to the changed paths>
- [ ] <UI task: previous-app visual reference and phone/desktop evidence>

List exact commands where known. For manual checks, specify the steps and expected observation. Do not turn human design/content approval into a claimed automated test. Distinguish fixtures, browser emulation and real-device results.

## Review and integration

- Independent reviewer:
- Required coordinator decisions before editing:
- Merge prerequisites:
- Rollback/revert considerations, if material:
- PR and final evidence:

Use the [handoff template](HANDOFF_TEMPLATE.md). The coordinator updates the [board](BOARD.md) after integration. A green check alone does not override path, scope, lease or review requirements.
