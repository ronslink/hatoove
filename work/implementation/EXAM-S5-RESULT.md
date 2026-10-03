# EXAM-S5 listening and complete written mock engineering evidence

Executions EXAM-S5-20261003-A and EXAM-S5B-20261003-A; [issue117](https://github.com/ronslink/hatoove/issues/117). Reviewed dependency base88ea484 (paymentsPR116, itself stacked on S4PR114). Contracts: [fixed listening](../../docs/contracts/EXAM-S5.md), [complete mocks](../../docs/contracts/EXAM-S5B.md).

## Delivered engineering

Private fixed PCM media is pinned by version, duration, byte count and checksum. The importer verifies exact media references, immutable publication and format-specific playback allowances. Authenticated GET/HEAD and single byte ranges check owner, exam, run, active time window, rights and integrity before returning private no-store bytes. Learner payloads expose no answer keys, transcripts, provider keys or filesystem paths.

A durable playback ledger records consumed plays separately from answer revisions. Begin follows actual native playback readiness; failed loading does not consume a play. Exact-event retries, explicit uncertain-position recovery, fresh documents and other devices retain the consumed allowance. DTZ recordings permit one play in both modes; telc descriptors follow their pinned policy. The client halts on session, route, expiry and group changes. Unknown acknowledgements remain retryable until the same event succeeds or an authoritative refusal resolves it.

Complete written mock validation fixes telc at60 objective items with assigned writing, and DTZ at45 with one immutable A/B choice. Server-created cumulative windows are LV+SB90/HV30/writing30 minutes for telc and HV25/LV45/SA30 for DTZ. Clock changes, reloads and navigation cannot pause or extend them. API and restricted SQL reject additions, edits and omissions outside the active group. Readonly views, local unconfirmed copies, early finalisation, expiry and empty/exhausted writing remain explicit. Raw objective counts and criterion feedback stay separate; no official total or pass claim is added.

Forward migrations0029–0033 preserve existing rows and immutable content. New playback and schedule rows have owner/RLS/export/deletion coverage. Assigned attempts and empty drafts are created atomically with run start. Package-bound grading rechecks exact task, rubric, release and complete-form rights before grading and in the assessment/debit transaction. Rights decisions now share the exam advisory lock: withdrawal-first prevents assessment/debit and refunds; worker-first commits before the withdrawal becomes visible. No existing rights decision is rewritten and no runtime mutation privilege is widened.

## Independent review

| Slice | Author evidence | Independent disposition |
| --- | --- | --- |
| S5A package | bd783a5 | coordinator/client reviewer inspected; package9/PG13 |
| S5A playback |2b6073d | separate reviewer inspected; media12/PG19 |
| S5A client and root fixes |9770080 through d95c49d | separate reviews repaired expiry deadlock, pending pause access and stale completion |
| S5B package |8c5193e,203f8bc | coordinator inspected and ran package9/PG13; complete-form objective rights refusal added |
| S5B backend |7dbc335,cc3783b | independent8/16/19; fixture cleanup finding fixed and separately inspected |
| S5B client |fa5564a,root18b56ff | separate reviewer found lost audio receipt at boundary; fixed19 plus extra nonterminal/stale-response probes passed |
| Worker commit fence |root e1f6b29/ace9a13,2f266c3 | reviewer reproduced late rights race, then independently passed real separate-connection13/13 with both orderings |
| Root fixture/browser/CI/spec |integration through41df85c and closeout | separate reviewer required acknowledged navigation and persistent native ended-event evidence; browser4 passed after both corrections |

Statuses are distinct: source delivered and independently reviewed; local tests passing; hosted CI and merge pending; product acceptance open.

## Recorded checks and rendered evidence

| Check | Result |
| --- | --- |
| S5A package/media/client |9/12/27 |
| S5A private package/media PostgreSQL |13/19 |
| S5B package/backend/client |9/8/19 |
| S5B package/backend/worker PostgreSQL |13/16/13 |
| Forward S3/S4/media/payments PostgreSQL |10/17/19/18 |
| Rights catalogue and workflow shape |6/12 |
| Compose startup/migrations/API |37, including OpenAPI51 |
| Final S5A browser |12/12 |
| Final S5B browser |8/8 |

Safe baseline design14, retired surfaces10, origin8, key masking, owned API34 and owned client32 also pass. Final retained default browser199/199, table-class mutation11/11 and deletion20/20 pass. Default browser evidence is .qa/exam-s5b-20261003/default-browser-accepted.

Ignored evidence is in the isolated integration worktree under .qa/exam-s5-20261003/browser-accepted and .qa/exam-s5b-20261003/browser-4. S5A covers native load/play/pause, fresh-document and second-device recovery, failure, expired playback and saved responses. S5B covers both complete flows, actual natural group boundaries, audio pause before native ended, assigned writing assessment and DTZ empty/unassessed writing. Screenshots cover1440 desktop,390/320 phone widths and both themes; root and independent reviewers inspected phone writing/player views. S5A additionally exercises native keyboard Enter and a labelled200% reflow-equivalent viewport. These are headless Chromium results, not browser-zoom or physical-device claims.

Earlier failed harness attempts are retained: initial preparation selector, asynchronous navigation and an artificial CSS zoom probe were corrected. The first retained default browser run omitted HATOOVE_DESIGN_ROOT; the corrected run explicitly points to D:/Hatoove/design. Its old empty-state assertion still expected section-only wording; the test now verifies the generic run wording and the complete199-leg rerun passes. A mistaken persistent classifier CLI found no database and changed no installation; its disposable mutation-test entrypoint is used for evidence.

All tests use synthetic accounts, technical generated PCM signals and isolated source/Compose projects or disposable PostgreSQL schemas. The browser clock seam shifts only synthetic run timestamps in its own disposable database; runtime validators retain full canonical durations. No live grader, Stripe charge, provider activation or learner database was used.

## Open gates and next work

This delivers engine and internal technical fixtures. It does not approve generated questions/rubrics, commission spoken recordings, establish rights or translation approval, or release a complete DTZ package. Physical iPhone/Android keyboard/audio, human educational review, security/privacy/legal/provider and product acceptance remain open. The private media store must contain separately reviewed recordings before real learner publication.

S6 must enforce one complete public DTZ admission decision across discovery, preparations, direct starts and purchase offers while preserving permitted pinned history. Default configuration stays telc-only. Existing PR114/116 hosted checks cannot start because of GitHub account billing/spending limits; the required green CI must precede merge. No site publication, live money, production deployment, learner migration or volume deletion is authorized by these results. The original canonical dirty checkout and paused work remain preserved.
