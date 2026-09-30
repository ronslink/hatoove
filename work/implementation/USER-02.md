# USER-02 / PILOT-01-CSS: responsive verification and bounded fixes

Status: assigned to Ron-controlled local agent, slot 4; execution user02-20260930-a. No children.
Base: 5e75ec59d1889fb46a161cdf1af0363ae68f0416. Branch codex/pilot-01-css-user02. Managed worktree <user-home>/.codex/worktrees/pilot01-css-user/B1_Prep.
Issued 2026-09-30 17:48 UTC; checkpoint 18:03 UTC; expires 18:48 UTC. This supersedes the completed USER-01 read-only grant, not its evidence.

Read AGENTS.md, docs/AGENT_WORKFLOW.md, docs/design/REFERENCE_UI.md and work/implementation/PILOT-01-CSS.md in your assigned worktree, plus this current issue assignment. Acknowledge execution, branch/base and clean source-only checkout to Ron before editing.

Do these tasks in order:
1. Reproduce D2/D5/D6/D8 in a browser at the viewports below and capture before evidence. Correct false positives. D3 is already handled by source; do not add its proposed JS fix. D2's arithmetic is not proof of overflow. D8 already has a focus box shadow; assess it honestly.
2. Make the smallest verified appearance-preserving CSS fixes. Allowed writes ONLY public/studio.css, public/styles.css and work/implementation/USER-02/** (report and synthetic screenshots). No JS, HTML, auth, backend, dependency, board, or other source changes. public/js/exam.js is reserved by coordinator. Preserve the navy/light learner appearance and desktop reference. Do not change the marketing site or implement keyboard viewport metadata from assumptions.
3. Recheck and report viewport/function results, changed paths, commits, unresolved findings and a real-device checklist. As a read-only follow-up, reproduce drawer resize and Escape/X focus behavior if feasible; record it, do not edit app.js.

Browser isolation: confirm no .env exists in your worktree and no existing personal progress is present. Only this source-only checkout may run. For a local source server use B1PREP_FORCE_OFFLINE=1, B1PREP_PORT=55437 and B1PREP_PROGRESS_FILE=<your worktree>/.qa/user02-20260930-a/progress.json, initialized with synthetic state only. Start node server.js from this checkout, with background windows hidden. Do not use port4321, the canonical learner app or generic browser scripts. Do not read/copy any real .env/progress/browser profile or use D:/B1_Prep. No live AI, learner TTS, microphone, email/payment, deployment or other-project actions. If safe browser access is unavailable, preserve work and report the missing evidence; never invent screenshots.

Acceptance: before/after at 320x568,390x844,768x1024,1024x768,1180x820,1280x800; include 200% text zoom check. Measure document scrollWidth<=clientWidth, stat text overlap, full passage access and visible keyboard focus in light/dark theme. Verify desktop appearance against reference; do not impose breakpoint changes that alter1280 without evidence. Real iPhone/Android keyboard/audio remains open and separate from emulation.

Run node tools/check.js; node tools/writing-check.js; node tools/feedback-check.js. Stage only allowed source/evidence paths, inspect staged names, run node tools/repository-check.mjs and git diff --cached --check before committing. Never stage .qa, runtime progress, browser state or generated bundles. Screenshots must contain only synthetic data. Stop your own test server after evidence capture.

Commit to assigned branch; no force push, main updates or merge. If GitHub access works, push the branch and create a draft PR targeting codex/pre-05-runtime-contracts (stacked pending its integration); attach the PR in your chat. Otherwise report the local commit to Ron for coordinator handoff. Coordinator reviews independently, retargets after dependency merge and controls integration. Return acknowledgement/checkpoint/final report to Ron; no unsolicited messaging of other chats.
