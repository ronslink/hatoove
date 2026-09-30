# PRE-05 / F-03 first slice evidence

Execution `pre05-20260930-a`, issue [#7](https://github.com/ronslink/hatoove/issues/7), PR [#11](https://github.com/ronslink/hatoove/pull/11). Coordinator owns source and integration. Source begins at `5e75ec5`; subsequent reviewer fixes are in the PR history. This is the local spike deliverable, not all F-02/A-01 or the complete learner journey.

## Observed results

- Node 24.4.1, Better Auth 1.7.6, pg 8.23.1, disposable PostgreSQL 17; exact auth tables generated from the pinned library and checked on every test run.
- **12 integration scenarios / 13 Node test-runner checks** pass, with real HTTP sessions and PostgreSQL transactions: ownership and input/Origin/cache controls, competing draft revisions, second-session resume and logout, enqueue rollback, duplicate submission/immutable lineage, lease fencing and single debit, failed/malformed feedback retry and last allowance, saved-result reopening, completion rollback, exhausted worker recovery, expiry while blocked on a job lock, and deletion precedence.
- Existing offline baseline: **101 + 9 + 14 = 124** passing checks. OpenClaw and Hermes independently reran them. They are legacy regression evidence, not exam validity.
- Staged file list inspected and repository source guard passed. Lockfile contains pinned package versions and integrity hashes; no `.env`, learner records or node_modules are tracked.
- Initial PR CI passed Linux/Windows legacy checks and Linux PostgreSQL checks. Final-head CI and independent fix review are recorded on PR #11 before integration.
- UI is unchanged in this slice, so no new learner screenshots are claimed. USER-02 owns its separate CSS/evidence branch under issue #10. Real-device checks remain open.

## Independent review and corrections

OpenClaw `f03a-20260930-a` produced audit commits `0071b95` and `c8ba9b9`; coordinator reviewed both diffs and requested/rechecked the contract correction before merging [PR #9](https://github.com/ronslink/hatoove/pull/9). Preserve the previous appearance, not arbitrary AI proxy bodies or mutable progress blobs as assessment authority. Provider spend must be distinct from the successful-review allowance ledger.

Hermes `f03h-20260930-a` independently read the spike and ran 124 baseline checks plus four syntax checks. It reached the iteration limit with its report staged but no commit/bundle. The coordinator confirmed the process ended, inspected the entire staged diff, ran the guard and packaged **only the report** into commit `19e501d`. Bundle prerequisite, one-commit scope and staged snapshot guard were checked before importing. The [original report](F-03-H-REPORT.md) is preserved as historical review of `5e75ec5`, not a claim that it ran PostgreSQL tests.

Local independent reviewer `f03r1-20260930-a` found invalid-parent coercion, uppercase UUID replay mismatch and a lock-wait lease concern. The coordinator reproduced the lease defect: a worker blocked before expiry returned success after expiry. The new regression failed on the old implementation; separate post-lock database-time checks now reject both late completion and failure. Invalid parent values now return 422 before SQL; idempotency compares PostgreSQL's canonical attempt ID. Focused tests pass.

Hermes finding disposition:

- F-01: accepted as deployed-worker prerequisite, not autonomous behavior of a test helper. Contract explicitly states reservations persist during worker outage, how recovered polling handles claims 1–3, and the need for continuous reconciliation/monitoring before deployment.
- F-02: clarified that both wire-byte and text limits apply; escaped text can hit wire limit first. The body-limit test now confirms a usable 413 response; stream iteration no longer destroys the socket before that response.
- F-03: fixed with fatal UTF-8 decoding and a 400 negative test.
- F-04: added parent, UTF-8, JSON, media type, body-size, draft-size, event-ID, auth-session and no-store assertions. Origin validation intentionally precedes route lookup and is documented.
- F-05: retain strict pinned-library empty-output comparison (`;`) alongside applying migration twice; it catches unexpected migration changes. Normalize CRLF in the committed SQL comparison. The snapshot has **three** indexes, not two as the report states.
- F-06: clarified explicit bounded retries for malformed/unavailable feedback; `retry_exhausted` is not retryable, even if called with a lower claim count.
- F-07: fixture-scale ordering/indexing only; production polling fairness/indexes remain A-03 work.
- F-08: startup guard returns 503 until auth context exists.
- F-09/F-10/F-11: DTO mapping, restart-stable secrets, application roles and privacy purge remain explicit integration gates. Added deleted-parent negative test. Allowances are inserted by synthetic test SQL, not exposed as a learner route.
- F-12: this workflow complements the existing independent Linux/Windows baseline workflow; both must pass. Ephemeral CI trust auth is not a production pattern. Minimum-runtime matrix, service-image digest maintenance and operational hardening remain future work.

## Remaining boundaries and next action

No production entrypoint, runtime-role/RLS claim, hosted email/recovery, provider integration/spend record, real content/audio approval, browser-account cache, UI draft recovery, physical privacy erasure, hosting readiness or real-device acceptance is established. Human security/content/native/audio gates remain. No deployment, DNS, payments or new production access occurred.

Next coordinator slice: F-02/A-01 least-privilege local roles/RLS, owned profile and account boundary, then PILOT-02-DRAFT wiring this contract into the preserved learner UI. USER-02 separately verifies/fixes CSS. Do not expose the legacy global API as the pilot backend.
