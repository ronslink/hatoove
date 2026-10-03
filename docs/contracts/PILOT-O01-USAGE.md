# PILOT-O01: private stub-only invocation accounting

Execution tracking: [issue127](https://github.com/ronslink/hatoove/issues/127). Independent CONTRACT-R1 correction review is clear. Decimal validation must require a full-input match and reject every whitespace character, including a trailing newline that JavaScript `$` alone can overlook; include that negative test.

Frozen coordinator contract, 3 October 2026, based on package design execution PILOT-O01-CONTRACT-20261003-A (source SHA-256 `1e0bc23c748bd603cc5b4e1a57f53de2a6821dedf4dc2b20c2bf637771f99cd4`). Coordinator independently reviewed capture, identity, arithmetic and privacy; inventory CONTRACT-R1 independently reviewed SQL, worker, export/deletion and reporting against current671b3e0. The one R1 correction below permits only the existing exact CI fixture alongside the assigned local fixture. Migration0038 is reserved. An author still needs a separate bounded path lease; this contract is not production, live-provider, real-price or retention approval.

Integration base is PILOT07 PR126 `671b3e0bdfda401a49980a90c3db5fec9982d10b`, with identical relevant runtime to the author's inspected286b27f. The ignored proposal/review records remain local; the five required design corrections and baseline compatibility refinements are incorporated here. No implementation or runtime test result is claimed by this design freeze.

## 1. Outcome and boundaries

Record one durable invocation intent per legitimate writing-job claim and append immutable observations of that invocation. Preserve actual or unknown usage even when the grade is invalid, stale, rejected by a rights/review fence, or never accepted. Produce a private aggregate report. The existing `usage_ledger` remains exactly one learner unit per successful assessment; it is not provider usage and must not be used to infer tokens or cost.

The shipped path remains the deterministic local grader. Injected graders and price cards are synthetic test seams only. There is no live transport adapter, environment switch enabling one, provider poller, automatic pricing download, invoice ingestion, new queue, browser dashboard or public telemetry endpoint. Saved-explanation creation remains part of the existing successful-assessment transaction; stored explanation reads, language switches, history, exports and revision reads invoke no grader and create no invocation intent.

The delivery label is **stub-only O-01 engineering**. Supplier/location evidence, live-provider evaluation and authorization, current prices, invoices, production alerts, retention periods, backups and legal decisions remain open. Synthetic prices establish arithmetic only. No data migration may backfill historical jobs as zero-cost or infer historical invocations from `tries`.

## 2. Frozen vocabulary and limits

These are closed enums. They are not arbitrary strings validated by a regular expression.

| Name | Values |
|---|---|
| operation | `writing_assessment` |
| transportMode | `local_stub`, `synthetic_fixture` |
| transportStatus | `response`, `definite_not_sent`, `uncertain` |
| disposition | `pending`, `accepted`, `rejected`, `stale`, `failed`, `skipped` |
| usageBasis | `reported`, `missing`, `not_applicable`, `unsupported` |
| receiptIssue | null, `invalid_receipt`, `conflicting_receipt`, `unrecognised_model` |
| elapsedIssue | null, `unavailable`, `out_of_range` |
| costStatus | `estimated`, `unknown`, `not_applicable` |
| costReason | null, `missing_observation`, `uncertain_transport`, `missing_usage`, `unsupported_usage`, `invalid_receipt`, `missing_card`, `model_unknown`, `model_mismatch`, `missing_billable_dimension` |
| observation failureCode | null, `grader_error`, `invalid_assessment`, `unsupported_rubric`, `content_unavailable`, `lease_reclaimed`, `retry_exhausted`, `claim_stale`, `attempt_deleted`, `dispatch_not_started` |

Telemetry persistence errors are fixed operational errors, not evidence that a supplier returned an error: `provider_intent_failed`, `provider_observation_failed`, `provider_identity_invalid`, `provider_observation_invalid`, `provider_event_conflict`, `provider_head_conflict`, `provider_parent_deleted`, `provider_report_invalid`, `provider_report_too_large`, `provider_report_unavailable`. They must not copy database error messages, SQL, constraint data, provider messages or input values into logs/public errors.

Constants exported by the pure module:

```js
PROVIDER_ATTEMPT_SCHEMA_VERSION = 1
MAX_USAGE_COUNT = 1_000_000_000_000
MAX_ELAPSED_MS = 86_400_000
MAX_REPORT_WINDOW_MS = 31 * 24 * 60 * 60 * 1000
MAX_REPORT_ATTEMPTS = 100_000
DEFAULT_RECLAIM_BATCH_SIZE = 25
MAX_RECLAIM_BATCH_SIZE = 100
```

All receipt counters are `null` or JavaScript safe integers in `[0, MAX_USAGE_COUNT]`; reject booleans, strings, NaN, infinity, fractions, negative zero and numbers outside the bound. Explicit zero is valid. SQL uses bounded `bigint`; the JS reader converts only after checking the same bound. Elapsed time is null or an integer in `[0, MAX_ELAPSED_MS]`, measured by the worker using a monotonic clock. It is never accepted from a receipt. Out-of-range/invalid clock measurements become null with `elapsedIssue`; never clamp a long call to the limit.

Use `usageBasis` consistently in JS and DTOs, and `usage_basis` in SQL. No second independently interpreted `usage_status` field.

## 3. Trusted identities and pricing

`server/provider-attempt-contract.mjs` owns an immutable code registry, not a database pricing registry or an environment-provided JSON blob. An identity selector has exactly `{adapterId, pricingCardId}`. Unknown keys or values fail before dispatch. The registry supplies every persisted identity string. No result/receipt can supply an adapter, provider, prompt version, currency or rate card.

Frozen registry identifiers for this slice:

| adapterId | providerId | transportMode | requestedModel | promptVersion | reported model allowlist |
|---|---|---|---|---|---|
| `local-telc-stub-v1` | `none` | `local_stub` | null | `stub-grader-v2` | `stub-grader-v2` |
| `local-dtz-stub-v1` | `none` | `local_stub` | null | `dtz-simulation-v1` | `dtz-simulation-v1` |
| `synthetic-grader-v1` | `synthetic` | `synthetic_fixture` | `fixture-model-a` | `synthetic-prompt-v1` | `fixture-model-a`, `fixture-model-b` |

`adapterVersion` equals the selected `adapterId` for version 1. There are no aliases initially. An exact recognized alternate reported model remains distinct. Arbitrary unknown model strings become `modelReported:null` and `receiptIssue:'unrecognised_model'`; their bytes must not survive normalization, exceptions, logging, export or hashing. A syntactically plausible secret is still an unknown model. Assessment `modelVersion`/`promptVersion` retain their existing independent validation and storage; do not copy their arbitrary custom-grader strings into this ledger.

Only the actual built-in worker path (no injected `grade` function) can select a local identity, using its already resolved writing policy. Capture the existing `trustedBuiltin` decision before introducing any metering wrapper; wrapping the real built-in path must not accidentally turn off its existing P07 dictionary representations. Injecting `stubGrade` itself or a wrapper still selects `synthetic-grader-v1`; it must not impersonate a free built-in invocation or change P07 translation provenance. Add optional trusted `createWorker({providerIdentity})` for synthetic fixtures: it accepts the selector above only with an injected grader and rejects a local selector. Default injected identity is synthetic with no card. This option is never accepted from HTTP, learner settings, a submission, grader return data or environment JSON.

Price-card IDs are null, `synthetic-usd-v1`, or `synthetic-eur-v1`. Only synthetic identities may select them. These are explicitly artificial test cards, with no supplier or market-price claim. Both cover only `fixture-model-a`, have schema version 1 and this closed shape:

```js
{
  schemaVersion: 1,
  cardId: 'synthetic-usd-v1', // or synthetic-eur-v1
  currency: 'USD',          // EUR for synthetic-eur-v1
  modelIds: ['fixture-model-a'],
  unit: 1_000_000,
  inputRate: '2', cachedInputRate: '0.5',
  outputRate: '4', reasoningOutputRate: '4'
}
```

The EUR card uses the same arbitrary numbers solely to exercise separate-currency accounting. No exchange-rate equivalence is implied. Pure arithmetic tests may pass other closed synthetic card objects to `estimateAttemptCost` through a constructed synthetic identity; that helper validates the same closed shape, decimal bounds and units. Runtime `validateProviderIdentity` returns only registered immutable cards, and SQL independently enforces them. This test seam does not add an HTTP, environment or arbitrary runtime price input. Runtime SQL accepts only the exact registered card payload/hash for its ID; a grammar alone must not permit arbitrary private strings in a card ID or model list.

Pin the normalized card and its lowercase SHA-256 on the intent. Canonical JSON uses the explicit field order above, UTF-8, no whitespace, and the model array in registry order. Identity hashing serializes the `ProviderIdentity` fields in the exact order in section 4, including its canonical card value, with no owner/job/time fields. SQL must reconstruct these fixed ordered bytes rather than hash PostgreSQL jsonb display text and assume it equals JSON.stringify. A change to the registry needs a new versioned ID and review; old snapshots are immutable. A changed selector in the same job claim conflicts with the existing intent. A new selector requires a new legitimate claim, not another caller-generated UUID.

## 4. Pure module contract and capture lifetime

Exports from `server/provider-attempt-contract.mjs` are the constants above and:

```js
validateProviderIdentity(selector, {builtin, policy}) -> ProviderIdentity
normalizeUsageReceipt(raw, identity) -> NormalizedUsageReceipt
estimateAttemptCost(identity, observation) -> CostFact
createUsageCapture(identity) -> {captureUsage, close}
```

The first three are pure, synchronous and do not read environment variables or perform I/O. Returned records are newly allocated/deep-frozen, never aliases of caller objects. All validation errors expose only fixed codes. `policy` is the already resolved trusted worker policy, not a learner string. SQL wrappers verify the same registry identity rather than trusting JS alone. `estimateAttemptCost` accepts null observation explicitly and returns unknown/missing_observation with the pinned currency/hash if any.

```ts
type ProviderIdentity = {
  schemaVersion: 1; adapterId: string; adapterVersion: string;
  providerId: 'none'|'synthetic'; operation: 'writing_assessment';
  transportMode: 'local_stub'|'synthetic_fixture';
  requestedModel: null|'fixture-model-a'; promptVersion: string;
  pricingCardId: null|'synthetic-usd-v1'|'synthetic-eur-v1';
  pricingCard: null|PriceCard; pricingSha256: null|string;
};
type NormalizedUsageReceipt = {
  modelReported: string|null;
  inputTokens: number|null; outputTokens: number|null;
  cachedInputTokens: number|null; reasoningOutputTokens: number|null;
  usageBasis: 'reported'|'missing'|'not_applicable'|'unsupported';
  receiptIssue: null|'invalid_receipt'|'conflicting_receipt'|'unrecognised_model';
};
type CostFact = {
  costStatus: 'estimated'|'unknown'|'not_applicable';
  costReason: string|null; currency: 'USD'|'EUR'|null;
  estimatedAmount: string|null; pricingSha256: string|null;
};
```

Raw receipt allowlist is exactly `modelReported,inputTokens,outputTokens,cachedInputTokens,reasoningOutputTokens,usageBasis`. Require a plain record with own data properties, no accessors/symbol keys, and no coercion of objects into strings. No owner/clock/rate/error/transport/request-ID fields. Unknown keys or invalid count relationships invalidate that capture; their values are never serialized. Omitted counter/model keys normalize to null. `usageBasis` is required. `reported` allows partial counters. `missing` and `unsupported` require all counters null. `not_applicable` is worker-owned for the actual built-in stub and has null counters: absence of tokenization is not a measured token count of zero. An injected grader cannot claim this status. Cached input is a subset of total input; reasoning output is a subset of total output. Non-null subset requires non-null total and must be no larger. Other unit or inclusion conventions are unsupported, never guessed.

The grader return shape stays exactly `{feedback,modelVersion,promptVersion}`. Invoke it with a second argument `{attemptId,captureUsage}`. Existing functions may ignore the argument. The callback is synchronous and returns only `{accepted:true,replay:boolean}` or `{accepted:false,code:'invalid_receipt'|'conflicting_receipt'|'capture_closed'}`; it does not throw receipt text into the grader. It normalizes and clones immediately while open:

1. First valid normalized capture becomes the fixed receipt value. Identical later normalized capture is a harmless replay. Input mutation after capture cannot change it.
2. Any malformed capture makes `invalid_receipt` sticky. A different second valid capture makes `conflicting_receipt` sticky, taking precedence over invalid. Preserve the first valid model/counters; do not replace or erase them. A later valid capture after an invalid one may supply the first valid counters but cannot clear the issue.
3. Invalid/conflicting capture affects metering confidence, not assessment validity. A separately valid assessment can succeed; its cost remains unknown. A valid receipt can remain usable when feedback fails validation.
4. Worker closes capture in its own fulfillment/rejection settlement handler before validating feedback or starting persistence. `close()` is idempotent and returns the frozen effective receipt. If none was valid, return missing usage, or unsupported usage with invalid/conflict issue if a malformed capture occurred. Further callback calls return `capture_closed` and have no effect, including no new observation or log containing input.
5. This is closure when the worker observes promise settlement, not an impossible guarantee about a callback queued before its settlement reaction. Test both fulfillment and rejection handlers, synchronous throws, resolved promises, and callbacks held until after the worker's settlement handler. A late completion of the original grader promise after lease reclamation is different: its capture remains open until that promise settles and may then be recorded on its original intent.

Built-in path synthesizes a trusted not-applicable receipt with the exact known stub model identifier. Missing captures from custom graders stay missing; do not parse feedback or tokenize learner text to fill counters.

## 5. Exact arithmetic and confidence

Price decimal grammar is `^(0|[1-9][0-9]*)(\.[0-9]{0,11}[1-9])?$`, so `0.5` is valid. It is a canonical integer optionally followed by a decimal point and 1–12 digits with a nonzero final digit. At most 12 integer digits. Reject exponents, signs, whitespace, separators, trailing fractional zeroes, NaN and numeric JSON prices. The `unit` is exactly 1, 1,000 or 1,000,000. Rates are nonnegative strings. Optional `cachedInputRate`/`reasoningOutputRate` may be null in pure test cards, meaning the respective subset uses the total's base rate; never charge that subset twice.

Convert decimal strings to integer coefficient plus scale, and use BigInt arithmetic throughout. For each dimension, divide by the power-of-ten unit by increasing the decimal scale. With the bounds above, amount has at most 30 integer digits and 18 fractional digits; canonical output omits trailing fractional zeros and uses `0` for exact zero. No rounding is necessary or permitted. Persist amount as checked canonical text, not a JavaScript number or an unconstrained numeric JSON value. Summaries also sum coefficients exactly and output canonical decimal strings; token totals are base-10 integer strings to avoid aggregate overflow.

For total input I, cached subset C, total output O and reasoning subset R, bill `(I-C)*inputRate + C*cachedInputRate + (O-R)*outputRate + R*reasoningOutputRate`, all divided by unit. If a subset rate is null or exactly equal to its base, collapse that pair to total times base; its missing subset count does not affect the bill. If a subset has a different rate, its missing count makes the **entire** cost unknown. Do not present a partial input-only estimate as a complete attempt estimate. Non-null counts still remain available as partial usage facts.

Cost invariants are enforced in JS and SQL:

- `estimated`: synthetic mode, `response`, `usageBasis=reported`, no invalid/conflicting issue, recognized reported model covered by the pinned card, all billable totals and differently priced subsets known. Amount, currency and pinned hash are non-null; reason null. Exact zero is allowed only from those complete facts.
- `unknown`: amount null and fixed non-null reason. Currency/hash may reflect a pinned card even when usage/model/transport is unknown; otherwise they are null. A known currency does not imply a known amount. Reason precedence is uncertain transport, invalid/conflicting receipt, unsupported usage, missing usage, missing card, unknown model, uncovered model, missing billable dimension.
- `not_applicable`: actual built-in local mode with a settled, captured trusted `usageBasis=not_applicable` receipt and response transport only, amount/currency/hash/reason null. An intent or reclaim placeholder alone is insufficient. Report it as no external-provider billing by construction, separately from measured usage. Do not sum it as a measured price of zero.

`unrecognised_model` leaves other valid usage counters intact but makes cost unknown. `response` does not itself prove usable usage. An uncertain transport with a price card is unknown even if some captured dimensions exist. There is no `actual` cost state.

## 6. SQL persistence and authority

New migration `server/migrations/0038-provider-attempts.sql` creates only two account-owned private tables plus their guards/functions/indexes and the minimum parent uniqueness constraints. No existing history migration is edited.

`provider_attempt` columns:

| Column | Type / invariant |
|---|---|
| attempt_id | UUID primary key, generated by the begin function |
| owner_id, exam_id | text, derived from the exact job/submission/attempt chain |
| job_id, submission_id | UUID, derived; exact same-owner composite foreign keys |
| claim_number | positive integer, copied from locked `jobs.tries` |
| created_at | timestamptz, server `clock_timestamp()` at insertion |
| schema_version | integer 1 |
| adapter_id, adapter_version, provider_id, operation, transport_mode | closed registry values |
| requested_model, prompt_version | registry values/null, never grader-supplied |
| task_id, task_version, rubric_id, rubric_version | exact immutable bound attempt identity, DB-derived |
| pricing_card_id, pricing_card, pricing_sha256 | all null or the exact canonical registered synthetic card/jsonb/hash |
| identity_sha256 | canonical normalized public operational identity plus pinned card hash; no learner text |

Unique `(job_id,claim_number)` and `(attempt_id,owner_id,exam_id,job_id,submission_id,claim_number)`. The claim number always comes from persisted `jobs.tries` after its legitimate claim increment; manual retry preserves tries until the next claim. Never compute it from telemetry row counts, a callback or a separate reset counter. Add a composite unique identity on jobs if needed for `(id,owner_id,exam_id,submission_id)` and reference that exact tuple. Existing submission `(id,owner_id)` FK also applies. Do not use a content ID supplied by the receipt. No lease token, token hash, provider request ID, raw error, arbitrary context JSON or text hash is stored.

`provider_attempt_observation` columns:

| Column | Type / invariant |
|---|---|
| event_id | UUID primary key, caller-generated stable retry receipt |
| attempt_id, owner_id, exam_id, job_id, submission_id, claim_number | exact composite FK to intent, derived by function |
| revision | integer 1..1,000,000; unique `(attempt_id,revision)` |
| previous_event_id | null exactly for revision 1; otherwise exact preceding event in same intent |
| recorded_at | timestamptz, server `clock_timestamp()` |
| event_sha256 | canonical allowed command fingerprint, excluding server-derived time/revision |
| transport_status, disposition, failure_code | closed enums above |
| model_reported, usage_basis, receipt_issue | normalized safe values |
| input_tokens, output_tokens, cached_input_tokens, reasoning_output_tokens | bounded nullable bigint, subset checks |
| receipt_captured | boolean; false for reclaim/no-receipt placeholder, true when grader has settled with its normalized effective receipt |
| elapsed_ms, elapsed_issue | bounded nullable integer and fixed reason |
| cost_status, cost_reason, currency, estimated_amount, pricing_sha256 | derived from intent plus receipt; caller cannot choose money |

No mutable observation-head table is needed. Lock the immutable intent tuple to serialize append/head checks; insert the next full snapshot. Index latest revision per attempt, intent `created_at`, and owner deletion paths. Every row is immutable; UPDATE/TRUNCATE refused. Only the existing deletion role can delete under its exact bound owner and deletion protocol. Both tables use FORCE RLS. Runtime learner/auth/payment roles and PUBLIC have no raw SELECT/INSERT/UPDATE/DELETE/TRUNCATE, including no column grants. Worker has SELECT for its internal report and EXECUTE on the two write functions, not raw INSERT/UPDATE/DELETE/TRUNCATE. Deletion has scoped SELECT/DELETE. The function-owning role has the explicit narrowly required policies/authority to operate under FORCE RLS; no learner owner policy is added to make a generic test pass. Schema-owner migration authority is not a runtime grant.

Classify both tables as **private-owned telemetry**, separately from the ordinary account-owned classification whose generic test expects learner SELECT. That new classification must test owner/composite identity, deletion membership, FORCE RLS and the explicit denied raw table/column grants for learner/auth/payments/PUBLIC. Coordinator owns this classifier change. Neither inheriting the ordinary learner-read policy nor disabling RLS is an acceptable integration shortcut.

Security-definer functions are schema-qualified with fixed `search_path` containing only `pg_catalog` and the explicit installed schema; revoke PUBLIC execution explicitly, including helper functions. Write functions verify the actual allowed worker role, resolve parents before owner7352 → exam7351 → job → intent tuple locks, and reread after locks. No caller-supplied GUC alone grants write authority. Historical late observations do not require current content approval: this ledger describes an already attempted call, not renewed authorization to grade.

Frozen SQL entry points:

```sql
begin_provider_attempt(p_job_id uuid, p_lease_token uuid, p_identity jsonb)
  RETURNS TABLE(attempt_id uuid, created boolean);
append_provider_observation(p_attempt_id uuid, p_event_id uuid,
  p_expected_revision integer, p_observation jsonb, p_lease_token uuid DEFAULT NULL)
  RETURNS TABLE(status text, event_id uuid, revision integer, replay boolean);
export_owned_provider_attempts() RETURNS SETOF jsonb;
```

Functions receive only the named strict shapes; SQL recomputes/checks identity, safe enums, arithmetic and canonical event fingerprint. Stable conflict errors use fixed messages/codes. Append returns status `recorded` or `deleted`; deleted has null event/revision and false replay, without revealing an unrelated parent's existence. Absent intent is treated as deleted by the worker; it never recreates one. Begin absent/stale job is a fixed refusal, not an empty dispatch grant.

`begin` accepts only a running exact-token job with `lease_until > clock_timestamp()` and positive claim count. Recheck the existing package/rubric/content/rights gates in its caller's same owner/exam-fenced transaction before invoking it; the function's claim check is not a replacement for those gates. An existing same-claim, same-identity intent returns `created:false`; a changed identity conflicts. Even an exact replay **never authorizes another invocation**. On uncertain COMMIT outcome, do not dispatch. Recovery must legitimately reclaim and claim again.

Only a newly committed `created:true` receipt held by this invocation authorizes dispatch. Revalidate nothing by performing a second free-standing begin after it. No database lock/transaction remains open while the grader runs. This is an authorization point, not a claim that later review/deletion/reclaim changes are impossible during the gap before the call; completion rechecks them. A worker-known cancellation in that gap records definite_not_sent/skipped if its parent remains, otherwise drops it. A crash or uncertainty in the gap remains uncertain. Do not hold learner locks across grading in an attempt to remove that gap.

## 7. Observation transitions, replay and completion

`p_observation` has exactly `{transportStatus,disposition,failureCode,receipt,receiptCaptured,elapsedMs,elapsedIssue}`. `receipt` is the normalized shape in section 4. Cost and ownership are derived, never supplied. `expectedRevision=0` means no observation; otherwise it is the last seen head. Canonical event hashing covers `{attemptId,eventId,expectedRevision,observation}` in that exact order and normalized observation/receipt field order. It excludes the ephemeral lease token; the token is checked when authorizing a new terminal transition, never stored or hashed. Same event ID plus identical normalized command replays its original receipt **before** head/CAS/transition and current-token checks, provided its parent still exists. Changed bytes, another intent using the same event ID, or stale expected revision fail. No helper silently rebases or drops a conflict.

The worker may explicitly reread after a head conflict caused by reclamation, merge its still-held closed receipt according to these rules, and submit a **new** event ID; that is a new observation, not another grader call. Retry an unknown commit with the same original event/command first. At most three such reconciliation attempts per completion; exhaustion throws fixed `provider_observation_failed`, leaves durable facts intact and relies on bounded recovery.

Transport transitions:

| Prior state | Allowed next state |
|---|---|
| no observation | any of the three |
| uncertain | uncertain or response |
| response | response only |
| definite_not_sent | definite_not_sent only |

`response` means the trusted grader returned a result or captured its receipt; it is not a count of verified supplier network requests. A returned malformed assessment is still a response. A thrown grader error without a valid captured receipt is uncertain. `definite_not_sent` is only a worker-known cancellation after the intent but **before** calling the grader; a grader's arbitrary `error.code` cannot establish it. A crash between intent commit and dispatch remains uncertain when reclaimed.

Disposition transitions:

| Prior state | Allowed next state / condition |
|---|---|
| no observation | pending, or a directly known terminal outcome |
| pending | pending, accepted, rejected, stale, failed, skipped |
| any terminal state | the same terminal state only |

Terminal failure reason is preserved. Receipt-only late observations copy it. Accepted has null failure code. Rejected uses `invalid_assessment` or `content_unavailable`; failed uses `grader_error` or `retry_exhausted`; stale uses `lease_reclaimed` or `claim_stale`; skipped uses `attempt_deleted` or `dispatch_not_started`. Unsupported rubric discovered before dispatch creates no intent; if a dispatch preparation is cancelled after intent creation, use skipped/dispatch_not_started. A lost/deleted parent drops the observation instead of persisting a fake skipped owner row.

Once `receipt_captured=true`, later snapshots must preserve all receipt fields, including nulls and issue flags, and its transport status. Thus uncertain→response is for enriching an unsettled placeholder, not inventing a later response after the grader already threw and closed capture. Version 1 has no external receipt correction API. A placeholder with `receipt_captured=false` has null model/counters, usageBasis missing, null receiptIssue and null elapsed time; it may be enriched once by the original grader's closed receipt. Response implies receipt_captured=true; definite_not_sent keeps it false. Pending implies null failureCode. Non-null elapsed time requires elapsedIssue null and is immutable; null elapsed requires unavailable/out_of_range. No reclaim path invents or updates duration. A placeholder never replaces a received receipt, response, known count, estimate or terminal disposition.

Only existing lease-token-fenced successful completion may append `accepted`, with response transport and a settled `receipt_captured=true` snapshot (its usage may still be missing). Append verifies running job, exact current token, same claim and pending prior disposition, while owner/exam/job locks are held. A deferred constraint trigger requires that COMMIT also has the exact same-claim succeeded job, assessment and learner usage row. The ordinary completion transaction remains responsible for those writes and the successful reserved→used transition, including P07 representations. Append accepted before clearing the token inside that transaction; rollback removes it together with assessment/debit. A standalone worker append followed by COMMIT must fail its deferred assertion. Do not create a GUC-based accepted bypass.

The deferred assertion can verify persisted job/assessment/usage facts; it must not claim to infer an entitlement delta from a current counter alone. Prove the reserved→used transition through the existing locked transaction and balance/ledger consistency tests. No new duplicate debit mechanism is added. Preserve current completion semantics: it checks running status and exact token/claim, not lease_until. Expiry alone does not invalidate a finishing worker until reclaim changes the status/token. The stricter unexpired pre-dispatch check in section 6 must not silently change that retained completion rule.

Completion sequence:

1. Claim in the existing single autocommit SKIP LOCKED statement, which releases its tuple locks before any owner lock is acquired. Preserve existing assessment, entitlement and claim semantics.
2. Resolve task/rubric, check preconditions; under owner7352→exam7351→job take a fresh current-claim/content fence and commit one new intent. Pre-dispatch refusals with no intent incur no fabricated provider record.
3. Invoke grader once outside transactions; measure monotonic elapsed time, capture/close receipt. No hidden retry in an adapter. Freeze assessment and P07 representation inputs as currently required.
4. In a short fenced transaction, append the settled receipt with `pending`, unless the existing head is terminal, in which case preserve that terminal disposition. For a now-stale claim, finish it as stale in this same transaction. A failed observation transaction forbids a successful assessment commit; leave the job recoverable, throw the fixed infrastructure error and retain the intent/any prior facts.
5. Under the existing success/failure owner→exam→job fence, reread claim, soft-delete and current content/review/rights. Append the terminal observation in the same transaction as job success/failure/refund and assessment/explanations/learner debit, if any. Bad feedback becomes rejected/invalid_assessment; a grader exception becomes failed/grader_error; post-call withdrawal becomes rejected/content_unavailable. Content policy may block an assessment while its metering receipt remains recorded.
6. All early returns are covered: replacement/non-running claim appends stale if still pending; a retained soft-deleted attempt appends skipped if still pending; an already terminal head is preserved; a hard-deleted intent/owner yields no write. The submitted-and-soft-deleted branch is historical/defensive: current normal `remove()` refuses submitted attempts and must not be described as cancelling a submitted job. Exercise this branch only with an explicitly synthetic historical fixture. Late completion cannot touch the newer job assessment, refund its balance or add another debit.

If a success transaction's COMMIT acknowledgement is lost, its accepted observation already resides in that same transaction if it committed. Do not call the grader again. Exact event replay/read and normal job state determine the result; infrastructure uncertainty is not permission to regrade.

## 8. Bounded reclamation and lock order

Add `reclaimBatchSize` to `createWorker` options, default 25, integer 1..100. `reclaimExpired()` remains a single bounded pass returning exactly `{requeued,abandoned}` for compatibility. It does not recursively refill its batch. `now()` remains the existing trusted fixture clock for lease-expiry decisions; normal operation uses the real clock. Intent and observation timestamps remain database server timestamps.

Discovery is a plain finite SELECT of expired running job IDs and immutable owner/exam/claim identity, ordered by `(lease_until,id)`, LIMIT batch size. It must have **no FOR UPDATE/SHARE and no transaction that retains job tuple locks**. It does not authorize a transition.

For each discovered candidate, use a separate short READ COMMITTED transaction:

1. Acquire owner7352, then exam7351, then job `FOR UPDATE`. Do not take a job tuple while waiting for its owner's fence. Reread owner/exam/status/lease/claim and current time; a missing, renewed, completed or changed-claim candidate is skipped.
2. If that claim has an intent, lock it after the job and append a placeholder if no receipt exists. Preserve response/receipt/elapsed facts when already recorded. Requeueable claims retire to stale/lease_reclaimed; exhausted claims retire to failed/retry_exhausted. Do not overwrite an existing terminal disposition.
3. Atomically requeue or fail/refund that exact job with the observation. Missing intent is a valid pre-instrumentation or pre-dispatch case; perform the retained job transition without manufacturing an intent.
4. Commit, then move to the next candidate. Two reclaimers can discover the same candidate; only one passes its locked reread. Refund exactly once. No per-pass tuple-first bulk update is retained.

All ledger mutation helpers use owner→exam→job→intent→observation. Account deletion takes owner first and does not need to acquire exam locks: it already serializes that owner's complete operation before any affected tuples. Reviewer administration retains its existing exam-only ordering and never acquires learner owners/tuples. The existing claim statement may temporarily delay an owner-first operation but never waits for owner/exam while holding its claim tuple, so it cannot form that cycle.

Real race tests must hold actual separate backend connections and show blocking using `pg_blocking_pids`/observed lock state, not promise timing alone: reclaim versus completion in both lock orders; reclaim versus deletion in both orders; late observation versus deletion in both orders; two reclaimers and two workers. Assert completion/refund/debit/row absence after release and no 40P01. A deliberately tuple-first reclaim mutation must fail the discriminator. Include multiple same-owner expired jobs, different exams, candidates renewed between discovery and lock, and batch-size-plus-one work remaining for the next pass.

## 9. Data module and owned export

Exports from `server/owned-postgres/provider-attempts.mjs`:

```js
beginProviderAttempt(client, {jobId, leaseToken, identity})
  -> {attemptId, created}
appendProviderObservation(client, {
  attemptId, eventId, expectedRevision, observation, leaseToken = null
}) -> {status:'recorded', eventId, revision, replay}
   | {status:'deleted', eventId:null, revision:null, replay:false}
readProviderUsageSummary(client, {from, to}) -> ProviderUsageSummary
readOwnProviderAttempts(client) -> OwnedProviderAttempt[]
```

Write callers own an explicit READ COMMITTED transaction; helpers do not commit it. SQL enforces the isolation level; caller orchestration/tests must prove that prechecks and writes share the explicit transaction. Do not claim that PostgreSQL can distinguish an otherwise identical implicit/autocommit transaction merely from transaction_isolation. `readProviderUsageSummary` and `readOwnProviderAttempts` require caller-owned REPEATABLE READ READ ONLY transactions and reject wrong modes; CLI/export orchestration establishes the one shared snapshot. The report uses the worker connection; owned export uses the existing learner export connection and only `export_owned_provider_attempts()`.

The owned SQL function verifies the established learner role and session-derived `hatoove.owner_id`, filters exact owner, has fixed search_path and explicit grants/revocations, and returns no rows for any other owner. It takes no locks inside the read-only export snapshot. That snapshot is its authorization/read point; concurrent account erasure may complete after the snapshot without making an earlier authorized export retroactively inconsistent. No worker credentials enter HTTP export and no raw operational SELECT grant is added.

Append `provider_attempts` to existing export JSON. Each owned row has exactly:

```ts
type OwnedProviderAttempt = {
  attempt_id: string; submission_id: string; exam_id: string;
  claim_number: number; created_at: string;
  transport_mode: 'local_stub'|'synthetic_fixture';
  provider_id: 'none'|'synthetic'; requested_model: string|null;
  observations: Array<{
    revision:number; recorded_at:string; transport_status:string;
    disposition:string; failure_code:string|null;
    model_reported:string|null; usage_basis:string; receipt_issue:string|null;
    input_tokens:number|null; output_tokens:number|null;
    cached_input_tokens:number|null; reasoning_output_tokens:number|null;
    elapsed_ms:number|null; elapsed_issue:string|null;
    cost_status:string; cost_reason:string|null;
    currency:'USD'|'EUR'|null; estimated_amount:string|null;
  }>;
};
```

Rows are ordered `(created_at,attempt_id)` and observations by revision. Empty history is `observations:[]`, not a zero-valued fabricated receipt. Omit owner ID, job ID, event fingerprints/IDs, identity hash, price card/hash, prompt/task/rubric internals and any transport identifier. The linkage to the owner's submission and historical safe model/usage outcomes is sufficient. Existing export version/compatibility documentation is coordinator-owned; no mandatory global datastore capability is added for this private helper.

Hard deletion adds observation then intent steps **before jobs/submissions**, and both tables to `ACCOUNT_TABLES` absence verification. Keep one deletion transaction and owner fence. Soft deletion keeps existing retention semantics; it does not silently purge only the telemetry. After hard erasure, delayed begin/append fails or returns deleted and cannot recreate any row, reserve credit or store an owner hash/tombstone. Rollback/failure restores all rows with the rest of the account. Detailed rows follow the owner until the separately approved retention policy exists; this is not approval for indefinite production retention or a new purge job.

## 10. Coherent report and CLI

`tools/provider-usage-report.mjs` exports `main(argv=process.argv.slice(2)) -> Promise<0|1|2>` and supports exactly:

```text
node tools/provider-usage-report.mjs --from=2026-10-01T00:00:00.000Z --to=2026-10-02T00:00:00.000Z
node tools/provider-usage-report.mjs --help
```

Require each bound once, canonical UTC ISO with milliseconds and Z, round-trip-valid dates, `from < to`, window at most 31 days, and `to <= asOf`. Reject unknown/duplicate flags without echoing their bytes. Use existing restricted worker pool configuration; no admin fallback or provider environment discovery. This promises aggregate-only **output**, not aggregate-only credential authority: the existing worker role already reads learner submission text for grading. No new reporting role is created or falsely claimed. Exit 2 for usage/configuration validation, 1 for unavailable/failed reporting, 0 only for a complete aggregate result. Close its pool on every path. Help is static. Error output is a fixed `{event:'provider_report_error',code}` JSON line; no stack, configuration, URL or database text.

One caller-owned REPEATABLE READ READ ONLY transaction supplies the report. Its first materializing SQL statement captures database `date_trunc('milliseconds',statement_timestamp())` as `asOf` and takes the MVCC snapshot used by all report reads. Read/check transaction mode in this same first statement, not a separate earlier probe that establishes an unlabelled snapshot. Return asOf in the same canonical UTC millisecond format as the bounds and use that exact truncated value as the cutoff. Explicitly exclude intent/observation timestamps after `asOf`; make window and queue results from that same snapshot, never separate pool reads. `asOf` denotes this read snapshot/cutoff, not a later completion time. Bound input selects intents with `created_at >= from AND created_at < to`; late observations update that original intent cohort, never move the invocation to an observation-time window. Use LEFT JOIN LATERAL/latest-revision lookup so a never-observed intent remains in every denominator. Observation eligibility is visibility in the snapshot and `recorded_at <= asOf`.

Count selected intents first; if more than 100,000, return `provider_report_too_large` with no partial report or misleading subtotal. Narrowing the explicit window is the remedy; do not silently truncate. SQL aggregation of the all-current queue is independent of this intent row cap/window. No raw attempt/owner/submission/job IDs leave the report.

Frozen DTO:

```ts
type ProviderUsageSummary = {
  schemaVersion:1;
  asOf:string;
  window:{from:string,to:string,basis:'intent_created_at',bounds:'[from,to)'};
  scope:'stub_only_engineering';
  totals:{
    intents:number; withoutObservation:number; responses:number;
    uncertain:number; definiteNotSent:number;
    dispositions:{pending:number,accepted:number,rejected:number,stale:number,failed:number,skipped:number};
    estimated:number; unknownCost:number; notApplicable:number;
  };
  groups:Array<{
    providerId:string; requestedModel:string|null; reportedModel:string|null;
    operation:'writing_assessment'; transportMode:string; currency:'USD'|'EUR'|null;
    attempts:number; withoutObservation:number;
    estimatedCount:number; unknownCostCount:number; notApplicableCount:number;
    knownEstimatedSubtotal:string|null;
    estimateCompleteness:'complete'|'partial'|'not_applicable';
    usage:{
      input:{knownTotal:string|null,knownCount:number,unknownCount:number};
      output:{knownTotal:string|null,knownCount:number,unknownCount:number};
      cachedInput:{knownTotal:string|null,knownCount:number,unknownCount:number};
      reasoningOutput:{knownTotal:string|null,knownCount:number,unknownCount:number};
    };
    latency:{samples:number,p50Ms:number|null,p95Ms:number|null,maxMs:number|null};
  }>;
  queue:{
    scope:'all_current_outstanding'; queued:number; running:number;
    expiredRunning:number; oldestQueuedAgeMs:number|null;
    oldestExpiredAgeMs:number|null;
    unresolvedIntents:number; oldestUnresolvedIntentAgeMs:number|null;
    workerLiveness:'unobserved';
  };
  failures:Array<{code:string,count:number}>;
  realSpend:{status:'not_measured',amount:null};
};
```

Groups use the exact tuple of fields shown and stable lexical ordering with nulls first. Unknown model/currency buckets stay explicit; do not assign the requested model as if it were reported. For unobserved intents derive only pinned identity/currency, classify transport uncertain, disposition pending and cost unknown/missing_observation. Do not infer not-applicable cost until the trusted stub observation exists, although its intent transport class is already known.

`knownEstimatedSubtotal` is null when estimatedCount is zero, including entirely unknown groups. It is otherwise the exact sum of **latest** estimated observations once per intent. Completeness is complete only when every attempt in that group is estimated, not_applicable only when all are not-applicable, otherwise partial. Every usage dimension has its own coverage count; a known total of explicit zeros is `'0'`, while no measured values is null. Cache/reasoning totals remain subsets and are never added into a second combined token total.

Latency uses latest non-null elapsed values, including rejected/stale/failed responses, one sample per intent. Nearest-rank p50/p95: rank `ceil(p*n/100)` over integer ascending elapsed values. No samples yields all null, not zero. Reclamation timestamps are not latency measurements. Failures group the latest fixed failure code in the selected intent cohort only; no arbitrary error text. A job rejected before any intent is deliberately outside usage-cohort failures.

Queue metrics cover **all** queued/running jobs at `asOf`, even ones older than the requested window. Oldest queued age uses the existing submission created time and is labelled age since submission, not an invented queue-enqueued time; expired age uses lease_until. Unresolved intents are all visible intents whose latest transport is uncertain or whose latest disposition is pending, including no-observation intents, irrespective of the report window; age is since intent creation. They remain visible after retry exhaustion until an original late completion supplies a definitive observation or retention/deletion applies. Null oldest age means no qualifying row. Clamp only negative age due to a fixture/future timestamp to zero and do not use that to infer liveness.

Synthetic estimates never enter a real-spend subtotal. `realSpend` remains not_measured even when every synthetic receipt is complete. No observations, an idle queue or a responsive database prove worker liveness. Public `/api/health` and `/api/ready` payloads stay unchanged.

## 11. Log privacy and failures

Narrow `server/worker.mjs` output to fixed JSON records: `{event:'worker_started'}`, `{event:'worker_reclaimed',requeued,abandoned}`, `{event:'worker_outcome',outcome,code}`, `{event:'worker_stopping',signal}`, or `{event:'worker_error',code}`. Outcomes and signals come from closed internal enums; optional code is null or the fixed allowlist. No submission/owner/job/attempt IDs, raw argv, arbitrary error.message/error.code, SQL, key, endpoint, model response or configuration values. Missing configuration may identify fixed variable names only, never values. Help remains static. Preserve existing --once/interval/max-iterations and signal/drain semantics; reviewed process-fixture expectations may change only for the safer output shape.

The fixed error boundary covers argument parsing, persistentConfig, pool construction, worker construction, connection acquisition, every loop iteration and final pool cleanup, not just the current iteration try/catch. Preserve exit 2 for invalid CLI/configuration and exit 1 for infrastructure failure. Additional fixed CLI codes are `worker_arguments_invalid`, `worker_configuration_invalid`, `worker_initialization_failed`, `worker_iteration_failed`, `worker_cleanup_failed`; report CLI uses the provider_report codes in section 2. Never print a raw startup error because it happened before the pool/loop existed. Signal values are only SIGINT/SIGTERM. Report/worker construction must not leak keys through a top-level unhandled rejection or stack trace.

`failureCodeOf` no longer accepts a regex-matching arbitrary string. Use internal known outcome classification: assessment validation maps invalid_assessment; trusted pre/post gates map their existing fixed codes; all arbitrary grader-thrown values, including `{code:'secret_like_token'}`, map grader_error. Provider-shaped error text must not escape indirectly through a failed JSON parse or CLI parser. Existing test-only fault seams may carry errors in memory, but persisted/output values remain the fixed vocabulary.

No transcript, feedback, evidence quote, prompt, learner text/hash, email/IP, credential/header, endpoint, request/response body, arbitrary context or provider request identifier belongs in either table/report/log. Test private sentinel strings in *known* fields (modelReported, error.code, error.message, argument value, identity selector, card identifier), not only unknown keys. Verify DB rows, raw JSON output, stderr/stdout and owned export. Safe metadata must come from the registry or DB-derived immutable IDs, never merely satisfy a length/regex test.

## 12. Implementation ownership and acceptance

Recommended single backend author owns, only after a separate lease: `server/provider-attempt-contract.mjs`, `server/owned-postgres/provider-attempts.mjs`, `server/migrations/0038-provider-attempts.sql`, narrow worker/worker CLI/adapter integration, and `tools/provider-attempt-check.mjs`, `tools/provider-attempt-pg-check.mjs`, `tools/provider-usage-report.mjs`. Coordinator owns the migration number/MANIFEST, schema classification/provisioning registry, safe-export/OpenAPI additions, CI, central records and any Docker build allowlist. No concurrent worker/adapter author; no new package dependency. This recommendation does not itself authorize edits.

Minimum discriminating acceptance before independent review:

1. Pure validation/capture: input cloning, frozen values, duplicate versus conflicting capture, invalid then valid, valid then invalid, closure after fulfillment/rejection/throw, late callback inertness, arbitrary injected builtin lookalike remains synthetic, and fixed safe model/error normalization. Verify no private sentinel survives any allowed field.
2. Arithmetic: exact zero and null distinct; count max and max+1; non-safe integers; invalid decimals/denominators; cached/reasoning subset limits; equal-rate missing subsets can use totals; unequal-rate missing subset makes whole cost unknown; partial input/output; unrecognized and recognized-uncovered models; decimal precision boundary; independent BigInt reference calculation; mixed currencies and pinned old cards. No binary float money or rounding.
3. Actual unique disposable-schema migration/grants: worker function-only writes; learner/auth/payment/PUBLIC raw negatives; malicious direct SQL shapes/IDs/amounts fail; immutable update/truncate refused; owned cross-account export empty/refused; deletion scope/rollback/absence verified. No trigger disabling or raw-content approval hacks.
4. Real invocation accounting: two legitimate claims produce two intents and at most one assessment/debit. Two workers cannot invoke one claim twice. Same-claim begin replay is not dispatch permission. Reopen/history/export/explanation-language switch creates no new intent. Historical jobs without intents stay unrecorded.
5. Crash checkpoints: before intent commit; unknown intent commit response; after intent but before invocation; after response before observation; after observation before assessment; unknown successful COMMIT acknowledgement. Assert explicit unknown/replay behavior and no free/duplicate inferred call or debit. Receipt persistence failure never commits a successful assessment alone.
6. All terminal exits: receipt plus malformed feedback; receipt plus thrown error; missing receipt; pre/post review/rights withdrawal; unsupported rubric before call; soft-deleted attempt; exhausted/reclaimed claim; late stale completion; hard-deleted owner. Response/known counters survive reclamation; terminal disposition cannot regress; only fenced atomic completion accepts; P07 saved explanations remain atomic and never cause a second call.
7. Real both-order races and batch-size tests specified in section 8, with actual backend wait evidence. Replay before CAS returns the original event after later heads. Changed replay/stale CAS fail; deliberate owner-lock inversion or tuple-first reclaim mutation must be detected.
8. Snapshot/report: left-joined no-observation intent counts unknown; multiple revisions counted once; late receipt changes original intent cohort only; exact [from,to) boundaries; concurrent append/delete cannot mix report snapshots; over-limit fails without partial report; a >31-day-old queued/uncertain job remains in all-current queue scope; empty latency null; synthetic estimates never become actual spend. Unknown-currency/model buckets remain visible. DB outage exits nonzero with a fixed error.
9. Retain relevant worker runner/wire, C03 review/rights races, P07 worker/export/deletion/API and repository/keymask checks. Update only meaningfully changed test expectations under an explicit path amendment. New focused pure and guarded PG checks enter existing CI jobs; no browser change or browser acceptance claim is needed.

Every PG test must require `OWNAPI_PG_ALLOW=1` and `OWNAPI_PG_HOST=127.0.0.1`, with a fresh guarded `ownapi_*` schema and restricted roles and verified cleanup of only its own fixture. Normal local execution is exactly port62563/databasehatoove_spike. The sole CI alternative is port5432/databasehatoove_ci, and requires both `CI=true` and `GITHUB_ACTIONS=true`; all other hosts, ports, databases or missing flags are refused before connection. Test the actual extracted guard for both allowed cases and denied near-misses without making network attempts. No production database, existing learner volumes, live provider, real prices, provider credentials, external request or new service is required. Network-dispatch refusal probes use stubbed transports and must fail before real I/O. Report source review, synthetic execution, independent review, CI, merge and product acceptance separately.

## 13. Review-correction traceability and final freeze

| Prior required correction | Frozen resolution |
|---|---|
| Tuple-first/unbounded reclaim deadlock | Section 8: finite unlocked discovery, one owner/exam-first transaction per candidate, fresh claim reread, both-order real races |
| Receipt lifetime and monotone state | Sections 4 and 7: immediate normalized copy, sticky conflicts, worker settlement closure, terminal-preserving append, accepted atomic fence, deleted-parent drop |
| String grammar is not privacy | Sections 2, 3 and 11: code registry/model allowlist, fixed errors, no arbitrary known-field strings, sentinel tests |
| Numeric representation/partial cost | Section 5: bounded safe counters, BigInt decimal strings, power-of-ten units, subset algebra and whole-estimate unknown rules |
| Window/snapshot/unknown/old queue | Section 10: repeatable snapshot/asOf, intent [from,to), latest LEFT JOIN, explicit coverage/nulls, all-current queue and no actual spend |

The coordinator reserves0038 against integration base671b3e0. Exact permitted author paths, branches, checkpoint and expiry are recorded in separate bounded leases. Any deviation from the SQL/function/DTO shapes or safety/unknown semantics above requires a contract amendment before authoring. This frozen design does not claim that implementation or tests exist yet.
