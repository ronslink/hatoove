# DESIGN-WIRE-01 — new designs and the SaaS cutover

## Authority, scope and evidence

Ron requested this plan update on 1 October 2026 after identifying `D:\B1_Prep\design`, then explicitly required removal of the prior single-user schema and associated functionality. Execution `design-saas-plan-20261001-a` is documentation only, based on candidate `e126d8c4b18a2beaf58eca2d279fe8d191e825ae`. Implementation remains planned unless a linked PR supplies evidence.

The coordinator handoff `TASK-HATOVE-DESIGN-WIRE-01.md` records Ron's decisions: adopt the new design language; keep menu/interface and exam content German; offer explanation languages **de, en, uk, ar, tr**. This record carries those decisions into the repository. The later instructions supersede earlier requirements to preserve the old palette, single-user runtime or file-sync behavior. They do not authorize a framework/hosting migration or production release.

The source contains **14 screen HTML files plus an index, one CSS file, three SVG logos, two WOFF2 fonts and build.py**. The [manifest](DESIGN-REFERENCE-MANIFEST.json) pins the exact inspected bytes. Read the design folder only; do not run its builder, modify the live install or copy credentials/learner data. DESIGN-01 will curate/version the usable assets and licence notices in the repository so remote workers do not depend on a drive letter. This planning change imports no assets. Source inspection is not browser or device evidence.

## Product and design decisions

- Adopt the rising-oo orange identity, warm-paper surfaces, Bricolage Grotesque headings, Source Sans body, consistent cards, desktop sidebar and mobile navigation shown in the supplied screens. Use one shared design system across the learner app, including screens absent from the mockups.
- Keep the current vanilla ES-module application and route lifecycle; the index's phrase “React app” is reference copy, not a framework decision. Preserve useful exam logic through explicit server contracts, not by retaining the local-install runtime.
- Translate English chrome in the mockups to German. Explanation-language changes must not change navigation, exam material, rubric or marks. Implement all five selected languages; development can use labelled fixtures while native-review gates remain open for each. No further shipping-order approval is needed to start implementation; do not silently drop Arabic or Turkish from the agreed target.
- Arabic direction applies to explanation blocks, not the German shell or exam prompt. Use `lang`, scoped `dir`, bidi isolation around German examples, logical layout properties and a verified glyph-capable font/fallback. Verify Ukrainian and Turkish glyph coverage too; retain actual font licence notices when assets are imported.
- Sample learner names, dates, totals, streaks, quotas and charts are fixtures, never production defaults. Empty, loading, pending, failed, offline, session-expired and conflict states are first-class screens.
- Replace the mockups' uncalibrated readiness/pass forecasts with factual practice history and coverage. Preserve the layout where useful. No overall-exam pass claim, two-model assessment claim, automatic Leitpunkt correctness tick or numerical AI validity claim may be inferred from a mockup. Show saved feedback with its actual provenance and limits; a missing assessment stays unassessed.
- Upgrade prices, promotional dates, allowances, access duration, reminder/offline promises, magic-link and Google controls require their corresponding real contracts. Build against stubs/configured catalogues as appropriate; do not activate live payments/email/OAuth or invent terms. Unavailable capabilities must not appear as successful actions.

## Target data model and retirement contract

The application is one multi-user service using one shared PostgreSQL application schema. Adding a learner creates rows, not a schema/database/role, progress file, copied app instance or global default user. Preserve session-derived `owner_id`, ownership checks and FORCE RLS for private records. Shared reviewed content is versioned separately from learner-owned evidence.

Minimum domain records and relationships:

| Domain | Authority and boundary |
|---|---|
| Identity/session | Maintained auth adapter; authenticated server identity, expiry/revocation/recovery and public auth routes. Test identities remain test-only |
| Profile/preferences | One owned record per account: exam/date, explanation language, daily goal and appropriate display preferences; no machine-global EXAM_DATE or shared settings file |
| Task/content/audio/rubric | Immutable versioned shared records with rights/review status; attempt binds exact task/prompt/content/rubric versions; answer keys remain server-side |
| Attempt/draft/submission/revision | Owned records with server revision, immutable submitted text and revision lineage; list/discovery plus lookup; no synthetic task constant in normal runtime |
| Assessment/job/usage | Owned submission and job, server prompt/provider versions, persistent result/failure, bounded retry, reservation and single successful debit |
| Progress/review/study plan | Derive from owned attempts/results/review events, with bounded server queries; do not store the entire old `freshState()` document as the new account schema or trust browser-computed grades |
| Catalogue/order/entitlement | Shared server catalogue plus owned purchase/allowance records; server-issued price snapshots and usage, never illustrative counters |

