# Hatoove implementation plan

Revised 30 September 2026. This is the authoritative executable revision of the pasted **36-package agent-swarm plan**. It supersedes that plan's calendar, platform assumptions, package ownership and acceptance rules. The [pilot plan](PILOT_BUILD_PLAN.md) supplies product, examination and architecture rationale. Follow the user's later decisions if a document conflicts with them.

**Start here for a quick programme view:** [`MASTER-PLAN.md`](MASTER-PLAN.md) is the consolidated delivery tracker — milestones with merge evidence, the twelve coordination workstreams, the review/integration queue and the open human/device gates. It is a **summary that may lag**; this plan stays authoritative for package scope and acceptance. For what is running right now, see [`work/BOARD.md`](work/BOARD.md).

The next outcome is a dependable, mobile-capable learner journey in the previous app's visual style. Prepare and integrate source through the private `ronslink/hatoove` repository. This plan does not authorize publishing a site, sending invitations, configuring live domain traffic or deploying production services.

## Verified progress — 30 September 2026, 18:46 UTC

This is the master progress record. Package acceptance below remains authoritative: a finished subtask, passing test or worker report does not close the entire package. The [board](work/BOARD.md) carries exact owners/leases; linked PRs carry review and integration evidence. No overall completion percentage or launch date is inferred from task counts.

