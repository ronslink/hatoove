# EXAM-S6: complete public DTZ admission

Execution EXAM-S6-20261003-A. Base is independently reviewed S5 d31a763a74e58bd8f36f2536bdb4d9040251e3c7. This is internal engineering; default runtime remains telc-only. It neither approves real content nor activates production, providers or payment live mode. S4, payments and S5 remain unmerged behind required hosted CI.

## One current admission decision

Implement current_release_eligibility(exam_id text, allowed_rights text[]) as a tightly scoped SECURITY DEFINER SQL function with fixed search_path, PUBLIC execution revoked, EXECUTE only for learner/payment roles. It returns minimal metadata, never task payloads, keys or private media paths. No payment content-table grants or worker privilege expansion.

New module server/owned-postgres/release-eligibility.mjs exports readCurrentReleaseEligibility(client, examId, {catalogue, lock=false}={}). Return {eligible,examId,releaseVersion,state,reason,completeForm:{formId,formVersion}|null}. Caller owns transaction; no historical parameter/cache. The wrapper applies configured catalogue and server content mode, passes narrowed configured rights, and optionally acquires exam7351 before querying. Invalid mode/rights fail closed. Preserve existing telc behavior. Internal-preview plus internal DTZ head retains labelled partial fixtures and existing per-resource checks. Public DTZ requires current available head, no self/resume block, and at least one actually valid complete_supported_written DTZ form. An unrelated invalid optional form does not hide a valid full package; every requested form still passes its own existing checks.

The SQL predicate independently validates the complete DTZ shape, section/family order and counts HV4/5/8/3, LV5/5/6/3/6, one SA A/B choice, timing1500/2700/1800, practice/mock playback once, exact immutable set/media/task/rubric references, supported writing policy, approved review and effective recognized rights. A scope label is insufficient. Intersect supplied rights with generated/licensed/commissioned; unknown never passes. SQL is the single full predicate; JavaScript must not duplicate it. A malformed reference/shape closes eligibility.

## All new admissions use it

Discovery and new work: listExams, new preparation creation, form catalogue/new mock after receipt lookup, hasObjectiveFamily, objective catalogue/direct read/new answer/nextPractice, writing task/rubric catalogue and new standalone attempt. Keep nextPractice eligibility and returned candidate consistent in one snapshot or recheck. Offers and new checkout admission use the same decision; exact historical checkout receipts/order reads/webhooks remain independent.

Mutations acquire owner7352 where already applicable, then exam7351, and reread eligibility inside their committing transaction. Package publication and rights decisions use the same exam fence. No request-supplied clock, process mode, approval or custom GUC can widen admission. Existing active-preparation lookup and exact start/payment receipts are idempotent resume, not new admissions.

Do not apply current admission to pinned run reads/resume, finalisation, saved writing/history/revisions, export/delete, credits, order reads or webhook reconciliation. Existing pinned rights rules still apply. Error codes stay compatible: unavailable preparation422 exam_unavailable; hidden resource/offer404; nonservable new writing binding422 task_not_servable. Lists filter ineligible DTZ.

## Restricted SQL backstop

Migration0034 adds guards for genuinely new preparations, mock runs, standalone attempts/evidence and learner-callable marking. Authoritative available DTZ heads require the complete predicate using recognized rights. Internal heads retain internal fixture behavior; SQL does not pretend to know Node process content mode. That mode and runtime allowlist remain API policy, explicitly outside this SQL backstop.

Attempt checks must allow valid continuations at commit: exact same-owner/exam/preparation/task/rubric parent submission lineage, or valid pinned mock_writing attachment. Use deferred validation because A/B selection inserts its attempt before its attachment. Never exempt a merely non-null parent. Only standalone item_evidence (mock_run_id IS NULL) is a new admission; protected pinned finalisation evidence remains independent. Preserve ownership/RLS, immutability, legacy rows and grants. Do not mutate earlier migrations. A privileged administrator can still publish content; runtime roles cannot.

## Acceptance and synthetic review fixtures

Prove default telc-only and internal partial DTZ compatibility; public partial/withdrawn/self-blocked/incomplete DTZ refusal on every admission route and direct ID; fully complete synthetic available DTZ success; either A/B prompt, reading, media or rubric approval/rights loss closes all new admission. Prove exact history/continuation/receipts and exam credits survive, forged SQL continuation exemptions fail, and real separate connections serialize rights/publication against admission in both orderings. Confirm configured rights narrowing, payment read/mutation restrictions, malformed metadata, and forward row preservation.

The ordinary importer cannot approve content. Tests may use a clearly labelled helper that imports only synthetic internal material into an ownapi_* disposable schema, applies simulated approval using that fixture's admin connection, then publishes a reference-only available release. No repository content is marked approved. Root owns shared tools/exam-s6-fixture.mjs, migration registry/old expected arrays/CI/spec, browser evidence and records.

## Ownership

Core author: migration0034-complete-dtz-admission.sql, release-eligibility.mjs, tools/exam-s6-core-pg-check.mjs (and focused offline check if useful). Admission author: preparations.mjs, mock-runs.mjs, adapter.mjs, packages.mjs, tools/exam-s6-admission-pg-check.mjs. Payment author: owned-postgres/payments.mjs and tools/exam-s6-payments-pg-check.mjs. Each needs its own branch/worktree, explicit ACK, checkpoint and expiry. Authors may import shared core/fixture commits after freeze; no overlapping edits. Independent review follows delivery.