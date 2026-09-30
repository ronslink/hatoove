# F-8-PATHS-01 — neutralise local machine paths in docs (privacy audit finding F-8)

Worker: Claude for Windows · Branch: `codex/f8-paths-01` · Base: `798f5d29f6568adefbc8aa5b11edba331aaf7686`

Informational finding. The repository is private and none of the replaced text is a credential. The only change is
that the Windows account name no longer appears in tracked documentation within this task's allowed paths.

## Placeholder convention

`<user-home>` stands for the coordinator machine's Windows profile directory (the per-account folder on drive C:).
Only that prefix was replaced. Everything after it (`OneDrive\Documents\ChatGPT\B1_Prep`,
`.codex/worktrees/<name>/B1_Prep`, `.codex/hatoove-handoff/ron-agent/...`) is unchanged, so worktree names, the
handoff layout and the fact that the canonical source sits in a OneDrive folder are kept. No command in the changed
files uses these paths. `<repo>` and `<worktree>` were not needed.

No claim was reworded. Each edit replaces the prefix only.

## Changes

| File | Line(s) | Replaced |
|---|---|---|
| `DESIGN_NOTES.md` | 18 | development copy path |
| `PILOT_BUILD_PLAN.md` | 70 | development checkout path |
| `docs/AGENT_WORKFLOW.md` | 13 | canonical source path |
| `work/implementation/F02-A01.md` | 3 | reused worktree path |
| `work/implementation/PRE-05.md` | 5 | managed worktree path |
| `work/implementation/USER-02.md` | 4 | managed worktree path |
| `work/implementation/USER-03.md` | 4, 9 | worktree path; handoff report directory |
| `work/implementation/USER-04.md` | 5 (x2) | worktree path; ACK path |

`AGENTS.md` and `docs/REPOSITORY_BASELINE.md` were in scope but contain no username or user path, so they are unchanged.

## Deliberately kept (not user paths)

- **`D:\B1_Prep`** (`AGENTS.md:23`, `DESIGN_NOTES.md:18,24`, `docs/AGENT_WORKFLOW.md:29`,
  `docs/REPOSITORY_BASELINE.md:3`). It contains no account name and is not under a user profile. It is the installed
  application location and is load-bearing elsewhere: default parameters in `tools/install-academy.ps1` and
  `tools/build-portable.ps1`, `README.md`, `portable/README.txt` and the `.env` commands in
  `research/deepseek-feasibility/README.md`. The `AGENTS.md` exclusion rule names it so that copy is never committed.
  Replacing it only in docs would make those statements disagree with the scripts.
- **The word "OneDrive"** (`AGENTS.md:19`, `docs/REPOSITORY_BASELINE.md:3`, and inside the three `<user-home>\OneDrive\...`
  paths). It names a sync service, not a person or account, and `AGENTS.md:19` is an operating rule.

## Outside this task's allowed paths (reported, not edited)

- `IMPLEMENTATION_PLAN.md:41`: canonical source path with the account name (coordinator-owned).
- `work/BOARD.md:47`: Ron-agent handoff path with the account name (coordinator-owned).

The same `<user-home>` substitution would apply if the coordinator chooses to change them.

## Grep evidence

Task pattern: the dispatch's `git grep -n -i -E` over `AGENTS.md DESIGN_NOTES.md PILOT_BUILD_PLAN.md docs work`, with
alternatives for the account name, `OneDrive`, the profile-folder prefix and `D:\B1_Prep`. It is not repeated here
because this report would then match itself. In this Git for Windows setup, the `D:\B1_Prep` alternative matched
nothing on its own. `D:\B1_Prep` lines showed up
only when another alternative matched the same line. I checked `D:\B1_Prep` separately with `git grep -F`.

Before, 12 files matched, and 10 of them had the account name in a path: the 8 changed files above,
`IMPLEMENTATION_PLAN.md` and `work/BOARD.md`. `AGENTS.md` and `docs/REPOSITORY_BASELINE.md` matched on "OneDrive" only.

After, a case-insensitive grep over the allowed paths, including this report, for the account name and for the
profile-folder prefix with either slash returns no matches (exit 1). The task pattern
now matches only the "OneDrive" and `D:\B1_Prep` lines listed above, `work/BOARD.md:47` and this report's own uses of the word "OneDrive".

## Validation

- `node tools/check.js`: 101 passed, 0 failed
- `node tools/writing-check.js`: 9 passed, 0 failed
- `node tools/feedback-check.js`: 14 passed, 0 failed
- `node tools/repository-check.mjs` on the staged snapshot: passed (257 tracked files, 186 text blobs screened)
- `git diff --cached --check`: clean. CRLF line endings preserved.

These checks cover legacy regression behaviour only. They do not cover this documentation change. The tree still
carries the known open progress-reset race in `server.js` that another worker is fixing. This task does not address it
and makes no claim that the tree is free of known defects.

## Could not verify

- `docs/AGENT_SUPERVISION.md`, named in the dispatch reading list, does not exist at the base commit.
- Git history still contains the old paths. Rewriting history is out of scope and would conflict with the no-force-push rule.
