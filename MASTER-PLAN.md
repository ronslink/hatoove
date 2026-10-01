# Hatoove master plan — delivery tracker

**Updated:** 1 October 2026 for Ron's new design and single-user retirement direction.
**Coordinator:** Ron's locally controlled agent; transfer recorded in [issue #27](https://github.com/ronslink/hatoove/issues/27). This documentation slice does not reassign live work.
**Planning base:** SaaS candidate `e126d8c4b18a2beaf58eca2d279fe8d191e825ae`, [PR #60](https://github.com/ronslink/hatoove/pull/60). Remote `main` was `4f76b9428aacfc2ef670bdd3bdf5e43fa316222e` at inspection. Recheck heads before dispatch; candidate integration is not a merge to main.

## Direction now in force

Build a multi-user server application using the designs in `D:\B1_Prep\design`: orange rising-oo identity, warm-paper surfaces, Bricolage Grotesque headings, Source Sans body and the supplied desktop/mobile layouts. These designs replace the earlier visual preservation constraint. Keep the current Node/PostgreSQL and vanilla-client direction; a mockup's React label does not authorize a rewrite.

**Remove the old single-user schema and functionality.** The new screens use authenticated, owned server records. No shared progress file, local-user fallback, full-state browser blob or file-sync compatibility path remains in the completed SaaS runtime. Keep ownership/isolation per learner; do not delete actual existing learner records as an incidental cleanup.

Menu/interface and exam content stay German. The selected explanation languages are **de, en, uk, ar, tr**, with scoped Arabic RTL and native-review gates. Speaking/STT and whole-exam pass prediction remain outside the pilot. Mockup data, readiness forecasts, prices and two-model claims are not accepted product behavior.

## Authoritative records

| Question | Record |
|---|---|
| Packages, acceptance and gates | [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) |
| Screen mapping, backend dependencies, legacy removal and ordered slices | [DESIGN-WIRE-01.md](work/implementation/DESIGN-WIRE-01.md) |
| Exact inspected design bytes | [DESIGN-REFERENCE-MANIFEST.json](work/implementation/DESIGN-REFERENCE-MANIFEST.json) |
| Product/exam/architecture rationale | [PILOT_BUILD_PLAN.md](PILOT_BUILD_PLAN.md) |
| Active owners/leases | [work/BOARD.md](work/BOARD.md) and the coordinator's current issue/dispatch |
| Running status and next bounded assignments | shared handoff `CURRENT.md`, `START-HERE.md` and task briefs; verify timestamps |

The implementation plan governs package scope; later user instructions take precedence. `planned`, `delivered`, `reviewed`, `CI green`, `merged into candidate`, `merged to main` and `accepted` are distinct states.

## Current progress and integration checkpoint

- The candidate contains account/RLS and durable draft/submission infrastructure, provider-configuration restrictions, session-boundary work and hosted runtime safeguards. These are building blocks, not a completed SaaS journey.
- The review-coverage task is [PR #74](https://github.com/ronslink/hatoove/pull/74). Earlier component reviews do not automatically approve the later combined head.
- Writing wiring is delivered for review in [PR #75](https://github.com/ronslink/hatoove/pull/75); deletion wiring and session-fence changes are tracked in [#76](https://github.com/ronslink/hatoove/pull/76), [#77](https://github.com/ronslink/hatoove/pull/77), [#78](https://github.com/ronslink/hatoove/pull/78) and [#79](https://github.com/ronslink/hatoove/pull/79). These were open when inspected. Resolve superseded attempts and ownership before another writer touches their paths.
- Production auth, saved-task discovery/version binding, the real assessment worker, server-owned prompts/usage and objective marking remain required. New designs make these dependencies visible; static rendering does not close them.
- This change is **plan updated**, not designs implemented or legacy schema removed. Runtime evidence must be recorded against the final integration head.

## Delivery order

| Order / slice | State | Outcome / dependency |
|---|---|---|
| 0 — integrate reviewed platform fixes | In progress | Coordinator resolves the review/deletion/session/writing queue and records combined-head evidence; retain one owner of shared files |
| 1 — DESIGN-01 | Planned | Version design assets/licences and one shared token/component system; update visual contract and design gate together |
| 1 — SAAS-MODEL-01 | Planned; parallel with DESIGN-01 | Production auth and owned domain/route contracts; inventory every old single-user schema consumer and its replacement |
| 2 — DESIGN-02 | Planned | German shell, account entry, check-email, onboarding, settings and dashboard connected to real owned records |
| 2 — SAAS-RESUME-01 | Planned | Owned discovery and stable task identity; server-authoritative draft conflict and fresh-browser resume |
| 3 — DESIGN-03 | Planned; adopt reviewed writing work | Writing, durable job/feedback/retry/revision and actual usage; no browser-controlled prompts or grading |
| 3 — DESIGN-04 | Planned | Reading, language elements, fixed listening audio and written mock with authoritative server marking |
| 4 — DESIGN-05 | Planned; language pipeline may start alongside 3 | Owned mistake review, calendar, factual progress and all five explanation languages including RTL |
| 5 — SAAS-RETIRE-01 | Required cutover | Remove old schema/runtime/client persistence and compatibility paths after replacements are verified; forward migrations, no silent data destruction |
| 6 — DESIGN-06 | Planned | Independent full learner journey and two-account isolation; desktop/mobile evidence and explicit remaining real-device/human gates |
| 7 — DESIGN-07 | Separate commercial track | Upgrade/entitlement UI with real catalogue and test checkout; not a dependency of the internal journey |

Detailed acceptance and mapping of all 14 screens are in DESIGN-WIRE-01. Each row becomes a bounded assignment with execution ID, exact base, allowed paths, checkpoint and expiry; this table is not a lease.

## Internal milestone that proves the application is connected

Sign in -> finish setup -> start owned reviewed practice -> receive server-marked answers and the chosen explanation -> write and save -> submit -> leave while pending -> return to saved feedback -> revise -> sign in on a fresh browser and resume the exact task and work. Repeat with a second learner, failed requests, duplicate clicks, stale writes, account switching and deletion. No local progress file or legacy browser record is required or consulted. Use provider/email/payment stubs in development.

## Release gates still open

Qualified exam/content/audio/native-language review, security/privacy/legal review, real iPhone/Android keyboard/audio/recovery evidence, operational recovery/permissions and explicit production authorization remain separate. No unsupported readiness, overall-exam pass or model-agreement validity claims. Pricing/terms come from the approved commercial contract, not sample markup.

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
