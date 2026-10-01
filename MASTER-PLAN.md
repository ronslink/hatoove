# Hatoove master plan — delivery tracker

**Updated:** 1 October 2026 for the writing-first product and design reconciliation.
**Coordinator:** Ron's locally controlled agent, per [issue #27](https://github.com/ronslink/hatoove/issues/27); this documentation slice does not reassign live work.
**Inspected integration base:** `199dc0b99f91d06f402f084757ecf586e03631ce`, [PR #81](https://github.com/ronslink/hatoove/pull/81). Runtime-composition [PR #89](https://github.com/ronslink/hatoove/pull/89) was at `74fb15841699891384adcb0a5f304d7f2edc86b2`; its latest work was archived unverified. Main was `4f76b9428aacfc2ef670bdd3bdf5e43fa316222e`. Recheck heads and leases before dispatch.

## Working location

The canonical local repository is now **D:\Hatoover**, with design inputs in `design/` and the coordinator handoff in `handoff/ron-agent/`. See [WORKSPACE_LOCATION](docs/WORKSPACE_LOCATION.md). Previous checkout paths are recovery references; relocation changes no product acceptance or PR integration status.

## Direction now in force

Build a writing-first, multi-user server product using the orange/rising-oo design in `D:\Hatoover\design`. Build the small new vanilla client under `public/app/` around owned server records, then retire the old single-user SPA. Keep Node/PostgreSQL; no framework or hosting migration is implied. The fourteen mockups are references, not fourteen launch commitments.

**Remove the old single-user schema and functionality:** shared progress files, local-user fallback, browser state blobs, file sync and generic browser grading. Keep one shared schema with session-derived ownership per learner and versioned shared content. Retire obsolete consumers through MFP-02b/11 with safe forward migrations; this does not authorize deleting the live install or actual learner records.

Interface and exam material stay German. Explanation languages are **de/en/uk/ar/tr**, including working glyphs and scoped Arabic RTL. First-release planning defaults are email/password plus invite signup, per-criterion practice feedback without a `/45` total, and no daily-time setting. R11's three-versus-four criterion contract remains explicit, never a silent relabel. Ron confirmed the logo was AI-generated for this project; asset curation records provenance and font licences.

No first-release readiness/pass predictions, streaks, study plan, reminders, purchase UI, magic links/Google, two-model claims or automatic Leitpunkt correctness ticks. Writing pending/failed/unassessed states are required. Storage-region and retention claims wait for actual approved policy.

## Authoritative records

| Question | Record |
|---|---|
| First-release scope, dependency order, drops and retirement rules | [FUNCTIONAL-ROADMAP.md](work/implementation/FUNCTIONAL-ROADMAP.md) |
| Design decisions R11/R13–R16, missing screens/states and asset/CSS acceptance | [MFP-DESIGN-DECISIONS.md](work/implementation/MFP-DESIGN-DECISIONS.md) |
| Broader package requirements and human gates | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md), subordinate to the first-release roadmap where scope differs |
| Reference screen inventory and exact design bytes | [DESIGN-WIRE-01.md](work/implementation/DESIGN-WIRE-01.md), [manifest](work/implementation/DESIGN-REFERENCE-MANIFEST.json) |
| Product/exam/architecture rationale | [PILOT_BUILD_PLAN.md](PILOT_BUILD_PLAN.md) |
| Live owners and running status | [work/BOARD.md](work/BOARD.md), coordinator dispatches and the latest shared handoff; verify timestamps and expiry |