**SAAS-RETIRE-01 is a required cutover, not an optional cleanup.** Inventory every old writer/reader, record its replacement and delete the old runtime path after its replacement is verified:

- Remove `progress.json` and backup/revision/account-selected file stores from application persistence, `/api/progress` callers/handlers, full-blob `mergeProgress` synchronization and legacy reset/export/recovery flows. Renaming each file by owner is not the target architecture.
- Remove the `single-user`/`legacy` account state, anonymous learner fallback, implicit local-data adoption, automatic migration to the first signed-in user, and the startup option that silently runs a local app when accounts/DB are absent. The SaaS entry point must fail closed without its required account/database configuration, including when a mode flag is omitted.
- Retire the `b1prep.state.v1` global record and legacy owner marker as runtime authority. Local storage must not hold the old learner state schema under a new name. If the client needs non-authoritative cache/pointers, scope and clear them by authenticated account; a fresh browser must recover from the server without those pointers. Do not retain an offline full application or file-sync engine to satisfy old tests.
- Remove browser-controlled grading/prompts/provider selection and client-authoritative scores/quotas. Adapt useful renderers/educational utilities; remove their single-user persistence and authority assumptions.
- Replace fixture-based runtime session/schema/bootstrap and synthetic task bindings with production adapters and versioned migrations. Keep synthetic ports/data only in explicit test fixtures. Use separate migration/runtime privileges; no per-account provisioning or DDL in requests.
- Remove obsolete schema objects through reviewed forward migrations **after** mapping their consumers and any retained records. Keep applied migration history intact. No migration may silently assign ambiguous old data to an account or destroy existing learner records. A requested legacy import is a separate, explicit, dry-run-capable operation with owner/provenance checks; it is not a permanent compatibility path or a prerequisite for the SaaS cutover.
- Update old tests that enforce single-user compatibility to enforce the SaaS contract. Retain meaningful educational and security regressions; do not delete failing tests just to label the migration complete.

Removal refers to code/schema assumptions, not deleting Ron's live install or erasing individual learners. Planning authorizes no live data migration or deletion. Direct deletion of an account remains the separately verified, owned hard-delete flow.

## Screen-to-contract map

| Reference screen | Runtime surface / packages | Data, missing states and acceptance |
|---|---|---|
| login | account entry / A-01, W-01 | Real auth adapter; method availability, validation, refused/rate-limited/expired states; magic-link/Google only when implemented |
| check-email | verification status / A-01, W-01 | Mail-request status, expiry/resend/recovery without account enumeration; stub delivery in tests |
| onboarding | first-run setup / W-03 | Server preferences for exam/date/language/daily goal; resume incomplete setup; no global settings |
| dashboard | home / W-03, E-03 | Owned saved-work list, next activity, factual counts, sparse/empty history; no invented readiness chart |
| practice | reading runner / W-02, A-02, E-02 | Versioned tasks, answered/flagged question map, authoritative marking, timer and interruption recovery; no answer keys before allowed feedback |
| language | Sprachbausteine / W-02, C-06 | Owned answer/result, saved or reviewed explanation in the chosen language, language unavailable state; German exam text unchanged |
| listening | fixed-audio runner / W-02, C-04 | Versioned reviewed recording, actual loading/playback/expiry/retry, part-specific play rules; no browser-TTS replacement |
| writing | writing/draft/result / W-04, A-03/A-04 | Draft list/task binding, visible save/conflict, immutable submit, pending/failure/retry/result/revision, real allowance and account-switch fence |
| review | mistake notebook / E-04, W-03 | Owned error/review queue from saved results; completion updates server records; empty/retry states |
| plan | dated study plan / E-04, W-03 | Owned exam date/time budget and server-backed schedule; calendar adapts to missed days/time zones without promising a pass |
| progress | progress view / E-03, W-03 | Bounded aggregation of owned attempts; define denominator/date range/assisted mode; sparse history and unassessed writing stay explicit |
| mock | written simulation / W-02/W-04 | Reviewed complete content, timing/audio/marking; no speaking route, heuristic failed-writing score or overall-exam prediction |
| settings | account preferences/data / A-05, W-01 | Server settings, save conflict/error, sign-out, owned export and hard delete; no provider key/local synchronization/reset controls |
| upgrade | offer/entitlement / P-01/P-02, W-05 | Real catalogue and allowance/expiry, checkout test mode, success/failure/cancel states; not a dependency of the internal first journey |

Keep useful vocabulary and reference/grammar/writing-guide views in the same shell/component system, with owned learning state where they record activity. Speaking/STT and speaking-guide routes stay outside the pilot. A missing mockup does not justify a second design system or an accidental feature removal.

## Ordered delivery slices

These are planned slices, not active worker leases. The coordinator selects exact allowed paths and the latest reviewed base at dispatch. Existing writing/session/deletion PRs must be reconciled first where they overlap; one owner at a time for `exam.js` and other shared files.

