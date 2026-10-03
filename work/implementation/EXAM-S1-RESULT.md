# EXAM-S1 implementation evidence

Execution **EXAM-S1-20261003-A**, [issue #104](https://github.com/ronslink/hatoove/issues/104), base `0d32619`. [Contract](../../docs/contracts/EXAM-S1.md). S1 delivers the telc preparation journey and closes the current review fixes. Saved section mocks remain S2; this is not a complete mock or a DTZ release.

## Behavior delivered

Each preparation has stable exam identity, its own date, history and objective evidence. The learner resumes the only available preparation without a chooser. Explicit switching waits for the current draft or settings save, honors the latest requested destination and fences obsolete responses. A refused save keeps the original form, text and recovery actions visible. Explanation language and theme remain account preferences. Full objective option labels wrap on narrow screens; catalogue cards open their exact task/version directly and close back to the catalogue.

Credits belong to an account and exam package. Creating or switching preparations never grants, refills or transfers credits. The forward migration preserves existing balances, record IDs, text and submitted snapshots; provable historical context is backfilled, while unresolved rows remain readable/exportable without guessed writes. Initial preparation and credits are provisioned atomically by an insert-only registration trigger. Restricted auth UPDATE cannot mint credits, retired provisioner grants are revoked, and concurrent cross-exam reuse of a submission event returns a conflict with no extra job or reservation.

Archived preparations retain history and allow already submitted jobs to finish or retry on their original exam balance. Creating practice, answering, submitting, saving or deleting an unsubmitted draft requires active context. Archive and draft mutations use compatible preparation locks. Readiness now reflects database availability and recovers after connection loss.

## Authorship and independent review

Actual Claude delivered backend `b145652`, memory parity `254f633`, PostgreSQL integration fixtures `3f9d14e`, and archive safeguards preserved as `cc8ada9`. Its session limit interrupted the last fixture pass; the bounded local follow-up `189ced8` completed those tests without changing Claude's runtime safeguards. Actual Docker Hermes delivered UI commits `368ca47`, `7922079`, `c1d36c7` and fixture commits `40e7620`, `10c63ac`, `fc44853`. Separate local authors delivered readiness `1274f09`, learner journey `09d9bcf`, provisioning/concurrency repair `6309341` and navigation recovery `2a8e486`. The coordinator integrated client context, browser fixtures, the settings-write navigation repair, CI and records.

Hetzner OpenClaw performed a bounded source-only review. Independent local reviewers approved the backend/migration through integration `cf4a0ed` and archive delta `3f9d14e..189ced8`, plus coordinator transport, learner recovery, settings navigation and browser harness changes. The coordinator independently reviewed worker-authored changes. Registration, cross-exam event reuse, archived draft writes and rapid navigation findings were resolved. Exact review receipts and raw execution logs remain in the ignored coordinator handoff. Human release security/privacy and educational approval are separate gates.

## Executed evidence

| Boundary | Result |
|---|---|
| Shared owned API | 34/34 on memory, ephemeral PostgreSQL and persistent PostgreSQL |
| Focused S1 contracts | Client transport 10/10; memory server 9/9; PostgreSQL 11/11 |
| Archive discrimination | Pre-fix `3f9d14e` passes its original eight legs and fails all three new archive/unresolved/locking legs; final code passes all eleven |
| Readiness | Offline 8/8; two real PostgreSQL fault/recovery legs; predecessor fails the new outage tests |
| PostgreSQL isolation | Retained RLS/discrimination wrapper 10/10, including restored RLS-off and immutable-content negative controls |
| Preservation and accounts | Provisioning 6, account HTTP 6, submitted preservation 9, deletion 19, worker 14, complete HTTP journey 11, throttle isolation 4 and hosted runtime 6 pass |
| Existing behavior | Client 32, account context 9, S0 client 7, S0 server 8, S0 PostgreSQL 6, memory history 8 / PostgreSQL 10, memory sentence checks 12 / PostgreSQL 14, memory preservation 7 pass |
| Migration/security | LF/CRLF upgrade 7, anonymous-config 7, objective-key access 5, table classification 30 rows / zero findings, classifier mutation wrapper 10 pass |
| Compose and OpenAPI | Final Docker stack 36/36, including the OpenAPI surface/auth probe 36/36 on its synthetic server. The probe requires an explicit disposable loopback URL and rejects the learner preview ports |
| Browser | Complete isolated walkthrough 184/184; desktop 1440px and mobile 390/320px, light/dark, exact versions, retained drafts, account fencing, conflicts, delayed requests and latest-navigation recovery |
| Source/workflows | All seven prescribed offline baseline commands exercised; workflow mutation suite 12/12; CI YAML parsed successfully. Final staged source screening and current-head CI are recorded in the PR |

The final browser evidence uses the exact delivered frontend. The subsequent backend archive safeguards were tested separately on real PostgreSQL and in the final Compose check. All fixtures use source-only checkouts, synthetic accounts and disposable ports/databases. No provider, live payment, email or production deployment was invoked.

Coordinator inspected `s1-preparation-desktop.png`, `s1-preparation-390-light.png` and `s1-settings-write-navigation-recovery.png` in the ignored `.qa/exam-s1-20261003/browser-third/` evidence directory. Preparation identity, exam credits, catalogue controls and recovery messages are readable; narrow layouts have no horizontal overflow. Unique document tokens in the S0/S1 browser helpers prevent hash-only reload races from measuring the preceding page. The failed diagnostic runs are retained rather than counted as passing evidence.

## Next slice and remaining gates

S2 introduces the minimal release/importer contract and a saved telc section mock with exact pinned task versions and durable run recovery. It must retain S1 preparation and exam-credit boundaries, use honest section-practice labels, and keep unsupported complete mocks unavailable. DTZ releases only with supported reading, listening and writing together, one playback per recording in both modes, and exam-specific credits. English remains a later candidate.

Physical iPhone/Android keyboard/audio checks, qualified content/rubric review, reviewed listening media, live-provider evaluation and release security/privacy/legal acceptance remain open. Delivered, independently reviewed, green CI, merged and product accepted are distinct states; the linked PR and coordinator handoff hold the integration status. No production release is claimed.
