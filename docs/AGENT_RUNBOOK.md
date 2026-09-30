# Dispatch and handoff commands

Read [AGENT_WORKFLOW.md](AGENT_WORKFLOW.md) first. These are manually dispatched session commands, not a background scheduler. The coordinator records the task/lease on GitHub and verifies the worktree/branch/base before a worker edits. Never reuse an active worker's checkout for another assignment.

## OpenClaw on Hetzner

The existing SSH alias is `hetzner`. Its persistent source clone is `/root/workspaces/hatoove`; preparation used `/root/workspaces/hatoove-pre-02` as a separate worktree. The installed `openclaw agent exec` accepts both an explicit working directory and a UTF-8 task file:

```sh
openclaw agent exec --cwd /absolute/task/worktree --message-file /absolute/task/dispatch.md --timeout 240 --json
```

Use the configured model/provider. Do not pass `--deliver` or route the response to Telegram/Discord. Capture output in the worktree's ignored `.qa/` area. A bounded deadline does not replace checking actual completion. Verify the returned report, commit and PR with Git/GitHub; a success summary alone is insufficient.

OpenClaw can use the host's existing authenticated `gh` to acknowledge its issue, push the assigned branch and open a PR. Use `--body-file` for multiline messages. The coordinator reviews and merges; the worker never merges or changes main.

## Hermes in local Docker

Container: `hermes-agent`. Persistent source clone: `/opt/data/workspaces/hatoove`. Initial task worktree: `/opt/data/workspaces/hatoove-pre-03`. The bind mount `/projects` corresponds to `G:/Hermes/Projects`; use `/projects/hatoove-handoff` only for task files, bundles and reports, not concurrent editing.

The installed one-shot interface is:

```text
docker exec hermes-agent hermes chat --in /absolute/task/worktree --query-file /projects/hatoove-handoff/task.md --oneshot --max-turns 16 --run-budget 240 -t terminal,file -Q
```

This parent-only toolset does not include delegation. Do not use `--yolo` or blanket hook approval. The configured Hermes host allows more child concurrency and depth than this project; the project allocation remains authoritative. A child exercise requires a separately recorded grant and evidence of its actual lifecycle. Context isolation is not filesystem isolation.

Hermes has no working GitHub login in this setup. Exchange commits without transferring credentials:

1. Coordinator creates an execution-specific ignored scratch directory and exports the approved branch with `git bundle create .qa/<execution-id>/baseline.bundle main`, verifies it and copies it to `/projects/hatoove-handoff`. For a fresh clone, explicitly use `git clone --branch main /projects/hatoove-handoff/baseline.bundle /opt/data/workspaces/hatoove`. The initial clone without `--branch` lacked a default reference and required correction. Always confirm that exported `main` and the resulting checkout equal the assigned base SHA; synchronize the local branch first if necessary.
2. Prepare or update Hermes's persistent clone, then create a task-specific worktree/branch from the exact assigned SHA. Hermes's terminal/file tools were observed running as UID/GID 10000, whereas default `docker exec` ran as root. Ensure only the dedicated Hatoove clone, Git metadata and worktree are owned/writable by the agent user; verify with `docker exec --user 10000:10000 ... test -w <path>`. The initial preflight failed on this ownership mismatch. Set a repository-local agent commit identity if needed. No global Git changes or sudo workaround.
3. Before dispatch, also verify as UID/GID 10000 that the dispatch file is readable and `/projects/hatoove-handoff` is writable. Worker stages only its allowed paths, runs the repository guard, commits and exports its assigned branch with `git bundle create /projects/hatoove-handoff/task.bundle codex/task-branch`.
4. Coordinator copies the returned bundle into ignored local scratch, runs `git bundle verify`, fetches only its expected branch into a new local branch, and checks base ancestry, every new commit's diff, file scope and source guard. Bundle verification does not check secrets; a final-tree diff can miss files added and later deleted. Screen every new committed snapshot before pushing. PRE-03 must contain exactly one new report-only commit. Preserve the worker's commit.
5. Coordinator pushes that branch, opens and attaches the PR, relays the worker's acknowledgement/results to the issue, and obtains independent review before merging.

The baseline clone and task branches can persist between sessions. Bundles and local logs are not canonical completion records: the reviewed GitHub PR, task issue and board are. Record blocked or timed-out runs honestly and stop the old process before issuing a replacement execution.
