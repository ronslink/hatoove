# EXAM-S0: exact versions, startup and deployment content policy

Execution EXAM-S0-20261002-A, [issue101](https://github.com/ronslink/hatoove/issues/101), base88fa268. This is the first implementation slice of the [adopted mock-preparation architecture](../../work/implementation/MULTI-EXAM-ARCHITECTURE-20261002.md). No preparation schema, DTZ release, live grading or payment integration is introduced.

## Exact objective identity

An objective task is identified by `(set_id, version)`. Discovery carries both. Reads require an explicit `version` query parameter; answers require `body.version`. Missing/invalid versions return422; an unavailable exact version returns404. There is no implicit v1 fallback. An explicit v1 continues to work under the deployment's content policy.

The client retains the selected tuple through load and answer and refuses a returned payload with a different identity. Obsolete loads cannot replace a later selection or a different view. Catalogue, opened task and mistake labels distinguish versions. Recommendation seen counts and latest mistakes use the exact set/version/item identity: answering v2 correctly does not clear a v1 mistake. Factual all-attempt activity totals remain activity totals, not readiness or cross-rubric grades.

## Startup and recovery

The learner shell starts hidden and inert. Verified session, account and saved settings/revision must load before rendering the selected route or accepting settings writes. Hash changes during startup select the eventual destination without starting owned view reads early. No default revision-zero write is used to bypass an unavailable settings read.

Transient failures show a visible retry. Successful retry uses the latest hash and saved language/date on the first usable render. Session invalidation/account change remains fenced and requires signing in again; retry cannot silently switch the page's owner. Existing active writing text remains recoverable on session failure.

## Deployment-only content policy

`B1PREP_CONTENT_MODE=public` requires approved content for new use and is the default when unset. `internal-preview` preserves the explicitly labelled generated/unreviewed local pilot; the supported Compose path sets this choice explicitly through `HATOVE_CONTENT_MODE` (local default `internal-preview`). An unknown mode fails closed.

Legacy review flags and adapter/request options may narrow access, never widen public policy. Rights remain independently required; unknown provenance is never accepted. New writing use checks the exact task and rubric. Historical owned work remains readable under its retained identity, including when new use is unavailable. This is an early deployment gate; it does not replace the later versioned package-release manifest or human approval.

## Feedback validation

Each returned criterion is matched by key and validated against its own allowed bands, regardless of order. Missing, duplicate, unknown and invented score/total fields remain refused. An unsupported rubric fails before grader invocation; assessment failure retains the submission and does not become an invented grade.

## Evidence boundaries

Use synthetic offline transport/policy checks, disposable PostgreSQL fixtures and the isolated Compose/browser harness. New regressions must fail against original behavior. Desktop/mobile screenshots prove the changed rendered states, not physical iPhone/Android or educational validity. The implementation result records actual executed evidence and remaining gates.
