# EXAM-S0 implementation evidence

Execution **EXAM-S0-20261002-A**, [issue #101](https://github.com/ronslink/hatoove/issues/101), base `88fa268`. Contract: [EXAM-S0](../../docs/contracts/EXAM-S0.md). This implements the first hardening slice of the adopted preparation architecture; preparations, exam-bound credits, saved mocks and full written DTZ remain subsequent work.

## Behavior delivered

Objective discovery, reads, answers, recommendations and mistakes retain exact versions. A correct answer in v2 cannot clear a v1 mistake, and the browser refuses a mismatched returned version. The learner shell waits for verified account preferences before navigation or writes, offers recovery after failed loading and retains the requested destination. Public content serving is approved-only by default; Compose explicitly selects the labelled internal preview. New writing use checks both task and rubric while retained owned work remains readable. Feedback bands are checked against each criterion's own scale, and unsupported rubrics fail before grading.

Actual Claude Opus 5.5 CLI delivered the twelve-file backend slice as `ccfd93d` (integration `43dfdac`). A separate worker supplied browser helper `987b957` (integration `26edd49`) and fixture repairs `6ebde56` (integration `a72407d`). The coordinator authored client, Compose, CI, browser synchronization and integration changes. Claude ran with bounded source tools and no shell, network tools, custom hooks, MCP servers or child agents. Raw execution logs stay outside source control.

## Executed evidence

| Boundary | Evidence |
|---|---|
| Exact client transport | 6 checks pass; original `88fa268` API fails the missing-version check |
| Server policy/version/rubric contracts | 8 offline checks pass; all 8 fail against a source-only `88fa268` archive |
| Real PostgreSQL version/history/policy | 6 checks pass; all 6 fail against the original archive on disposable schemas |
| Existing owned API and isolation | Memory API 33, PostgreSQL API 33, PostgreSQL isolation 9 and client 31 pass |
| Worker and content rights | Worker 14, rights 6 and PostgreSQL history 10 pass with stub grading |
| Preservation and grammar fixtures | Memory preservation 7, PostgreSQL preservation 9, deletion 19, memory grammar 12 and PostgreSQL grammar 14 pass |
| Hosted synthetic journeys | HTTP journey 11, accounts HTTP 6 and provisioning 5 pass |
| Startup/version browser behavior | Focused 12 checks pass, including delayed preferences, early synthetic submit, recovery, exact v2 persistence, retained v1 mistake and mismatched response refusal |
| Full runtime | Isolated Docker stack 35 checks pass; combined browser journey 144/144 passes with automatic fixture disposal |
| Source/contracts | Design 14, OpenAPI 30 and workflow mutation 12 pass; CI and Compose YAML parsed successfully |

All seven prescribed offline baseline commands have been exercised during integration; the final staged repository guard is recorded on the PR. Tests use synthetic accounts, source-only worktrees, isolated ports and disposable databases. Test fixtures explicitly opt into preview at their own execution boundary; imports do not silently widen the application's public policy. No live AI, payment, email, learner record mutation or production deployment was used for this evidence.

## Rendered evidence and independent review

Coordinator inspected desktop and mobile images under the integration worktree's ignored `.qa/browser/2026-10-02T13-14-11-141Z/` (focused run) and `.qa/browser/2026-10-02T13-16-29-292Z/` (combined 144/144 run): `s0-preferences-first-render-desktop.png`, `s0-settings-recovery-mobile.png`, `s0-preferences-recovered-mobile.png`, `s0-objective-v2-desktop.png`, `s0-objective-v2-mobile.png` and `s0-versioned-mistake-mobile.png`. The first-use view shows the saved English explanation preference and date, while German interface text remains German. The recovery screen provides a visible retry and no active default-settings form. Version labels, answer controls and retained mistakes fit the tested desktop/390px mobile layouts.

The backend reviewer independently approved Claude's exact twelve-file commit after reviewing policy/history/zero-write tests and receiving runtime evidence. The client reviewer independently approved the four client files and transport check, ran 6 transport and 9 account-context checks, and confirmed the original API fails the new transport check. The coordinator reviewed the worker-authored browser helper and six fixture-only changes. The client reviewer separately approved coordinator-authored browser synchronization and request-loader filtering; previous-document traffic is excluded without dropping requests from the new document. Review receipts and exact hashes remain in the local handoff.

Early browser runs exposed test synchronization defects: hash-only navigation did not reload the app, and an old document could satisfy a reload selector. The tests now require a new document and bind startup traffic to its loader. A full run also needed the canonical design path supplied through `HATOOVE_DESIGN_ROOT`. These fixes change the evidence harness, not content approval or application acceptance criteria.

## Remaining delivery gates

Independent review, green CI, merge and product acceptance are distinct states. S0 does not approve educational content or release DTZ. Physical iPhone/Android keyboard/audio checks, commissioned/reviewed listening media, human content and rubric review, live-provider evaluation, release security/privacy and legal acceptance remain open. The next implementation slice is S1: one telc preparation journey with exam-bound entitlements and preserved existing balances. DTZ still releases only when its supported reading, listening and writing are complete together, with one playback per recording in both modes and credits confined to one exam package.
