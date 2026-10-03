# PILOT-O01 private invocation accounting and recovery evidence

3 October 2026, [issue127](https://github.com/ronslink/hatoove/issues/127), executions PILOT-O01-20261003-A/B/C and coordinator integration. The [frozen usage contract](../../docs/contracts/PILOT-O01-USAGE.md) governs this delivery. Source, focused acceptance, retained-fixture corrections and evidence records received independent review. Local checks, hosted CI, merge and product acceptance are separate states; actual publication/hosted status belongs to the issue and PR.

## Delivered behavior

Forward migration0038 adds private append-only invocation intents and observations. A worker commits one intent for each legitimate job claim before entering its grader. Claim replay is not permission to invoke again. The captured receipt is copied, validated and closed when the grader settles; conflicting or malformed capture stays invalid. Known usage survives rejected feedback, thrown values, lease recovery and late completion. Unknown transport, model, counters and cost stay explicitly unknown. Existing learner accounting remains one successful assessment and one debit.

Receipt persistence precedes assessment persistence. Accepted completion, saved P07 explanations, job completion and learner debit commit atomically under claim and owner/exam fences, with a deferred SQL check. Failed persistence or uncertain acknowledgements cannot create a successful assessment without its required receipt. Recovery discovers a finite unlocked candidate batch, then locks owner, exam and job in that order and rereads the claim. Terminal observations and definite nondispatch survive recovery; exhausted jobs refund once. Soft deletion and current review/rights checks fence completion, while hard owner deletion drops later appends safely.

Worker writes are protected functions; learner/auth/payment/PUBLIC cannot read or mutate raw telemetry. Account export obtains only owned safe facts in a verified repeatable-read, read-only snapshot. Account deletion removes observations and intents before their jobs, participates in rollback and verifies absence. Migration0038 SHA256 is `d297595a2974361574bc61c5cc45e61ee5c6697d9bc2a91b61159fc9aae7091a`; earlier migration checksums remain unchanged.

The private `tools/provider-usage-report.mjs` CLI reports one coherent snapshot, with latest observations counted once in the selected intent cohort. The window is at most31 days and the cohort at most100000 intents; oversized reports fail rather than return a partial result. Queue metrics cover all current outstanding work, including older jobs. Null measurements differ from measured zero, currency buckets remain separate, and exact synthetic estimates use decimal-string/BigInt arithmetic. Actual spend is always `not_measured` and worker liveness is `unobserved`. Worker and reporting CLIs emit only fixed safe error codes; raw provider errors, learner text, identifiers and configuration values are excluded from their logs.

## Authorship and independent review

| Slice | Author delivery | Independent review and integration |
|---|---|---|
| A SQL, pure contract and data/adapter | 70c1de66 plus816d99b | Coordinator complete source review; B SQL-R1 clear after null-token and numeric canonicalization corrections; adopted1641db5/26c2230 |
| A worker, private CLIs and capture guards | 644a783,6a5f8cb,b28482c | Coordinator worker/transaction review and C pure/privacy review clear after corrections; adopted e698b04/278b86c/64e2438 |
| A focused acceptance scripts | 2d083a331d323c48bbf6654be6e0b399fde173a5 | Coordinator reviewed fault/race/mutation controls; B independently checked the direct-query null-token discriminator; adopted ebb3dfb |
| B private table classification | 4f50313 | Coordinator independently reviewed global ID uniqueness, exact guard authority and mutation controls; adopted1b903ce |
| C Docker packaging and smoke checks | 3963873,12ff9f8,cfca65f | Coordinator independent review required full-row fingerprints, exact stderr and fresh HTTP connections; adopted e84c455/c786d54/a872f5c |
| Coordinator registry, CI and retained fixtures | 779f409,6e6e5ee,6afe7ea,4610ede,0448f0c and CI follow-up | B/C independently cleared assigned changes; retained execution listed below |
| A retained S0 PostgreSQL fixture | 1967b5b238b4d06ba36067ee9b6ff243e36e9214 | B reviewed synthetic provenance; C independently cleared final exact-code and active-content expectations with final6/6 log |

Review closed missing post-call review/rights fences, falsy thrown-value classification, a caller-controlled array iterator, unhandled pool-error disclosure, incomplete observation validation, SQL null authorization and numeric spelling/replay mismatches. Tests now distinguish a failed pre-intent commit from never attempting an insert, and a direct SQL refusal from a later deferred-constraint failure. No author served as the independent reviewer of their own slice.

## Actual local validation

PostgreSQL checks used fresh guarded `ownapi_*` schemas on the assigned loopback62563/hatoove_spike fixture. Focused guards refuse other targets before connection. The sole hosted alternative requires explicit ALLOW, CI and GITHUB_ACTIONS flags with loopback5432/hatoove_ci. No learner service, production migration, live provider, real price or live payment was used.

| Check | Actual result |
|---|---|
| Focused pure receipt/capture/arithmetic/privacy | 15 passed; coordinator independently reran final source |
| Focused real PostgreSQL | 32 passed by A on clean2d083a3 and independently rerun by coordinator on integrated source; both generated schemas and every role verified absent |
| Private table classification | 173 actual mutations detected by B and independently rerun by coordinator |
| Retained classifier checks | 20 passed by B |
| Final isolated Docker Compose | 40 passed by C, including OpenAPI51; cleanup evidence independently reviewed |
| Worker runner / S5B worker / P07 worker | 14 /13 /12 passed by A |
| P07 admission/export/deletion / HTTP API / pure worker | 10 /6 /7 passed in author acceptance |
| Owner deletion / content-review admission / worker process wiring | 20 /25 /5 passed by coordinator |
| S0 offline / PostgreSQL | 8 /6 passed; PostgreSQL final source1967b5b, reviewed correction of obsolete synthetic-review fixture |
| Historical S3 / S4 / media / S5B / payments PostgreSQL | 10 /17 /19 /16 /18 passed by coordinator |
| Offline baseline | design14 with two existing warnings, retired10, origin8, keymask14, ownedAPI34 memory, ownedclient32 |
| Owned PostgreSQL API | 34 passed by coordinator on final assembled runtime |
| Migration EOL / workflow shape | 5 /12 passed |

The32 focused groups include actual separate-connection waits in both lock orders, competing reclaimers, bounded batches, same-owner refunds across exams, crash/unknown-acknowledgement checkpoints, receipt plus malformed feedback or all five falsy thrown values, stale and late completion, both deletion orders, rights/review withdrawal, direct SQL negative controls and a rollback-only authorization mutant. Reports test coherent concurrent append/delete snapshots, exact window edges, old outstanding jobs, explicit null/zero coverage, latency ranks and an actual100001-intent refusal. Export, deletion rollback and private sentinels are tested through real restricted roles.

Retained fixtures were corrected without loosening production policy: forward-migration arrays append0038; the worker crash test waits for actual grader entry before expiring only its exact claim; S0's fake pool returns the persisted assessment used by P07; the C03 test distinguishes migration-function-owner reads from unbound learner/deletion denial. S0 PostgreSQL setup now records named synthetic review decisions for exact subjects instead of relying on raw approved flags. Its active unreviewed rubric keeps owned text/history/export available while withholding protected task/rubric prose: new creation returns422/task_not_servable, while revision/submit/retry return409/review_blocked. All six behavior purposes, no-write fingerprint, preview control, approved-pair positive control and unsupported-rubric refusal remain; the latter also asserts no invocation intent. Existing rollback and ownership controls remain.

## Compose, CI and execution limits

Final Compose source `cfca65ff055c7b8f289c3fed12c3361c91254012` has the same tracked runtime/image/checker source as integration0448f0c. Eleven of the166 compared input files differ only in checkout LF/CRLF line endings; migration0038 bytes match exactly. Project `hatoove-check-1791056285363-17696` used app57209 and database57210. Its40 passes include receipt/report packaging, safe logs, unchanged saved-row fingerprints, account recovery and the OpenAPI51 check. Account deletion is covered by its separate20-case suite. The preceding project `hatoove-check-1791056078784-17244` stopped after11 passes on a stale HTTP keepalive socket; the checker now explicitly closes each connection, and the full fresh run passed. No uncertain POST was retried. Both generated projects have no remaining containers, probes, volumes, networks, image tags, scratch directories or sentinels. Ignored detailed evidence remains with the author under `.qa/pilot-o01-compose/`.

CI adds focused pure checks on both operating systems and focused PostgreSQL/classifier checks in the existing database job. The pure CLI tests require the locked `pg` client package even without a database service; CI explicitly installs that existing dependency. Workflow shape passes, but actual hosted execution remains a separate requirement. Predecessor PR126 and the earlier stack cannot start required jobs because of the recorded GitHub account billing/spending restriction. No local pass substitutes for hosted CI or authorizes merging.

Exploratory failures are not counted as acceptance. An early deletion gate hang was corrected and its exact fixture cleaned. Parallel fixture bootstrap conflicted on a database-level grant update, so subsequent bootstraps were serialized. A100001-row single-account delete took over four minutes and its exact verified backend was cancelled; the final cap test uses verified schema teardown for that volume cohort. Normal-size deletion, rollback and both-order races pass, but production-scale erasure performance is not established. Final focused fixtures `ownapi_bae497ea8fd6c5d4` and coordinator `ownapi_4641924fe64091d7`, final S0 fixture `ownapi_6d8a9c3dc43a8390`, classifier `ownapi_2c0c72772c6093b0` and all recorded exploratory schemas/roles were verified absent. Coordinator independently checked both Compose project labels for zero containers, volumes, networks and image tags; author separately checked probe/scratch/sentinel absence.

## Remaining gates

This delivers stub-based engineering and synthetic estimates. No current provider pricing, bill reconciliation, production monitoring/liveness, retention decision or large-account erasure performance is claimed. Native/educational content and audio review, physical iPhone/Android checks, assistive-technology acceptance, security/privacy/legal/D10 decisions, evaluated provider economics and commercial/live-operation approvals remain open. There is no learner UI change in this slice. Required hosted CI, stack integration and product acceptance remain outstanding.

## Actual hosted execution and corrections — 20:14 UTC

[PR128](https://github.com/ronslink/hatoove/pull/128) was published at76ab6b23. Unlike the earlier blocked runs, actual hosted runs37149870239/37149870362 executed steps: both offline baselines and fixture checks passed, while four policy gates exposed three distinct issues. The account restriction has therefore cleared for these runs; the earlier blocker description above is historical, not current. PR114 and PR116 subsequently passed all seven policy gates and merged as dc3b3ca2 and bbf82da5; the remaining stack is not merged.

The explanation registry pinned raw Windows CRLF seed bytes, so Linux's unchanged LF checkout incorrectly declared the source language unknown. Author B a41a1d1, adopted b2dccd5, fixes this real portability defect by pinning exact bytes after CRLF-to-LF replacement only. It performs no trimming, BOM removal, JSON normalization or content inference. Canonical SHA256 is `40a0a06616a539c291be4db1b6644f83f6027cf0423be81343f0dd8a5ed205a6`. Actual original/current module controls show original LF=null/CRLF=de and fixed LF=de/CRLF=de; altered source, whitespace, BOM, bare CR and reserialization remain unknown. All18 focused checks passed, independently rerun by coordinator.

The retained export checker expected12 queries before later playback/timing/explanation additions. The same reviewed B commit now enumerates all16 exact owner-scoped query classes, rejects unclassified/raw provider reads and verifies the protected provider export helper; tombstone and lock controls remain. All7 checks pass, independently rerun.

Two PostgreSQL fixtures inserted attempts through admin auto-commit without the owner context required by the deferred C03 guard. Author A ae376080, adopted36892cb, moves synthetic writes into the appropriate owner-bound restricted transaction through COMMIT. New no-owner/wrong-owner controls prove the valid INSERT reaches deferred rejection; the specific missing-task FK negative and valid binding positive remain. Actual standalone wrapper10/10 and persistent provisioning6/6 pass; coordinator independently reviewed both complete diffs and final raw evidence. Exact generated schemas/roles were verified absent. Runtime authorization and content policy were not weakened.

These five source/test paths received independent coordinator review before adoption. The new head still requires actual hosted checks; no success is inferred from the repaired local cases. The separate language contract is frozen under [issue129](https://github.com/ronslink/hatoove/issues/129), with bounded public/auth and shell authors active; it is not implemented by O01.