`HANDOFF-NEXT-SESSION.md` supersedes the older shared `START-HERE.md`. Treat stale `CURRENT.md` as a historical checkpoint. `Planned`, `delivered`, `reviewed`, `CI green`, `integrated`, `merged to main` and `accepted` are distinct states. [#63](https://github.com/ronslink/hatoove/issues/63) is the SaaS audit **issue**, not a pull request.

## Current progress and blockers

- Integration `199dc0b` contains the platform/writing/session fixes, the prior design-plan commit `2e656fa`, content/task schema, auth spike, migration and table-class checks, and worker process wiring. PR #80 was closed but its plan commit is included; it was not discarded.
- The coordinator recorded eight green CI jobs and an executed API journey of **5 passed, 6 pending, 0 failed**. The worker leg uses a real child process/restricted DB role with a **stub grader** and one debit. Those facts do not establish a finished learner UI, real model quality or production auth.
- **Next technical blocker: PR #89 / MFP-02a** needs current-head validation and independent review. Resolve account/session provisioning failure behavior and exclude tracked agent memory before integration. Then MFP-02b can remove the local-mode routes and fallback behavior.
- **Product wiring blockers:** learner task discovery, a client caller of durable submit, server-owned validated prompt/rubric output, authentication/recovery, factual history/export/delete UI and the complete fresh-browser flow. Existing backend primitives do not close these journeys.
- **Decision/release blockers:** R11 rubric contract; content rights and review policy; auth/recovery provider choices; human security/legal/native-language/device review; real provider and production authorization. Defaults are documented separately from confirmed decisions.
- This change updates planning only. No design screen, multilingual font or SaaS removal is implemented by it.

## Delivery order

| Order / slice | State at inspection | Required outcome |
|---|---|---|
| MFP-00 / 01 / 03 / 14 and worker wiring | Integrated component evidence | Maintain combined-head checks; auth spike is not production auth; pending journey legs do not count as passes |
| MFP-02a → MFP-02b | 02a WIP/unverified; 02b next | Runtime composition, then mandatory SaaS startup and deletion of old progress/config/AI routes; negative checks prove their absence |
| MFP-07a foundation + MFP-04a/b auth | Planned; disjoint backend work can overlap | Curated logo/licensed fonts, shared responsive tokens, German shell, invite/password signup/sign-in/reset and error/legal surfaces; no new framework |
| MFP-05a/b + MFP-06b | Required backend dependencies | Servable versioned task list, owned discovery/resume and validated durable feedback; resolve R11 and snapshot language/version provenance |
| MFP-07b → MFP-08 → MFP-09 | Planned; serialize shared client writers | Setup/settings/factual dashboard; writing/save/submit/pending/result/failure/retry/revise; history/export/delete with no invented scores |
| MFP-11a/b → MFP-12 | Required cutover and integration proof | Retire old client/schema consumers with a test ledger, then prove the two-account/fresh-browser journey on the actual runtime |
| MFP-13 | Conditional, outside default writing-first release | Reading/language elements only after rights and scope decisions; no listening without reviewed fixed audio |
| Broader DESIGN-02..07 backlog | Deferred beyond first-release scope | Listening, mock, review/study plan and commercial upgrade require later contracts/evidence; the old fourteen-screen schedule is superseded |

Missing designs are explicit work in the [screen/state matrix](work/implementation/MFP-DESIGN-DECISIONS.md): invite signup, password reset, writing task list, pending/failed feedback, history/revise, delete confirmation, legal pages and error states. Each dispatched slice still needs one owner, execution ID, exact base, paths, checkpoint and expiry.

## Internal milestone

An invited learner signs up, signs in, saves exam date/language, selects a servable writing task, saves a draft, submits, leaves while pending and returns on a fresh browser to the exact submitted text and saved feedback or explicit unassessed failure. They can retry, revise, view history, export, reset access and delete the account. Repeat with a second learner, stale writes, duplicate clicks, account switching and late worker completion. No legacy local record is required. Development uses email/provider stubs; this is not production release acceptance.

## Release gates still open

Content rights and qualified exam/native-language review, security/privacy/legal review, real iPhone/Android keyboard/touch/recovery evidence, operations and explicit production authorization. Audio evidence becomes relevant when listening enters scope. No sample design or green CI run approves those gates.

## Historical merged-slice evidence

This retained table records earlier integration history only. It does not restore superseded design/local-runtime requirements, close a whole package, or certify the current candidate.


| Slice | Merge | Evidence |
|---|---|---|
| F-01 baseline, source guard, Linux/Windows CI | — | 124-check baseline recorded |
| Worker capability: OpenClaw Git handoff, Hermes bundle handoff, one bounded Hermes child | #3, #4, #6 | PRE-02/03/06 exercises |
| F-03 auth/runtime + pilot contracts | #11 `a9a4cfd` | 12 scenarios / 13 runner checks |
| F-02/A-01 local SQL least-privilege isolation | #18 `a58f6fb` | 10 scenarios / 11 runner checks; four runtime/bootstrap roles, immutable submissions, atomic enqueue, one debit after saved assessment, deletion tombstones |
| F-04 / PILOT-01 CSS bounding | #12 `bb30267` | **Only D5/D6 reproduced and changed.** D2/D3/D8 were false positives; 200% zoom filenames unreliable as proof |
| C-01 discovery | #20 `a9ed166` | `7e24229`: 24 sets / 180 slots / 6 writing prompts, **0 tracked fixed audio**, rights/review unknown |
| Master-plan alignment | #22 `074aebf` | plan + board + discovery |
| Integration stack (USER-03 + USER-04) | #35 `82ae9c2` | 13 files added, 6589 insertions, **0 deletions** — a real three-way merge, not a hand rebuild. PR #33 (hand rebuild) rejected by independent review and retained as the rejection record |
| F-1 origin/authorization gate | #38 `9c57ffd` | `server-origin-check.mjs` 16/16; the reviewer's own probe showed pre-fix `82ae9c2` returned 200 **and rewrote the env file**, fixed head returns 403 `origin_rejected`; 14 bypass classes, 78 assertions, zero bypasses |
| Owned client transport | #41 `de4ecb6` | `owned-client-check.mjs` **31/31**; generation fencing holds even when the transport ignores `AbortSignal` |
| F-2 reset actually deletes | #42 `675a3f6` | `reset-check.mjs` 9/9; independent review then found the **in-flight-save race** |
| F-3 AI disclosure | #44 `0ee7e13` | learner-facing copy; flagged for human C-06 review |
| SEC-02 race correction | #45 `258f200`… | `progressEqual` compared `JSON.stringify` against a differently-ordered `mergeProgress` output, so identical records compared unequal and the server shipped a full payload on **every** POST |
| F-2 race: revision fence | #47 `8a71f71` | `revision-check.mjs` **8/8 including pre-fix discrimination**; a `DELETE` now invalidates older in-flight writes with `409 stale_revision` |
| OWNAPI-01 owned API | #48 `2974359` | `owned-api-check.mjs` **24/24** driven by the real client over real HTTP |
| F-7 key exposure | #50 `616e1e5` | `keymask-check.mjs` **12/12**; pre-fix disclosed exactly **5 runs of ≥3 key characters**, fixed discloses none |
| F-8 account name | #46 `fa53e30` | machine paths and OS account name removed from tracked docs |
| PM-01 `progressEqual` | #49 `2f892d2` | `progress-equal-check.mjs` **10/10** with pre-fix discrimination |
| **DRAFT-SESSION-01 draft service** | **#51 `c8bf97a`** | 4 files added, **0 deletions**, `exam.js` byte-identical; checker **17/17**, tests **21/21**; **independent review: accept-with-notes, no blocking defect** |
| **OWNAPI-02 PostgreSQL adapter + RLS evidence** | **#52 `5a63429`** | own package scope (`pg` 8.23.1) so the root app stays dependency-free; coordinator ran the proof on real PostgreSQL — **6/6** isolation tests and **24/24** the same suite on the pg backend; **discrimination proven by mutation** (granting the learner role `BYPASSRLS` makes it fail with "leaked a cross-owner row") |


## Coordination and evidence

The appointed coordinator owns live dispatch, integration order and CURRENT updates. Preserve the active global slot cap and single-writer boundaries; no automatic new worker allocation is created here. No live deployment, DNS, payment, email/AI evaluation or new production access is authorized by this plan. D:\B1_Prep remains a live install: only its design folder is a read-only reference. Use isolated source-only checkouts and synthetic records for verification.