| Slice / existing packages | Prerequisite | Deliverable and proof |
|---|---|---|
| DESIGN-01 / F-04, W-01 | This direction and source manifest | Curated/versioned assets and licences; token/component migration; rewrite DESIGN-LANGUAGE and update design-check with the first screen. Test gate still detects missing tokens/themes, raw styles and inaccessible states; keep German-language invariant |
| SAAS-MODEL-01 / F-03, A-01/A-02 | Inventory candidate schema/readers/writers | Versioned domain/route contract plus explicit legacy-to-replacement removal matrix; production auth/runtime path and safe forward migrations; no new table count guessed from HTML |
| DESIGN-02 / W-01/W-03 | DESIGN-01; auth/settings contracts (stubs allowed for development) | German shell, account/check-email/onboarding, owned settings/dashboard; first end-to-end signed-in navigation and all refusal/empty states |
| SAAS-RESUME-01 / A-02/A-04 | SAAS-MODEL-01 | Owned list/discovery, stable task/version, draft revision/conflict and second-browser recovery; SQL predicate and FORCE RLS tested separately and together |
| DESIGN-03 / W-04, A-03, C-05 | DESIGN-02, SAAS-RESUME-01; integrate/review existing writing PR | Writing design wired to durable submission, worker and server-controlled feedback/usage. Same-browser recovery can land earlier; do not call fresh-browser acceptance complete from a local pointer |
| DESIGN-04 / W-02, E-02, C-04 | DESIGN-02, owned task/marking/audio contracts | Reading, Sprachbausteine, listening and written mock runners; fixed audio and deterministic server marking; failures and missing review states |
| DESIGN-05 / E-03/E-04, W-03, C-06 | Saved results/settings contracts | Review queue, calendar and truthful progress; five explanation-language pipeline and RTL; translation preserves saved assessment, no regrade. Language implementation can run in parallel with DESIGN-03/04 under non-overlapping ownership |
| SAAS-RETIRE-01 / F-03, A-04/A-05, Q-01 | Replacement consumers verified | Delete legacy schema/runtime/client paths listed above; no supported single-user mode remains. Empty-database SaaS install and two-account journey pass without local progress files |
| DESIGN-06 / Q-01, W-01–W-04 | DESIGN-02–05, SAAS-RETIRE-01 | Independent full journey across phone/tablet/desktop, both themes and five language fixtures; no sample data leaking into runtime; real-device gates separately recorded |
| DESIGN-07 / W-05, P-01/P-02 | Catalogue/entitlement contracts and pricing/legal decisions | Upgrade/offer surface with accurate terms and test checkout; production payment/publication needs existing explicit authorization |

DESIGN-01 and SAAS-MODEL-01 may progress in parallel. Components can use explicit fixture contracts while backend work proceeds; “wired” requires the real owned API and records. Do not finish fourteen isolated static pages before testing the first complete learner journey.

## Completion evidence

1. Run source-only synthetic browser tests against the actual runtime and disposable PostgreSQL with isolated ports, no copied `.env`, no live email/AI/payment calls. Record exact commit, commands, counts, screenshots and unresolved gates; UI evidence includes 320/390 px phones, 768/1024/1180 px tablets and 1440 px desktop, light/dark themes, visible focus, touch targets at least 44 x 44 px, keyboard operation and 200% text zoom.
2. Prove A and B cannot access each other's preferences, drafts, results, review queue, plans, exports or jobs by UUID guessing, lists, caches, delayed callbacks or account switching. Identity always comes from the session. A fresh browser sees A's exact saved task/text/result; B sees none of A's data.
3. Submit, disconnect/reload, return during work, receive a result, revise and resume elsewhere; demonstrate rejected stale writes, preserved failed writing and one successful debit. Deletion revokes sessions and late jobs/callbacks cannot recreate data. Offline sign-out/reconnection gets a real regression check.
4. Prove the legacy removal through both a reachable-code/dependency inventory and dynamic checks: no progress file created/read, no fallback on missing auth/DB/flag, no legacy browser record adopted, no generic browser prompt proxy or client score accepted. Historical docs and dedicated negative-test strings are not runtime failures; classify matches rather than requiring a meaningless zero-string grep.
5. Prove selected explanations actually arrive in de/en/uk/ar/tr while German chrome/content/marks stay identical; exercise mixed-direction text and visible language errors. No live model call or native-review approval is implied by synthetic fixtures.
6. Re-run relevant existing checks and CI; replace obsolete local-only assertions with discriminating SaaS tests. Source guard and staged-file review precede push. Independent review and current-head CI precede integration; no human/security/content/device gate is closed by this planning change.
