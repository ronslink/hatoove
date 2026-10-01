# Canonical local workspace

Ron requested relocation to **D:\Hatoover** on 1 October 2026. Use that exact spelling for new local work. This is the local checkout of the existing private repository, not a new GitHub project or an application hosting change.

| Material | Current location |
|---|---|
| Code and tracked plans | D:\Hatoover |
| Git remote | https://github.com/ronslink/hatoove.git |
| Original design inputs | D:\Hatoover\design |
| Coordinator inbox, task queue and reports | D:\Hatoover\handoff\ron-agent |
| Collected Hermes handoffs | D:\Hatoover\handoff\hermes-transfer |
| Local migration inventory, patches, refs and evidence | D:\Hatoover\.qa\migration\20261001 |

The checkout begins from reviewed plan commit 626c126, which contains integration 199dc0b. Runtime-composition PR #89 remains a separate unverified branch; relocation does not merge it. Preserve existing PRs and branch history, and use one separate checkout per concurrent writer.

The OneDrive checkout, its linked worktrees, D:\hatoove-work and the older D:\Hatoove clone are recovery sources, not the working location for new assignments. The latter was held open and could not be renamed, so an independent Git copy was created at the requested destination. Original sources remain intact; no automatic cleanup or worker interruption was performed. This chat and previously saved app project entries may still display their old path; select/open D:\Hatoover for new local chats, and use an explicit working directory here.

The design manifest records the original input location plus the new source location. Treat design files as reference inputs; curate licensed assets into tracked public assets when implementing. Local design originals, handoffs, private evidence, raw provider runs, machine state and recovery bundles are excluded from commits. The live D:\B1_Prep install, credentials and learner records have not been migrated into application source.

The appointed coordinator still owns assignments, leases and integration. Read the new handoff location before dispatch. No lease is renewed by relocation. The original Codex heartbeat remains paused; its saved paths are updated without resuming it.

Hermes and OpenClaw keep their independent host checkouts. Hermes's existing G-drive Docker mount remains a transport inbox; copy task/result files between it and the canonical handoff as needed. Do not mount the canonical working tree for concurrent editing or change unrelated container configuration merely to move the Windows repository.

## Recovery

The ignored migration directory contains a hash manifest, snapshots of the 36 previously registered worktrees, the additional standalone repositories, staged/unstaged patches, saved untracked source, and Git history. Imported refs use refs/archive/migration-20261001/ and must not be pushed indiscriminately.

To resume a preserved edit, use its recorded HEAD in a separate checkout and inspect/apply the matching staged and unstaged patches plus saved untracked files. Do not copy archived .git directories over the canonical repository: their metadata retains historical absolute worktree paths. Original sources remain available for comparison. Account data and credentials are not a substitute for synthetic test fixtures.
