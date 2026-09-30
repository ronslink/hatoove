# Hatoove agent instructions

## Product and design

Hatoove is standalone exam preparation, initially for telc Deutsch B1 reading, language elements, listening and writing. Speaking, STT, school administration and overall-exam pass predictions are outside the pilot. Follow `IMPLEMENTATION_PLAN.md` for delivery and `PILOT_BUILD_PLAN.md` for product direction. The revised implementation plan supersedes the pasted 36-package proposal; it is not an instruction to migrate hosting or rewrite the app.

Preserve the previous learner app in `public/` as the visual foundation after login. The user likes its appearance. Adapt it for phone and tablet use; do not replace it with the marketing page. Keep the orange Hatoove and preferred oo identity. Each UI change needs desktop and mobile evidence; emulated viewports do not replace iPhone/Android keyboard and audio checks.

## Coordination

**Coordinator ownership (2026-09-30, issue [#27](https://github.com/ronslink/hatoove/issues/27)).** Ron
appointed his locally controlled agent as coordinator, taking over coordination between the Hetzner OpenClaw
agent and the local Docker Hermes agent. That instruction **supersedes earlier wording that only the original
Codex chat could coordinate**. The coordinator owns architecture, shared contracts, major learner journeys,
bounded task assignment, scope/lease decisions, central records, integration and user updates, and may
implement work directly. The original coordinator's own implementation is paused; its unfinished changes stay
preserved and unmerged. Coordination continues until Ron changes it, but **each worker execution still needs
its own explicit bounded lease**.

The Hetzner OpenClaw agent and local Docker Hermes agent take bounded assignments and independent reviews.
Read `docs/AGENT_WORKFLOW.md` and the assigned task before editing.

Only the coordinator assigns tasks, changes the central board and determines merge order. A task has one
active owner and an execution ID, base commit, branch, allowed paths, acceptance criteria and next checkpoint.
Workers acknowledge the assignment before editing. A stale assignment does not authorize continued edits or a
merge. Preserve work and report blockers; do not silently abandon or overwrite it.

**A reviewer must not be the author of the slice under review.** The coordinator maintains `CURRENT.md` and
`QUEUE.md` in the shared handoff every five minutes without sending repetitive chat updates, and updates
`IMPLEMENTATION_PLAN.md` and `work/BOARD.md` together after meaningful transitions. Keep status labels
distinct: **delivered ≠ independently reviewed ≠ green CI ≠ merged ≠ product accepted.**

Start with at most four active agents across all hosts, counting coordinator, parents, children and reviewers.
Hermes child spawning is disabled for this project until capability checks succeed and the coordinator
allocates a slot. No recursive delegation by workers. A child that edits files gets a separate
checkout/worktree and branch, even when its container is shared. Never assume conversation isolation means
filesystem isolation.

## Git and file ownership

The private repository is `ronslink/hatoove`. Use a separate clone on each host and a separate worktree for every concurrent writing task. Never share a writable checkout through OneDrive or the G drive between running agents. Branches use `codex/<task-id>-<description>`. After the initial baseline, integrate through pull requests; never force-push main or rewrite another worker's branch.

Edit only assigned paths. Ask the coordinator to resolve overlaps or interface changes before editing shared files. In particular, `public/js/exam.js` must not have concurrent owners. Do not mark content approved; qualified human review remains necessary. The coordinator may resolve routine implementation choices within the user's authorized scope without asking Ron again.

Do not commit credentials, learner records, machine configuration, agent memory, raw provider runs, private browser state or the older `D:\B1_Prep` checkout. Run `node tools/repository-check.mjs` on the staged snapshot before pushing. It catches common problems, not every possible secret. Review the staged file list as well.

## Validation and boundaries

Safe offline baseline commands:

```text
node tools/check.js
node tools/writing-check.js
node tools/feedback-check.js
```

The recorded baseline is 101 + 9 + 14 passing checks. These test legacy behavior, not exam validity. Add focused tests for changed behavior; do not preserve an incorrect exam rule just to retain a test result.

Do not run live AI or recovery scripts as automatic setup. The current `server.js` reads `.env` even in offline mode, and the provider key is server configuration that must never be settable or readable from a browser. Browser tests require a disposable source-only checkout, synthetic progress and explicitly isolated ports. Never point generic tests at the learner's existing app. The portable-build, synchronization and file-recovery scripts are **removed**: this is a hosted application with one authoritative server copy.

Keep reviewed tasks/audio versioned, mark objective answers deterministically, preserve unassessed writing failures and save drafts/submissions/results/revisions. The saved DeepSeek benchmark supports provisional formative feedback, not calibrated readiness scores. Runtime fallbacks need separate evaluation.

An independent reviewer checks the diff and evidence before integration. Security-sensitive code requires the human reviews specified in its task. Preparing code and local tests is authorized; publishing the site, changing live DNS, production deployment, live payments and new production access require explicit user authorization. This repository has no deployment workflow.

Report the task/execution ID, commit or PR, tests, screenshots where relevant, outstanding risks and next action. A code change is not done merely because an agent returned a summary.