| Package / slice | Verified state and evidence | Remaining acceptance / next action |
|---|---|---|
| F-01 / PRE-01–03 | **Complete:** private curated baseline, source guard, Linux/Windows CI; actual OpenClaw and Hermes handoff exercises integrated in PRs #3/#4 | Maintain staged/history screening and bounded assignments |
| Worker capability / PRE-06 | One synchronous Hermes child exercise verified, PR #6 | Multi-child execution and child writing unverified; no children granted now |
| F-03 / PRE-05 | **First local slice merged:** [PR #11](https://github.com/ronslink/hatoove/pull/11), main `a9a4cfd`; pinned Better Auth/PostgreSQL, contract0.1.0, owned draft/submission/job fixture; 12 DB scenarios /13 runner checks and124 baseline passed | Broader content/sync/commercial contracts and real client integration remain; this is not completion of all F-03 consumers |
| F-02 + A-01 local SQL isolation | **Bounded slice merged:** [PR #18](https://github.com/ronslink/hatoove/pull/18), merge`a58f6fb`; four real login roles, FORCE RLS, session-derived transaction context, restricted HTTP/worker pools; 10 isolation scenarios /11 checks passed including concurrent two-account HTTP over3 connections; [review disposition/result](work/implementation/F02-A01-RESULT.md); final CI green | Broader production permissions, infrastructure/backup evidence and human security review remain; the dedicated local fixture container is stopped |
| F-04 / PILOT-01 CSS | **Bounded slice merged:** [PR #12](https://github.com/ronslink/hatoove/pull/12), merge`bb30267`; phone passage scroll and narrow-stat wrapping; coordinator independently inspected code, screenshots and measurements; source guard and CI passed | Tablet overflow and focus-ring hypotheses were not reproduced; zoom200 filenames do not establish text-zoom support. Actual iPhone/Android acceptance and broader F-04 remain open |
| E-01 source extraction + C-05 fixture preparation | **Three-task draft delivered:** [PR #17](https://github.com/ronslink/hatoove/pull/17), `7030a66`; official source register, draft blueprint/checker,14 synthetic feedback cases; worker reports55 new and124 legacy checks | Independent source/checker review, current-regulation gaps and known citation/feedback corrections remain. Neither E-01 expert approval nor C-05 validation is complete |
| C-01 prerequisite-independent discovery | **Bounded discovery merged:** [PR #20](https://github.com/ronslink/hatoove/pull/20), source`7e24229`; corrected tracked enumeration, runtime/prose distinction and option counts. Coordinator independently checked repeatable text/JSON outputs,124 baseline, source guard and single-commit scope; CI green | Formal migration/audit still depends on reviewed E-01.24 sets/180 keyed slots and6 writing prompts do not imply approved content; rights/review unknown and no tracked fixed audio |
| USER-04 preparation batch | **Five-task delivery reported, corrections/review active:** [PR #21](https://github.com/ronslink/hatoove/pull/21), stacked on #17; source gaps, validators, objective cases, feedback failure semantics and recovery matrix; worker reports107 new checks | Exact-commit independent review in progress; coordinator flagged false half-point-total derivation and outstanding prior findings. In-progress checker edits preserved under the same20:31 lease; no application edits |
| A-03/A-04/W-04 recoverable writing | Server fixture proves immutable submission, idempotency, lease fencing, one debit and deletion precedence; existing public writing view still lacks durable drafts | Coordinator owns `exam.js` and next bounded client/storage contract. Prompt identity, local/server recovery, account clearing, conflicts and mobile keyboard require implementation and tests |
| Internal first journey / release gates | **Not complete:** reviewed task/audio/language coverage, integrated client journey and real-device evidence absent | Follow dependency order below; no beta, production, calibrated-readiness or content-approval claim |

Current integration order: CSS #12, local SQL isolation #18 and discovery #20 are merged. Next review source/fixture #17 and stacked USER-04 corrections, while the coordinator prepares the owned client/draft identity/recovery contract. Independent USER03 review reproduced validator false passes and missing fixture context despite55 passing tests; [disposition](work/implementation/USER-03-REVIEW.md) feeds USER04 before integration. Other package rows are planned or prerequisite-blocked unless evidence above states otherwise.

Ron authorized an active five-minute Codex coordinator heartbeat (`continue-hatoove-implementation`). Each actionable run checks actual worker processes, reports, PR/CI state and lease expiry; it continues implementation and refreshes **this master progress record and the board together** after meaningful transitions. Idle checks do not produce repetitive status messages. At Ron's19:04 UTC instruction, coordinator implementation is on hold; unfinished WRITING-OUTCOMES-01 edits are preserved and unmerged. Monitoring, worker assignments and CURRENT.md updates continue every five minutes. Hermes OWNED-CLIENT-01 is acknowledged/running under issue23; OpenClaw returned pinned562902b review PR26 and currentfdff718 delta acceptance remains. Future Hermes runs use160iterations/2400seconds, within their task leases. Workers remain bounded by their grants and the four-agent global cap.

## Decisions that govern every package

1. Preserve the **previous `public/` app's logged-in appearance**: its dashboard, layout, cards, spacing and navigation style are the starting point. Use the [design reference](docs/design/REFERENCE_UI.md). Incorporate Hatoove's orange identity and preferred `oo` branding without treating this as permission for a wholesale redesign. The marketing preview is a separate visual reference.
2. Phone and tablet support starts with the first components and practice screens. Desktop parity, touch interaction, the onscreen keyboard, audio and recovery are acceptance requirements, not a final polish pass.
3. Deliver standalone telc Deutsch B1 preparation for reading, language elements, listening and writing. Speaking, STT, microphone capture, schools and teacher administration are excluded. Preserve deferred source without exposing its routes or oral-score assumptions in the pilot.
4. Retain the current Node API/background-worker and PostgreSQL direction. DigitalOcean App Platform and reuse of a separate logical database on the existing cluster remain conditional on region, permissions, capacity, connection and recovery checks. Cloudflare can remain domain/DNS/CDN. Hosting does not determine interface quality. Do not introduce Workers/D1, React, a monorepo migration or a new cluster merely to match the superseded plan.
5. Useful native-language explanations belong in the core offer. The examination language, explanation language and purchasing market are separate fields. Regional prices require a server-controlled catalogue and purchase snapshots, not language-based assumptions or currency conversion alone.
6. Objective marking is deterministic and authoritative on the server. Writing feedback is provisional and formative. Do not display a whole-exam pass prediction, uncalibrated readiness percentage or substitute a heuristic mark for missing writing evidence.
7. The local coordinator owns major architecture, contracts, implementation and integration. OpenClaw on Hetzner and Hermes in Docker receive bounded tasks or independent checks. More agents are useful only when task boundaries and review capacity support them.
8. Human experts approve educational content and supported-language explanations. Agents may draft, validate and flag; they cannot give themselves final approval. Product, payment, privacy and launch decisions retain the required human signoff.

## Source, execution and evidence

Canonical source is `C:\Users\ronon\OneDrive\Documents\ChatGPT\B1_Prep`. `D:\B1_Prep` is a separate older copy; do not silently merge learner records or application files from it. Preserve the existing structure and authored material. Personal progress, credentials, local artifacts and secrets do not belong in the source baseline.

The recorded offline baseline is **124 checks**: `node tools/check.js` (101), `node tools/writing-check.js` (9), and `node tools/feedback-check.js` (14). F-01 records current results before integration. These checks establish regression behavior, not exam validity, security, browser compatibility or AI accuracy.

Use the [agent workflow](docs/AGENT_WORKFLOW.md), [live board](work/BOARD.md), [task template](work/TASK_TEMPLATE.md) and [handoff template](work/HANDOFF_TEMPLATE.md). The initial PRE tasks on the board prepare execution of this plan; they do not replace its 36 package IDs.

- Each host uses its own clone; each writing task uses a separate worktree and `codex/` branch. No simultaneous shared checkout.
- The global cap is **four active agents total**, including the coordinator, parents, children and reviewers on all hosts. Hermes child budget is zero until capability is verified and the coordinator grants one slot. No nested spawning.
- Verified inventory: Hetzner alias `hetzner` has OpenClaw 2026.8.2, Node 22, Git and `gh` with identity `ronslink`; Docker `hermes-agent` has Hermes 0.21.1, Node 26 and Git, no `gh`, persistent `/opt/data`, and `/projects` mounted from `G:/Hermes/Projects`. Inventory does not prove agent write, PR or delegation ability; the preparation exercises must establish those capabilities.
- Only the coordinator assigns work. The assignment records execution ID, owner/host, base SHA, branch, allowed paths, acceptance, occupied slot, checkpoint and expiry. Stale work cannot merge. Do not automatically reassign until the former execution is stopped or explicitly revoked; use a new execution ID and branch.
- GitHub issues and PRs hold decisions, evidence and handoffs. The coordinator integrates in dependency order. Workers do not edit the central board, push to main or merge their own work.
- Choose exact paths for each task after inspecting the current tree. Reserve shared files such as `public/js/exam.js` for one active writer. A folder label is not proof of isolation. The coordinator handles cross-cutting changes; reviewers do not approve their own implementation.

## Contracts before parallel feature work

F-03 is a small integration spike followed by versioned contracts, not an attempt to freeze an assumed 13-table schema. Validate the selected authentication library, PostgreSQL adapter, Node runtime and migration approach first. If Better Auth is selected, account for its actual user, session, account and verification records and library-version requirements. Inventory the remaining records for profiles, versioned content/assets, attempts, drafts, immutable submissions, assessments, jobs, usage, sync/deletion, products, prices, orders and entitlements.

The initial contract covers:

| Boundary | Required decisions |
|---|---|
| Auth and routes | Public-route allowlist; authenticated learner routes; ownership; callback, webhook and anonymous-tool authentication; session/CSRF/Origin handling; input limits and errors |
| Exam and content | Versioned task shapes, item counts, timings, assistance/playback rules, weights, answer rules, rubric, rights/source and human review records |
| Writing | Draft concurrency; immutable submitted text; revision lineage; saved result/evidence; model/prompt/rubric versions; status transitions; job lease/retry/idempotency and quota semantics |
| Sync and privacy | Stable event IDs, server revisions, conflict behavior, deletion precedence, tombstone/retention rules, export shape and account-scoped cache clearing |
| Commercial | Market/exam/duration/allowance, price and currency snapshots, order/entitlement lifecycle, successful-assessment debit and refund/dispute behavior |
| Languages and analytics | Declared supported explanation languages and RTL; safe translation of saved feedback; data-minimized event names without learner text or direct identifiers |

Do not require authentication on every route indiscriminately: sign-in, callbacks, legal pages, verified webhooks and designated public tools need their own explicit controls. Learner records and privileged endpoints require authentication and ownership checks. Never send a task's scoring key to the browser as the authority for an unsubmitted attempt.

Contracts evolve through a recorded change request and version bump. The coordinator approves routine changes within this plan and coordinates all consumers in one integration sequence. Material scope, expenditure, production, payment or privacy decisions retain the relevant human checkpoint. Do not turn every routine schema adjustment into a new user permission request.

## Milestones and the 36 work packages

There are no overlapping promised week ranges. A package starts only after its listed prerequisites meet their acceptance criteria. A future task may use an approved contract/fixture to progress independently only if it is explicitly split into a separate deliverable with its own dependencies. Re-estimate duration from completed slices, human review capacity and actual host capability; week 20 is not a validated launch commitment.

**Owner notation:** C = coordinator, W = bounded worker contribution, R = independent reviewer/tester, H = qualified human or owner signoff. C remains accountable for integration. Rows describe concrete deliverables; large rows become ordered sub-tasks linked to the original ID, with exact paths and meaningful checks. Keep PRs reviewable rather than enforcing an arbitrary 400-line ceiling on generated fixtures or assets.

### Foundation

| ID | Deliverable / ownership | Prerequisites | Done when |
|---|---|---|---|
| F-01 | Curated baseline, repository, task guidance and CI / C | None | Private source baseline is reviewed; exclusions/source guard work; the three offline suites have recorded current results; CI runs applicable checks without live provider calls; worker handoff exercises are queued |
| F-02 | Local runtime and environment/infrastructure readiness / C, H | F-01 | API/worker/database development path is documented and reproducible; read-only infrastructure findings and unresolved conditions are recorded; environment/secrets boundaries and backup plan exist. Local work can continue with a clearly marked provisional hosting target; this does not certify production readiness |
| F-03 | Auth/runtime spike and pilot contracts / C, R | F-01 | Selected auth/database path is exercised locally; schemas, route controls and state contracts above are versioned with meaningful fixtures; conflicting assumptions are resolved before consumer implementation |
| F-04 | Previous-app design baseline and responsive components / C, W, R | F-01 | Existing logged-in appearance is the reference; phone/tablet/desktop layouts, touch targets, focus, contrast and RTL are specified and demonstrated; a framework change is not required |

### Exam specification and reviewed content

| ID | Deliverable / ownership | Prerequisites | Done when |
|---|---|---|---|
| E-01 | Versioned telc B1 written blueprint / C, W, H | F-03 | Every rule cites the applicable official model/specification and has expert review; four writing points, three criteria, timings, weights and playback rules are correct; oral components are excluded from pilot claims |
| E-02 | Objective marking and deterministic rubric calculations / C, W, R | E-01 | Hand-reviewed fixtures cover every supported task type, blanks, no-match/selection constraints and invalid answers; written totals are correct; absent/failed writing remains unassessed; keys stay server-controlled |
| C-01 | Existing corpus inventory and migration/audit / C, W | E-01 | Actual packs/items are counted and validated, with rights/source, task family, versions, gaps and prior review status recorded; no assumed 10-pack/24-seed inventory or automatic approval |
| C-03 | Early review queue and coverage register / C, W, H | C-01 | Humans can review, reject, correct and approve before bulk generation; review authority/audit trail and per-part/tag coverage are enforced; known-bad fixtures are flagged. Queue readiness is distinct from corpus approval |
| C-04 | Fixed, versioned listening recordings / C, W, H | C-03, F-02 | Audio is bound to reviewed text/task versions with checksum/duration/rights; a qualified listener checks content, pronunciation, pacing and intelligibility; load/retry/playback rules work with fixtures; no browser-TTS substitution |
| C-05 | Formative writing feedback contract and validation / C, W, H, R | E-02, C-03 | Existing benchmark evidence is incorporated; criteria/evidence and malformed/injection cases are checked; repeated runs and human-rated samples establish the limits of use; numeric claims stay gated behind calibration; no unvalidated fallback is exposed |
| C-06 | Reviewed explanations and language support / C, W, H | C-03, C-05 | Declared launch-language explanations and feedback terminology are natively reviewed, including RTL where relevant; coverage and missing translations are visible; back-translation is a check, not final approval |

### First complete learner journey

| ID | Deliverable / ownership | Prerequisites | Done when |
|---|---|---|---|
| E-03 | Adaptive practice selection and honest progress / C, W, R | E-02, C-03 | Target difficulty is derived from the current formula and chosen success rate, with boundary/coverage tests; assisted evidence is distinguishable; useful progress is shown without a pass forecast. Simulation does not establish predictive validity |
| E-04 | Review scheduling and dated study plan / C, W, R | E-03 | Exam-date changes, time zones, missing study days, workload limits and sparse content behave predictably; spacing is configurable and tested; plans do not imply guaranteed readiness |
| A-01 | Authentication and ownership boundary / C, R | F-02, F-03 | Maintained auth integration works locally/staging as permitted; two accounts are isolated; sessions, logout, CSRF/Origin, abuse controls and public-route exceptions have negative tests |
| A-02 | Owned learning/attempt/content routes / C, W, R | A-01, E-02, C-03 | Approved/entitled content is served safely; authoritative marking and attempt saving work; unauthorized cross-account reads/writes fail; historical content/rubric references remain immutable |
| A-03 | Durable assessment jobs and provider adapter / C, W, R | A-01, C-05 | Saved submissions precede dispatch; idempotency, transactional enqueue, bounded retries, job leases, result persistence and allowance accounting withstand injected failures; fixtures cover slow, malformed and unavailable providers |
| A-04 | Cross-device resume and bounded sync / C, W, R | A-02, A-03 | Server revisions, stable event IDs and explicit draft conflict behavior converge without silently overwriting newer work; completed feedback reopens without regeneration; stale events cannot recreate a deleted attempt |
| A-05 | Export, deletion and retention / C, W, H, R | A-04 | Owned data exports accurately; deletion covers records, assets, caches and jobs according to the reviewed policy; stale-client sync and late worker completion cannot restore deleted work; backup retention/restoration and legally retained records are handled honestly |
| W-01 | Existing-app shell, client boundary and languages / C, W, R | F-03, F-04 | Familiar navigation and styling are preserved; account states and route/client contracts work; de/en/uk/ar language structure and RTL are supported, with only reviewed language/content sets enabled |
| W-02 | Objective item runners with audio / C, W, R | W-01, A-02, C-04, C-06 | Reviewed short practice runs end to end on phone/desktop; deterministic feedback, guided versus timed assistance, timer/playback rules, interruptions and audio failures are verified |
| W-03 | Onboarding, dashboard and study plan / C, W, R | W-01, A-02, E-04, C-06 | A learner selects exam/date/explanation language and reaches relevant practice; dashboard resumes real saved work, not illustrated values or an unsupported forecast; scripted checks and observed usability are reported separately |
| W-04 | Writing, saved feedback and revision / C, W, R | W-01, A-03, A-04, C-06 | Drafts survive navigation/reload; immutable submission, pending/failure/retry, leave-and-return and revision flows work with the mobile keyboard; feedback cites evidence and stays linked to the original text/version |
| O-01 | Privacy-conscious observability and operational evidence / C, W, R | A-02, A-03, W-03 | Core journey events and recoverable failures are visible in local/staging checks; logs exclude learner text and secrets; provider cost/latency/job health are observable; supplier/location claims are verified before live use |

At this point demonstrate the complete **internal first journey**: sign in, choose exam/date/language, complete a small reviewed reading/grammar/listening set, write, leave during feedback, return, revise, and reopen on another device. Use provider stubs first. Include a slow response, failed response, reload and duplicate click. This milestone does not wait for SEO pages, a large question bank, push reminders or checkout.

Small observed usability sessions can evaluate this internal journey before full mock and checkout completion, subject to the applicable participant/privacy authorization. The later B-01 controlled beta deliberately tests the broader supported offer and therefore includes Q-01, checkout and full written-simulation evidence.

### Public/legal and commercial branch

P-03 can proceed after F-03 in parallel with the internal journey. S-01 is a separately gated public release; “ready” does not mean automatically published.

| ID | Deliverable / ownership | Prerequisites | Done when |
|---|---|---|---|
| P-03 | Applicable legal/privacy/AI information / C, W, H | F-03 | Legal review covers the actual offer, data flows, suppliers, retention and market; public waitlist has applicable identity/privacy/consent information before collection; commercial terms/withdrawal/refund requirements are ready before checkout; AI and telc non-affiliation notices appear at relevant touchpoints |
| S-01 | Orange Hatoove waitlist and optional free diagnostic / C, W, H, R | F-02, F-03, F-04, P-03 | Reviewed language/content, accessible form, confirmation/withdrawal, abuse prevention and storage/email flow pass local/test checks; any readiness check reports limited practice evidence. Publication requires its own explicit approval and privacy/security readiness |
| P-01 | Regional catalogue, orders, payment and entitlements / C, W, H, R | A-02, A-03, P-03 | Test-mode purchases store price/currency/market/duration/allowance snapshots; signed webhooks and replay/out-of-order events are idempotent; refunds/disputes and expiry are correct; successful assessment consumption is consistent; payment/privacy review is complete |
| P-02 | Checkout and account controls / C, W, H, R | W-01, P-01, P-03 | Learner can inspect/correct market and price, purchase in test mode and use the applicable cancellation/withdrawal/refund controls; wording and any consent controls follow reviewed requirements rather than a hardcoded generic checklist |
| W-05 | Error review and complete written simulation / C, W, H, R | W-02, W-04, E-04, C-03 | Wrong answers lead to useful revision; a full written mock is enabled only after its complete content/audio/scoring/timing review; report separates objective marks and provisional/unassessed writing, with no overall exam pass claim |

### Verification, beta and launch readiness

Tests and threat review begin within each preceding package; Q-01 and X-01 close the integrated evidence rather than introducing testing late.

| ID | Deliverable / ownership | Prerequisites | Done when |
|---|---|---|---|
| Q-01 | Integrated journey, mobile and accessibility verification / R, C | W-03, W-04, W-05, A-05, P-02 | Core journeys, checkout, isolation, deletion, failure/recovery and mock behavior pass against the integration candidate; axe plus manual keyboard/screen-reader/touch checks and iPhone/Android evidence have recorded results; no serious unresolved accessibility defect |
| X-01 | Security and privacy review closure / R, C, H | A-05, A-03, P-01, S-01 | Threat model, auth/ownership, public endpoints, answer-key access, sync/deletion, jobs, prompt injection, payments, logs and secrets controls are checked; material findings are fixed or explicitly accepted by the responsible human; known cross-user access/data-loss issues block release |
| B-01 | Controlled beta tooling and recruitment readiness / C, W, H | W-05, O-01, Q-01, X-01 | Invite/report/survey mechanisms work in tests; consent, support/triage and participant criteria are ready; early journey and review gates have evidence. Issuing codes is not participant recruitment or proof of usability; sending invitations is separately authorized |
| B-02 | Observed beta improvements and final hardening / C, W, R, H | B-01 | Actual learner observations on phone/desktop and supported explanation languages inform fixes; no open data-loss/access-isolation bugs; performance is measured on a stated device/network/cache configuration; relevant checks are rerun for changes |
| L-01 | Production readiness, restore rehearsal and launch decision / C, H, R | B-02, Q-01, X-01, P-02, P-03, O-01, F-02 | All release gates below pass on the release candidate, including reviewed content, actual infrastructure readiness, database/audio recovery and rollback rehearsal. Owner explicitly approves production release before live keys, traffic or publication change |

### Retained expansion packages

These IDs remain in the plan but are not hidden prerequisites for demonstrating the durable pilot. If selected for a release, their relevant checks and human review become part of that release's gates.

| ID | Deliverable / ownership | Prerequisites | Done when |
|---|---|---|---|
| C-02 | Scalable generation and validation / C, W, H | C-01, C-03 | Generation model/provider is selected using task-specific evidence and cost controls; recorded fixtures exercise validators; generated items enter draft/checked status and the human queue. Writing benchmark results do not establish generation quality |
| S-02 | Search content and public practice tools / C, W, H, R | S-01, E-01, C-03, C-06, A-03 | Original/authorized pages and tools match the exam and supported languages; anonymous AI tools have explicit quotas/abuse/privacy controls; quality and usefulness determine page count, not a promise of ten pages in every language |
| W-06 | Optional offline installation and reminders / C, W, R | W-05, A-04, A-05 | Account-scoped offline data and sync/deletion/conflict recovery work; unsupported/offline states are clear; any reminder feature has appropriate consent and verified platform behavior. Android push success alone is not iPhone/mobile readiness |

## Acceptance rules that protect the product

### Durable writing and truthful feedback

Autosave drafts with visible state and explicit conflict handling. A submission snapshots the exact text and task/content/rubric references; edits become a new revision. Persist an owned submission and durable job before acknowledging acceptance. Use a transactional enqueue/outbox equivalent so a crash cannot leave an accepted submission with no recoverable job.

Use a stable idempotency key and server uniqueness constraints for submission and usage effects. A job records status, lease, retry count and classified failure; a worker crash or timeout has a recovery path. A provider request may be repeated after an uncertain network failure, so do not promise exactly one provider call. Save one authoritative completed assessment and **one successful entitlement debit**. Record actual provider spend separately; system failures do not consume the learner's successful-review allowance.

Store validated feedback, criterion evidence and model/prompt/rubric versions. Reopening or translating a saved result must not regrade it. A learner can leave and return while processing, see useful status and retry safely. Preserve original response, assessment and revised response. Test delayed results after deletion, exhausted allowance, duplicate clicks, reload, offline recovery, malformed/truncated output and service failures.

The [benchmark results](research/deepseek-feasibility/RESULTS-2026-09-30.md) and [semantic review](research/deepseek-feasibility/semantic-review.md) provisionally favor DeepSeek V4.1 Flash via GreenPT for a private formative-feedback pilot. They do not calibrate exam scores or pass prediction. Median latency was about 10 seconds, sample p95 about 26 seconds and maximum 43 seconds: saved asynchronous state is essential. Reuse these findings; rerun targeted evaluation when model, prompt, rubric or processing changes justify it. Any fallback model must meet the same evidence/validation requirements before learners receive its output; otherwise retain a recoverable failure. Fixed sample rankings or a 12/12 gold set alone are insufficient release evidence.

C-05 must freeze its evaluation protocol before a new run, reserve fresh holdout scripts, and report unnecessary corrections, missed errors, incorrect replacements, criterion agreement, repeat variability and register-versus-role regressions separately. Include incomplete/off-topic responses and compare attack effects against ordinary repeat variation. Independent qualified human ratings establish assessment quality; schema validity and agreement between models do not. Define task-specific thresholds before inspecting new results.

### Exam fidelity and objective practice

E-01 records the dated official specification and expert signoff. The current pilot reference has reading/language elements sharing 90 minutes, listening about 30 and writing 30; the writing response covers four points and uses the three official criteria. Pass thresholds apply to the aggregate written result, not separately to every written subtest. Preserve the detailed rules and sources in the pilot plan and recheck the applicable version before release.

Content, keys, scoring rules and audio have immutable versions. The client submits task references and answers; the server supplies authoritative marking. Reviewed explanatory feedback may reveal an answer after completion according to the practice policy, without exposing unsubmitted keys through content downloads or public assets. Historical attempts retain their original evidence.

Fixed recordings receive educational/audio review. Test load failure, retry, interrupted sessions and permitted play counts consistently across supported browsers. Guided practice and timed simulation have explicit assistance/playback policies. Reading a transcript or playing browser-generated speech is not a substitute for a listening assessment. A short diagnostic is not a full mock.

### Human review capacity and supported languages

Set the release content requirement from advertised coverage, useful variation, task families, review/diagnostic needs and complete mock coverage where offered. There is no automatic “800 items means ready” gate. Record counts by part/tag/version, review status, source rights, approved audio and supported-language explanation coverage. Qualified exam reviewers, native-language reviewers and audio reviewers sign the areas they actually checked.

Define the counting unit for each family (individual answer, complete set, recording or writing task) and report approved sets separately from answer slots. Reserve unseen diagnostic/mock/evaluation material so repeated training exposure is not mistaken for independent performance evidence.

C-03 is intentionally available before generation scales. Time an initial review batch, record acceptance/rework rates and each reviewer's available hours, then set sustainable weekly quotas. Include correction and re-review, not just first inspection. The superseded 60–100 items/week for ten weeks yields 600–1,000, not a guaranteed 800; starting after week 10 leaves only 600 at the maximum through week 16. Adjust scope, capacity or release timing from observed throughput.

Machine checks and back-translation prioritize review; they cannot replace native approval. Enable only declared, adequately reviewed language sets. Explanations remain part of the core offer, independent of market and subscription tier. Translated feedback preserves the saved assessment and rubric rather than invoking a new grade.

### Mobile, usability and accessibility

Each UI task identifies its previous-app reference and covers narrow phones, larger phones, tablet and desktop. Verify no clipped content or accidental horizontal scrolling, legible task text, usable touch controls and focus, sensible navigation and RTL with German exam content. For writing, verify prompt access and save/submission controls with the onscreen keyboard open. For listening, verify actual device audio behavior and clear recovery.

Use browser viewport tests for repeatable layouts plus iPhone Safari and Android Chrome checks for actual behavior. Record unavailable device evidence rather than implying emulation establishes it. Axe checks are supplemented by keyboard, screen-reader and touch review. Observe a small number of representative learners attempting the complete journey; a scripted two-minute path is not evidence that a new learner understands it.

Performance acceptance specifies the device, network shaping, cache state, route, measurement and sample distribution before applying a target. Investigate measured bottlenecks; a vague “loads in three seconds on 4G” statement is insufficient.

### Accounts, commerce and operational privacy

Test two learners in the same browser and through direct API calls. Isolate drafts, attempts, assets, assessments, caches, exports and jobs. Sign-out clears private browser state. Sync uses server revisions and explicit conflicts; deletion wins against stale clients and late jobs. Keep deletion, retention, backup expiry and any required financial retention distinct, with a documented restore procedure that reapplies deletions. Do not promise instantaneous physical removal from immutable backups.

Regional catalogue entries include market, exam, duration, allowance, currency and price. Persist the agreed purchase snapshot and server-controlled entitlements. Allow legitimate market correction; instruction language and IP location alone do not establish purchasing market. Check affordability and unit economics for the actual package, including full included usage. No unsupported global euro price list or premium surcharge for native explanations.

Payment, auth, email and AI providers are stubbed or use expressly configured test modes in ordinary checks. Logs and events exclude written responses, secrets and unnecessary personal identifiers. Read-only cloud inspection does not establish SQL isolation or full supplier data residency. Before production, verify the actual EU region, SQL/runtime/migration role permissions, shared-cluster capacity, bounded pools, TLS/private connectivity, backups, authored-audio protection and provider processing terms. Do not alter the other application's grants or firewall access incidentally.

## Explicit release gates

| Gate | Evidence required |
|---|---|
| Foundation | F-01–F-04 acceptance, reviewed blueprint, current contracts, proven assigned-worker handoff and source exclusions |
| Internal first journey | Reviewed sample set and supported explanations; W-02/W-03/W-04 with owned persistence and cross-device resume; slow/failed/repeated submission and audio recovery demonstrated; no numerical validity claims from stubs |
| Public waitlist | P-03 applicable notices/consent, S-01 security/accessibility/abuse checks, reviewed content and owner approval to publish/collect data; no early public collection while legal work waits |
| Controlled beta | Q-01, X-01, truthful supported scope, human-reviewed content/audio/languages, usable reporting/support and authorization to invite participants; a code count is not beta evidence |
| Paid production | **Q-01, P-01/P-02, P-03, X-01, B-02 and O-01** complete on the release candidate; content coverage signed off; native/audio/exam review complete; actual F-02 infrastructure conditions satisfied; retention/deletion/export verified; database and audio restore plus rollback rehearsed; owner launch approval |

L-01 explicitly checks all these conditions; it cannot pass merely because three upstream package labels say done. Production secrets, live payment activation and domain traffic remain outside ordinary worker authority. Any selected expansion feature adds its own acceptance obligations.

CI begins with checks that the baseline can actually execute. Add each new journey's checks as its feature arrives; do not require nonexistent future checkout/deletion flows on the first PR or silently skip them at release. Live-model evaluations, when explicitly configured, produce recorded evidence and block the affected AI release on failure; they do not run as routine CI or create an automatic schedule by implication.

The coordinator updates this master plan's progress record and the board from observed evidence after meaningful changes, estimates remaining work from actual throughput and prioritizes completion of the integrated learner journey over keeping every agent busy. Preserve the distinction between delivered, reviewed, merged and accepted; keep the next action and unresolved human/device gates visible.

## Coordinator ownership transfer — 2026-09-30 19:07 UTC

Ron explicitly appointed his locally controlled agent to take over coordination between Hermes and OpenClaw and requested a substantial task batch. [Issue27](https://github.com/ronslink/hatoove/issues/27) records the transfer. The new coordinator owns task allocation, architecture/contracts, central records and integration after independent review and greenCI; the original coordinator's implementation is paused and its unfinished changes remain preserved/unmerged. The new coordinator must ACK in the shared handoff and maintain CURRENT.md every5minutes. Twelve ordered delivery workstreams and exact worker/branch/process state are in C:/Users/ronon/.codex/hatoove-handoff/ron-agent/COORDINATOR-HANDOFF.md and QUEUE.md. Earlier references to the original chat as the sole coordinator are superseded by this user instruction. Existing worker leases, the global4agentcap and production/human-review gates remain.
