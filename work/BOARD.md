# Hatoove work board

## Payments implementation — 3 October 2026

**In progress: PAYMENTS-01-20261003-A**, [issue #115](https://github.com/ronslink/hatoove/issues/115), isolated base `c2e2163` (S4 PR114 remains unmerged with hosted CI blocked). The coordinator preserved and adopted a copy of the existing payment prototype, retaining all S4 changes. English is the technical working language; German learner copy remains as specified. The payment implementation contract covers optional test payments, database-owned offers/orders/events/grants, expiry, signed webhook processing and checkout states. Provider code is independently approved at ecb2b4c (23 focused checks); backend 0b5885f and client 57c6e8e are delivered, with independent source review and combined browser acceptance underway. The real signed dispute integration follow-up passes 17 PostgreSQL groups. Local-PC OpenClaw completed the design audit and is reviewing the frozen backend source. Delivery is not green hosted CI, merge or product acceptance. Commercial terms, real payments, human review and physical-device gates remain open. Original canonical draft and learner runtime/data are preserved.

## EXAM-S4 implementation — 3 October 2026

**Delivered and independently reviewed; hosted CI blocked: EXAM-S4-20261003-A**, [issue #113](https://github.com/ronslink/hatoove/issues/113), [PR #114](https://github.com/ronslink/hatoove/pull/114), base `4070269`. Internal DTZ writing has immutable A/B selection, four distinct criterion scales, preserved drafts/submissions/revisions and exam-bound debit. S4 browser 14/14, PostgreSQL 17/17, default telc browser 199/199, Compose 37/37 (OpenAPI 43), deletion 20/20 and submission preservation 9/9 pass. Source `1816c59` has author-separated approval; later retained-test corrections have separate review. GitHub started no CI test steps because of an account billing/spending-limit block. **PR remains unmerged; next action is restoring Actions, rerunning CI and integrating after green checks.** [Contract](../docs/contracts/EXAM-S4.md) and [evidence](implementation/EXAM-S4-RESULT.md) record scopes. Default runtime remains telc-only. Human content/device/product approval and full DTZ release remain gated. Learner runtime/data, paused work and unrelated payment/client changes in canonical main are preserved.

## EXAM-S3 implementation — 3 October 2026

**Merged: EXAM-S3-20261003-A**, [issue #110](https://github.com/ronslink/hatoove/issues/110), [PR #111](https://github.com/ronslink/hatoove/pull/111), merge `4eab9a9`, independently reviewed head `693f4ac`, seven applicable CI jobs green. Five parts/25 original generated reading items, grouped questions, cloze and save-safe two-exam switching follow the [S3 contract](../docs/contracts/EXAM-S3.md). Default learner availability remains telc-only; internal DTZ is exercised only in disposable fixtures. S3 browser14/14, PostgreSQL10/10, default telc browser199/199 and Compose37/37 (OpenAPI42/42) pass. [Evidence](implementation/EXAM-S3-RESULT.md) records exact scopes and fixture repairs. Canonical main is fast-forwarded; all task fixtures are disposed and implementation/review leases closed. Learner runtime/data and paused work are preserved. Human content approval, physical-device, complete DTZ release and product acceptance remain separate. **Next: S4 internal DTZ writing under a new bounded lease.** Earlier next-slice statements below are historical.

## EXAM-S2 implementation — 3 October 2026

**Merged: EXAM-S2-20261003-A**, [issue #107](https://github.com/ronslink/hatoove/issues/107), [PR #108](https://github.com/ronslink/hatoove/pull/108), merge `7960c61`, reviewed head `d05dbb8`, seven applicable CI jobs green. The minimal package importer/release contract and saved telc reading section are implemented. The first form pins the existing LV1/LV2/LV3 versions, contains 20 items and is labelled untimed section practice; complete written mocks remain unavailable. [Contract](../docs/contracts/EXAM-S2.md), [evidence](implementation/EXAM-S2-RESULT.md).

The coordinator integrated package/import validation, local workers' owned runs/client and actual Docker Hermes' corrected source fixtures. Independent findings and the old export-test count are repaired. Browser 199/199, Compose 37/37 (OpenAPI 42/42), package PostgreSQL 15/15 and run PostgreSQL 14/14 pass. Actual Claude's session was unavailable; local author-separated reviews replaced unavailable external review without changing providers. Canonical main is fast-forwarded; the learner preview/data and older paused work remain unchanged. Task fixtures are disposed and execution leases closed. Content/device/security/privacy/provider/product acceptance and complete DTZ publication remain separate. **Next: S3 internal DTZ reading under a new bounded lease.**

## EXAM-S1 and review fixes — 3 October 2026

**Merged and locally verified: EXAM-S1-20261003-A**, [issue #104](https://github.com/ronslink/hatoove/issues/104), base `0d32619`. Actual Claude delivered preparations, exam-specific credits, atomic registration and archive safeguards; actual Docker Hermes delivered readable objective labels, direct catalogue launches and scoped test fixtures. Hetzner OpenClaw and separate local reviewers checked the source; their registration, concurrency and navigation findings have been repaired. Claude hit its session limit during the last fixture pass, which a bounded local follow-up completed without changing its runtime safeguards.

The slice retains telc-only availability, stable preparation identity, preparation-owned dates/history, account-wide explanation preferences and separate exam balances without creation/switching refills. Archived and unresolved drafts preserve readable text while refusing mutations. Readiness checks pass offline and on PostgreSQL; focused S1 PostgreSQL checks pass 11/11 and the shared API passes 34/34 on memory, ephemeral and persistent PostgreSQL. The complete isolated browser walkthrough passes 184/184 and Compose passes 36/36, including the 36-leg OpenAPI surface check. [PR #105](https://github.com/ronslink/hatoove/pull/105) merged at `bcd69b7` after all seven applicable CI jobs passed on independently reviewed head `da1f2fa`. The local Compose app and worker run the merged source; readiness is healthy, migration 0023 is applied, and existing counters, balances and saved-data fingerprints match the private pre-upgrade backup. The reusable review account resumes its preparation. Product acceptance remains separate. [Contract](../docs/contracts/EXAM-S1.md). [Implementation evidence](implementation/EXAM-S1-RESULT.md). **Next: S2 release/importer and saved telc section mock**, in a new implementation chat after S1 completion. Content, physical-device, privacy/security, provider and complete written DTZ acceptance remain separate.


## EXAM-S0 hardening — 2 October 2026

**Merged and locally verified: EXAM-S0-20261002-A**, [issue #101](https://github.com/ronslink/hatoove/issues/101), base `88fa268`. Actual Claude Opus 5.5 delivered the bounded server slice; the coordinator integrated client startup/version binding, explicit Compose preview policy and CI contracts. The combined isolated browser journey passes 144/144, Docker stack 35/35, new offline server checks 8/8 and new PostgreSQL checks 6/6; both new server suites fail against the original code. [Contract](../docs/contracts/EXAM-S0.md) and [implementation evidence](implementation/EXAM-S0-RESULT.md). [PR #102](https://github.com/ronslink/hatoove/pull/102) merged as `5d2b4ac` after all seven applicable CI jobs passed on reviewed head `26273c7`. The local Docker app and worker were refreshed; readiness is healthy and the existing database volume and aggregate record counts are unchanged. Product acceptance remains separate. **Next: S1 telc preparation journey and exam-bound credits.** Preparations, saved mocks and complete written DTZ remain to be delivered.

## Adopted mock-preparation plan — 2 October 2026

**Ron's fixed release rules:** DTZ releases with all supported written sections (reading, listening and writing) together; S3/S4 are internal milestones only. Each DTZ recording plays once per attempt in both practice and mock-exam mode. Credits belong to one selected exam package, with no pooling, transfer or refill when creating/switching preparations. S1 includes exam-scoped entitlements and preserved legacy balances; S6 verifies complete DTZ availability, playback and debit isolation before release.

**EXAM-ADOPT-20261002-A:** Ron clarified that Hatoove delivers mock exams for preparation, not official examinations, and adopted [Claude's recommendations](implementation/CLAUDE-MULTI-EXAM-REVIEW-20261002.md). Actual Claude Opus 5.5 reviewed the earlier plan at `7a7caa0` with no repository tools. [The revised architecture](implementation/MULTI-EXAM-ARCHITECTURE-20261002.md), pilot plan, master plan and D9 now adopt stable exam-bound preparations, exact versions on attempts/mock runs, one minimal release manifest, single-option chooser bypass, autosave-first switching and telc-first vertical delivery. Section practice is labelled honestly; complete written mocks require all target written sections including reviewed audio. No official result, certification, proctoring or overall pass prediction.

**State: plan adopted; new runtime implementation, DTZ content approval and publication pending.** Next: **EXAM-S0** hardening, then S1 telc preparation journey, S2 release/importer and saved telc section mock, S3 DTZ reading, S4 DTZ writing, S5 fixed listening/complete written mocks, S6 integrated acceptance. S0–S6 supersede the original EXAM-01–06 proposal; English remains a later candidate. The [implementation plan](../IMPLEMENTATION_PLAN.md) records the same transition. Root owns this seven-document adoption diff in [PR #100](https://github.com/ronslink/hatoove/pull/100), with independent read-only architecture and UX reviewers. No worker implementation lease follows from the roadmap. Existing content, real-device, security/privacy and live-provider gates remain open; the running preview is unchanged.

## Integrated local pilot — 2 October 2026

**INTEGRATE-20261002-A:** delivered, independently reviewed, seven applicable CI jobs green, **merged** through [PR #98](https://github.com/ronslink/hatoove/pull/98) as `04e52dc` at11:03UTC. Canonical main and local Docker4300 now serve the merged source; data volume preserved/backed up and row counts unchanged. Account-cookie and submitted-draft discard defects are closed; writing close/reopen and D8 local-voice controls are delivered. Complete browser132/132, read-aloud24/24, real PostgreSQL races9/9, deletion19/19, API33/33 and HTTP journeys11/11 pass. [Result and review pins](implementation/INTEGRATE-20261002-RESULT.md). Contained PRs97/95/94/93/92/91/90/81 closed as superseded without deleting branches; PR60 is marked merged. All workers have delivered and hold no active writing slots. PR89/33 remain held. Product acceptance, content, privacy/security, live-provider and physical-device gates remain open.

## Current completion batch — 2 October 2026

[Issue #96](https://github.com/ronslink/hatoove/issues/96), [PR #97](https://github.com/ronslink/hatoove/pull/97), execution **COMPLETE-20261002-A**, base2711900. Ron requested completion of the unfinished learner work and work assignment to Claude. The coordinator owns integration in `codex/pilot-completion-20261002`; each writer has an independent managed worktree. No historical lease below is renewed. [Completion evidence and remaining acceptance](implementation/COMPLETE-20261002-RESULT.md).

| Slice | Delivered / current state | Evidence and next action |
|---|---|---|
| German entry and recovery | f39f419, independently inspected by coordinator | 36 isolated Compose/browser checks, desktop/mobile views inspected; operator-assisted recovery wording |
| Rights, history, revisions, export | eaf5118, independently inspected by coordinator | 8 memory /10 PostgreSQL history checks; rights6 with no pending gate |
| Claude CI and security repair | a014632 +433a0f9 delivered; coordinator and independent backend review | Registration isolation, exact-version discrimination, deletion with objective evidence, key-role isolation and7/7 table-policy mutations pass |
| Sentence recovery | 32bdacb, independently reviewed by entry worker | 240 original items recovered,12 published as unreviewed grammar practice;12 offline/14 PostgreSQL checks |
| Learner client and state recovery | 589223c corrected in2c7f714 and9112b11; independent review closed at52fbd17 | Browser124/124, including fresh history/revision, conflicts, offline/uncertain submission, export, readable guides and mobile views |
| Migration checkout compatibility | 87e92f4, independently inspected by coordinator | LF/CRLF upgrade7/7 and existing migration6/6; no applied SQL or ledger checksum rewritten |
| Current HTTP journey gates | e5af9f3, independently inspected by coordinator | Accounts6/6 and complete API journey11/11 after persistent CI prerequisites; no pending routes |
| Exam-package decision | [D9 record](implementation/D9-EXAM-PACKAGES.md) | Completion-time state: telc Deutsch B1 only, original items. The later EXAM-ADOPT decision above selects DTZ next; English remains a later candidate. |

All bounded worker executions are delivered; only the coordinator remains active for final CI and handoff. No child or remote execution is authorized by this record. Delivered, independently reviewed, green CI, merged and product accepted remain distinct; current GitHub status belongs to PR #97, stacked on #95. The local preview has been refreshed from the completion worktree after a database backup, with unchanged learner table counts and the same volume. Human content review, real-device keyboard/audio, commissioned recordings, live-provider privacy/cost gates and later batch refill remain open. This batch does not claim product acceptance or a production release.

The local coordinator owns this board. Detailed assignments live on linked GitHub issues; PRs and merged source provide completion evidence. Follow the [workflow](../docs/AGENT_WORKFLOW.md), [task template](TASK_TEMPLATE.md) and [handoff template](HANDOFF_TEMPLATE.md).

Repository: **[private `ronslink/hatoove`](https://github.com/ronslink/hatoove)**. Curated baseline `2feaba6` is published and its Linux/Windows CI passed. Remote assignments are linked below. No production deployment is scheduled. The original Codex heartbeat `continue-hatoove-implementation` was paused on coordinator transfer; this documentation update does not resume it. Current coordination cadence belongs to the appointed coordinator; worker runs remain bounded.

## Planning update — DESIGN-SAAS-PLAN-01, 1 October 2026

Ron requested the new design integration and retirement of the previous single-user schema/functionality. [MASTER-PLAN.md](../MASTER-PLAN.md) and [DESIGN-WIRE-01](implementation/DESIGN-WIRE-01.md) now define DESIGN-01–07 plus SAAS-MODEL-01, SAAS-RESUME-01 and mandatory SAAS-RETIRE-01. **State: planned; no implementation lease or slot is assigned by these rows.** Existing writing/session/deletion owners must finish or hand off before overlapping work.

Documentation execution `design-saas-plan-20261001-a`: branch `codex/design-saas-master-plan`, base `e126d8c4b18a2beaf58eca2d279fe8d191e825ae`; scope is linked planning documents and reference hashes only. Acceptance: all 14 screens mapped, owned data dependencies and explicit legacy removal checks, existing product/human/device boundaries retained. Checkpoint: documentation PR by 08:30 UTC; expires 09:30 UTC on 1 October. Ron's appointed coordinator remains dispatch/integration owner. No runtime/data change is claimed.

Earlier preparation and execution records below are historical; verify live leases with the appointed coordinator rather than reviving them from this board.

## Preparation

| ID | Task / owner | State and prerequisites | Completion evidence |
|---|---|---|---|
| PRE-01 | Curated source, private repository, guidance and CI / coordinator | Done | Private baseline `2feaba6`; 133 source files, no gitlinks; source guard and negative excluded-file check passed; 124 regression checks; [Linux/Windows CI](https://github.com/ronslink/hatoove/actions/runs/36747230832) passed |
| PRE-02 | OpenClaw write/PR exercise / Hetzner worker | Done, [issue #1](https://github.com/ronslink/hatoove/issues/1) | Actual agent run, 124 checks, scoped commit `54be708`; independently reviewed and merged [PR #3](https://github.com/ronslink/hatoove/pull/3), CI passed |
| PRE-03 | Hermes write/PR exercise / Hermes worker | Done, [issue #2](https://github.com/ronslink/hatoove/issues/2) | Ownership failure repaired; fresh execution `pre03-20260930-b` produced 124 passing checks and scoped commit `b7db454`; bundle digest/one-commit history/snapshot guard verified; reviewed [PR #4](https://github.com/ronslink/hatoove/pull/4), CI passed |
| PRE-04 | Previous-app visual and mobile reference / coordinator | Desktop reference and acceptance recorded; responsive implementation remains | [Reference and mobile acceptance](../docs/design/REFERENCE_UI.md); real-device checks remain outstanding |
| PRE-05 | Durable pilot contracts and first implementation slices / coordinator | First spike validated, [PR #11](https://github.com/ronslink/hatoove/pull/11), [issue #7](https://github.com/ronslink/hatoove/issues/7), execution pre05-20260930-a | [Contract 0.1.0](../docs/contracts/PILOT-V0.1.md) and [results/review disposition](implementation/PRE-05-RESULT.md); final integration recorded on PR; broader ownership/UI/human gates remain |
| PRE-06 | Hermes child exercise / Hermes + one granted child | Done, [issue #5](https://github.com/ronslink/hatoove/issues/5) | One actual synchronous child completed; direct trace inspection, separate clean worktrees and 9 writing checks; [verified evidence](exercises/PRE-06/pre06-20260930-a/RESULT.md). Multi-child concurrency and child writing remain unverified |

Preparation exercises use distinct paths such as `work/exercises/PRE-02/<execution-id>/RESULT.md` and `work/exercises/PRE-03/<execution-id>/RESULT.md`, finalized in their dispatch records. They do not change product code. The coordinator can run PRE-04/PRE-05 while worker exercises proceed.

## Product task candidates

These are the next implementation slices, not current worker assignments. Convert each into a fully specified task and start when its listed dependencies and specification are ready. Major implementation remains with the coordinator; worker contributions are separately scoped.

| ID | Deliverable / primary owner | Dependencies | Required outcome |
|---|---|---|---|
| PILOT-01 | Preserve logged-in appearance and adapt phone/tablet layouts / coordinator; bounded worker CSS/checks | PRE-04, relevant worker preflight | Familiar dashboard and practice appearance; usable navigation, touch and writing layout; desktop/mobile evidence without horizontal clipping |
| PILOT-02 | Authentication, owned attempts and recoverable drafts / coordinator | PRE-05 | Two-account isolation, account-scoped cache, saved draft after reload/navigation, cross-device return; no private state after sign-out |
| PILOT-03 | Reviewed objective practice with fixed audio / coordinator; worker fixtures/audits | PRE-05, PILOT-02 | Server marking matches reviewed keys; one recording across browsers; interrupted playback/session recovers; content review evidence retained |
| PILOT-04 | Durable writing feedback and revision / coordinator; worker failure checks | PRE-05, PILOT-02 | Idempotent submission, saved pending/result/failure states, recoverable retries, preserved revision lineage and correct usage accounting with provider stubs |
| PILOT-05 | Complete learner journey and independent verification / coordinator + independent checker | PILOT-01 through PILOT-04 | Exam/date/language setup through practice, feedback, revision and return; phone/desktop recovery evidence; formative limitations clear |

Use the [pilot plan](../PILOT_BUILD_PLAN.md) for detailed scope. Speaking is excluded. Product implementation readiness does not grant production deployment permission.

## Active executions

**Board state: 2026-10-01 (second revision).** `origin/main` = **`3a8c26647a2dabd1a95aff393ca9be870381d01a`**.
Baseline re-measured on that commit: `check.js` 101/0 · `writing-check.js` 9/0 · `feedback-check.js` 14/0 ·
checkers `server-origin` 16 · `reset` 9 · `revision` 8 · `owned-client` 31 · `owned-api` 24 · `keymask` 12 ·
`progress-equal` 10 · `draft-session` 17 · **`mock-outcome` 19** · **`progress-scope` 7** · `repository-check`
passes (295 tracked files). **Merged since the first revision:** #56 CI gates, #55 records, #54 WRITING-OUTCOMES-02,
#57 F-4 account scope. **Concurrency: Ron authorised all four workers plus the coordinator (2026-09-30)**, which
supersedes the earlier "four including the coordinator" cap. No recursive spawning.

**Routing (Ron, 2026-10-01): Claude takes the more complex tasks.** Observed on this run: Claude delivered
CI-GATES-01 end to end and was reassigned the F-5 slice; OpenClaw is fast and reliable on well-scoped slices;
Hermes is thorough but slow and **cannot push**; Clawdbot produced ~90 KB of transcript across two launches on F-5
with **not one file edit** and is treated as a last resort until it completes a run.

**Dispatch mechanics live in the coordinator handoff folder's `WORKSPACE-SETUP.md`** — per-worker setup, delivery
and verification, including the traps that each cost a launch attempt this round (Hermes cannot clone from GitHub
and cannot use `/root`; a bundle must be *fetched*, not cloned; Hetzner's `hatoove` checkout has a stale
`origin/main`; browser checks need `CHROME_PATH`; the `G:` handoff mount rejects atomic writes; copying a checkout
copies its worktree pointer file and produces two directories sharing one worktree admin).

| Slot | Execution | Current assignment/status |
|---|---|---|
| 1 | COORD-TAKEOVER-20260930 | **Ron's locally controlled agent is the coordinator** (issue [#27](https://github.com/ronslink/hatoove/issues/27)). This round it verified and merged **#51** (`c8bf97a`, DRAFT-SESSION-01, independently reviewed accept-with-notes) and **#52** (`5a63429`, OWNAPI-02 PostgreSQL adapter + RLS evidence, proof executed on real PostgreSQL and shown to be non-vacuous by mutation), re-measured the baseline, and dispatched all four workers. Evidence: handoff `reports/coord-20261001-a/` |
| 2 | **wo02-verify-hermes-20261001-a** | Hermes/Docker **running**. Independent review **and adjudication** of the two WRITING-OUTCOMES-02 implementations (#53 `72994ad` vs #54 `793f3c6`), candidate B pinned at `793f3c6`. Working checkout `/opt/data/workspaces/hatoove-wo02-verify/repo`; report is collected from the container because **Hermes cannot push**. **No PostgreSQL work** (Ron's instruction) |
| 3 | **f4-scope-01-openclaw-20261001-a** | OpenClaw/Hetzner **running** on `codex/f4-scope-01` from `5a63429`, workspace `/root/workspaces/hatoove-f4scope`. Fixes **F-4**: account-scope the legacy progress store, adopt the legacy blob once without losing it, fail closed when signed out, and either fix or honestly record the plaintext-at-rest property. `/root/workspaces/hatoove/.qa/f4scope-exec.err` was growing at dispatch |
| 4 | **f5-deletion-01-clawd-20261001-a** | Clawdbot/local **running** on `codex/f5-deletion-01` in `D:\clawdbot\hatoove-f5`. Fixes **F-5**: enumerate every path the app writes learner text or the key to, bring the local ones inside the deletion path, and state plainly what portable media cannot be reached |
| 4 | **ci-gates-01-claude-20261001-a** | Claude/local **running** on `codex/ci-gates-01`. Wires the five **ungated** checkers (`revision`, `keymask`, `progress-equal`, `draft-session`, `owned-api`) into CI. `.github/workflows/**` is granted for this slice only — it had never been in a worker's allowed paths, which is why they were ungated |
| — | integ-stack-20260930-a | **MERGED.** PR #35 → `82ae9c2`: ordinary merge of `2bcf749` into `074aebf`, 13 files added, 0 deletions. Independent review PR #36 = accept-with-notes, no blocking notes; CI green including the `postgres` job running `isolation.test.mjs` 11/11. Superseded stacked PRs #17/#21 closed. The earlier hand-rebuild PR #33 was rejected (PR #34) for reverting seven files and would have deleted the isolation CI step |
| — | user04-r3-clawd-20260930-a | **Clawdbot** (local, `d:\clawdbot` workspace) delta recheck `cba0f0c..c8c86dc` → **accept-with-notes**, report `work/implementation/USER04-R3-REPORT.md` on `codex/user04-r3-review-clawd`, draft **PR #31**. Found the `NEW-1` regression in my correction code and caught a wrong per-suite count in my commit message. Complete |

The advisory reviewer supplied failure cases (idempotency races, transactional rollback, lease fencing, allowance reservation and deletion precedence); those are test advice, not diff approval. See [USER-01 disposition and next slices](implementation/PILOT-01-CSS.md). `public/js/exam.js` is **no longer reserved by the paused `writing-outcomes-01` run** — WRITING-OUTCOMES-02 rewrote it — so the remaining constraint is only that there must be a single concurrent writer, and Ron's release decision governs when `draft-session.js` is wired in.

Ron-agent handoff: `<user-home>/.codex/hatoove-handoff/ron-agent`. Coordinator owns `CURRENT.md`/`QUEUE.md`; worker writes execution-specific `ACK.md`, `CHECKPOINT.md`, `RESULT.md`. Communication files only, outside source/OneDrive. CURRENT grants the USER-04 five-task sequence; other queue candidates do not grant edits. The coordinator heartbeat checks this folder; the user-controlled agent polls it as arranged by Ron.

Coordinator preparation closes with the merge of [PR #6](https://github.com/ronslink/hatoove/pull/6), following independent review and CI. The completed PRE dispatch files are historical records, not current execution grants.

Update this board and IMPLEMENTATION_PLAN.md progress together after meaningful transitions. Update status only from observed evidence. Distinguish a tooling inventory, a successful agent exercise, and a verified product behavior.

PRE-05 PR #11 merged ata9a4cfd; CSS PR #12 atbb30267; SQL PR #18 ata58f6fb; discovery PR #20 includes7e24229. Issues10/13/14 closed after acceptance of their bounded slices. Next: independently review USER04 corrections to source/fixtures PR17, then coordinator-owned client/draft recovery. The original CSS review overstated tablet/focus defects; only reproduced D5/D6 received changes. Text zoom, real-device acceptance and complete learner journey remain open.

## Coordinator ownership transfer — 2026-09-30 19:07 UTC

Ron explicitly appointed his locally controlled agent to take over coordination between Hermes and OpenClaw and requested a substantial task batch. [Issue27](https://github.com/ronslink/hatoove/issues/27) records the transfer. The new coordinator owns task allocation, architecture/contracts, central records and integration after independent review and greenCI; the original coordinator's implementation is paused and its unfinished changes remain preserved/unmerged. The new coordinator must ACK in the shared handoff and maintain CURRENT.md every5minutes. Twelve ordered delivery workstreams and exact worker/branch/process state are in <user-home>/.codex/hatoove-handoff/ron-agent/COORDINATOR-HANDOFF.md and QUEUE.md. Earlier references to the original chat as the sole coordinator are superseded by this user instruction. Existing worker leases, the global4agentcap and production/human-review gates remain.
