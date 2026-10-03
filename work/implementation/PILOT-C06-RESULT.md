# PILOT-C06 — exact saved-explanation review

Issue: [132](https://github.com/ronslink/hatoove/issues/132). Contract: [PILOT-C06](../../docs/contracts/PILOT-C06-EXPLANATION-REVIEW.md), frozen at `eb363db`. Status: implementation delivered, independently source-reviewed and locally verified; publication, final hosted CI and merge remain separate. No real reviewer appointment or content approval is implied.

## Result

Shared objective explanations now have immutable review targets bound to the exact source, representation kind, language, version and payload hash. Educational and native-language decisions remain independent. A withdrawn translation can fall back only to an independently permitted original; withdrawing both removes protected prose without changing saved answers or grades. A private source classifier prevents removal of a registry language declaration from bypassing an existing negative decision.

Stored representations and virtual originals retain distinct identities even when their text hashes match. Exact event replay remains idempotent. Operator reads and writes preserve the required transaction fence, while authorized read-only snapshot operations do not acquire that lock. Registration, decision, authority-revocation and rights races have real PostgreSQL coverage.

Learner reads and account export use the same protected decision contract. Export retains additive selector receipts and safe refusal metadata without exposing the private review binding. Owned writing remains outside shared editorial review; existing ownership, rights, deletion and immutable-result boundaries remain intact. Migration0040 is forward-only and pinned in the manifest; it seeds no approval.

## Reviewed source

The assembled tested runtime is `af5fb48dc16de95416a1e08a9eb5e3c022229e88`, Git tree `91e6fb7240cdf644edfc76a2fa27226ffd44d10a`.

- Core execution `0188e6d31ee00d59e39d005e3a1f7ad94655c31d` and consumer/baseline execution `94590c92424cda98356a0fa77f3ef6fb59404e42` have that exact tree.
- Acceptance execution `0c47f6a8ea2bec3c4daf098437ee6ce0b2bfb413` incorporates the same reviewed integration with no source changes during testing.
- Independent review covered the core/SQL, consumers, classifier, acceptance fixtures and final integration separately from their authors. Replay expectations, cleanup error handling, Windows CI exit propagation and export documentation findings were corrected before the successful runs.
- Subsequent integration `d9695e887adf2162729fb0031a556b338b19a420` adds reviewed status records and inherits the diagnostic-only PR133 from main; it changes no tested C06 runtime.

## Local validation

| Check | Observed result |
| --- | --- |
| Exact-review pure contract | 11 passed |
| Retained review pure contract | 13 passed |
| Explanation pure contract | 28 passed |
| Cleanup fault controls | 9 passed |
| Exact-review PostgreSQL17 | 21 passed, one actual run |
| Protected explanation consumers PostgreSQL17 | 17 passed, one actual run |
| Retained C03 review PostgreSQL17 | 33 passed, one actual run |
| General classifier | 23 tests passed, including105 private editorial mutations |
| Explanation-specific classifier | 158 mutations detected |
| Source-only Compose/headless-browser wrapper | 20 successful records:17 behavior groups,2 setup records and1 browser cleanup record |
| Seven AGENTS safe offline baselines | All passed once; design checker retains two existing warnings |

The17 browser behavior groups include five new actual C06 registration/decision/withdrawal scenarios and12 retained P07 groups. They exercise separately approved originals, translation withdrawal, both representations blocked, held real responses, local speech cancellation, account/view/preparation switches and finalised mock immutability. The wrapper saved60 screenshots across1440px light,320px light and390px dark layouts.

Coordinator visual review found no new actionable layout issue in the Arabic320, original-fallback1440 and both-withdrawn320 views. The finalised-negative390 screenshot displays the beginning of the mock rather than the specific withdrawn target; it is not visual proof of that target. The scoped finalised-mock assertion is recorded separately from screenshot coverage.

Each authorized actual suite ran once. A Windows observer preload initially used a drive path instead of a file URL and failed before loading the classifier or acquiring a fixture; its setup log is preserved. The explanation classifier emitted a PostgreSQL client concurrency deprecation warning, retained with its successful result. No runtime fix, retry policy, provider call or live-data operation was used to obtain these passes.

## Evidence and cleanup

Raw logs, source hashes, screenshots and exact fixture receipts are held in ignored local QA material under the execution IDs `PILOT-C06-CORE-PG-20261003-C`, `PILOT-C06-CONSUMER-PG-20261003-B`, `PILOT-C06-RETAINED-C03-20261003-B`, `PILOT-C06-OFFLINE-20261003-B` and `PILOT-C06-ACCEPTANCE-20261003-A`. They are deliberately excluded from commits.

Author and coordinator separately verified absence of the core and consumer schemas/roles/connections. The classifier suites created21 exact schemas and131 captured roles; together with retained C03, all22 exact schema families, roles and matching connections were independently verified absent. The isolated browser project's containers, volumes, networks, images, dedicated browser/runner processes, temporary profile/source copy and loopback listeners were also independently verified removed. The canonical checkout and existing learner database were not test targets.

## Remaining gates

Final publication and seven required hosted checks must pass on the published head before merge. These are synthetic technical checks, not qualified educational/native-language review, physical-device or assistive-technology acceptance, real provider evaluation, privacy/security/legal approval or production deployment. Human approval of actual content remains necessary.
