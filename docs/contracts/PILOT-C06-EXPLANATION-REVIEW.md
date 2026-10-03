# PILOT-C06: exact explanation review

Draft for coordinator and independent review, 3 October 2026. Author execution `PILOT-C06-CONTRACT-20261003-C`, base `9df40c7030df2961d7c891ffa7062bab089bb8d2`. This document proposes a contract; it does not freeze implementation, appoint a reviewer, approve material, grant access to learner writing or authorize a migration or provider call. Separate bounded implementation leases follow coordinator acceptance.

## Scope and unchanged rules

Extend [C03](PILOT-C03-REVIEW.md)'s existing authority and decision ledgers to review exact reusable [P07](PILOT-07-EXPLANATIONS.md) explanation representations. Do not create a parallel approval flag or second decision ledger. The first supported target is a shared objective explanation, including an explicitly registered original extraction artifact. Source identity, source digest, language, representation version and payload digest all belong to the target.

The selected de/en/uk/ar/tr interface policy in [PILOT-I18N-INTERFACE](PILOT-I18N-INTERFACE.md) supersedes P07's old German-only chrome wording. It does not translate assessed content, establish native review, infer source language from locale, change purchasing market or change submit-time language snapshots. Preserve the original language and scoped direction of displayed prose, including fallback. UI dictionary translations and authored reference/guide translations are not P07 objective representations; their review targets are not silently added here.

A review changes only the safe explanation selection/status. Reads and language selection never grade, enqueue, call a provider, debit, rewrite an assessment, change a mock result or promote a representation head. Existing parent ownership, entitlement/history, rights and C03 historical-review policy remain prerequisites. A child translation approval cannot approve its parent task, key, rubric, recording, form, blueprint or another translation. A child negative must not close an otherwise valid exam or change an existing credit receipt.

## Shared material versus personal feedback

| Material | This proposed slice |
|---|---|
| Existing shared `objective_explanation_representation`, exact source and version | Register and review after privileged source verification. Registration is not head promotion or approval. |
| Supported shared original explanation selected virtually as `legacy-projection-v1` | Permit an explicit immutable extraction target, bound to the same exact source and payload the reader computes. No write or backfill on read. |
| Personal `writing_explanation_representation`, historical assessment feedback, submissions and learner text | No review registration, packet, enumeration or reviewer access. Existing owner-authorized reads/export/delete continue; review remains unreviewed. |
| A built-in simulation dictionary or reusable writing template | Its quality cannot approve individual owner-bound feedback, even if the rendered bytes happen to match. No template-to-personal approval transfer. |
| Guide prose, rubric instructional translations, operational instruction registry and UI dictionaries | `not_modelled` for C06 coverage until separately typed source/version/digest mappings are agreed. They are not aliases for an objective set. |

Reject a personal locator before any personal-table query in operator registration, packet, coverage or decision commands. Do not accept an owner ID, submission ID, arbitrary SQL/table name or a `scope:writing` target at those entry points. A migration-role connection is already privileged infrastructure; this workflow supplies no new product authority to inspect personal rows and makes no claim that its credentials are technically incapable of broader database access.

A future personal-review contract must explicitly settle purpose, lawful basis/consent, who can inspect which owner's text, minimization/redaction, appointment versus authentication, audit/retention, withdrawal, deletion/late reviews and owner-fenced transaction order. That is a blocking dependency for personal review, not a default permission created by this document.

## Exact target and digest contract

New pure module `server/explanation-review-contract.mjs` exports `validateExplanationReviewLocator(value)` and `validateExplanationReviewSubject(value)`. Each returns a detached normalized object or throws a fixed review error; neither reads files/database nor accepts accessors/extra authority fields. The locator has exactly the following fields; reject missing, extra, null, incorrectly typed and unsupported values:

```js
{
  scope: 'objective',
  targetKind: 'stored' | 'original',
  sourceIdentity: {exam_id, set_id, set_version, item_id},
  sourceSha256,
  language,                 // exactly de/en/uk/ar/tr
  representationVersion,   // existing P07 bounded version syntax
  payloadSha256
}
```

Identity fields retain their existing source constraints, not a new interpretation of concatenated IDs. Digests are 64 lowercase hex characters. `targetKind:original` requires `representationVersion:legacy-projection-v1`, a supported nonempty original, reliable original language equal to `language`, and the exact P07 original payload. Unknown language or unsupported original cannot be declared German or reviewed by selecting a language. `stored` must resolve the exact immutable representation row and validate it with P07; a non-current stored version can be reviewed, but review never makes it current. Target kind is part of identity, so a caller cannot relabel a stored row as a virtual artifact.

Privileged registration re-resolves the actual same-exam set, trusted interaction/item identity, key's original explanation, exact content version, authoritative language registry and representation row. It calls the existing source extractor and representation validator, recomputing `sourceSha256` and `payloadSha256` using P07 `canonicalJson`/UTF-8. Do not trim, normalize Unicode, serialize HTML, infer language from exam/UI locale, or use a caller's original prose. Preserve the existing narrowly pinned LF/CRLF handling in the legacy language registry; no new normalization of explanation hashes.

Use proposed forward migration `0040-explanation-review.sql` only if still unallocated when the coordinator freezes implementation; otherwise reserve the next number explicitly. Never edit 0035, 0037 or earlier migration bytes. It adds one immutable private editorial table, `explanation_review_target`, containing:

- `target_id uuid` primary key; `target_kind` stored/original; exact `exam_id,set_id,set_version,item_id,content_version_id` and exact set/content FKs;
- `source_sha256,language,representation_version,payload_sha256`, P07 extraction version, reliable original language/format and the database-derived original-value fingerprint;
- a nullable typed composite representation reference, required only for `stored`, with exact same exam/source/language/version/payload hash; add the necessary referenced UNIQUE constraint without changing old rows;
- `packet_sha256`, `target_sha256`, database registration time and operator role. No learner identity, new prose copy, review flag, current-head pointer or approval date.

Unique identity includes target kind and the entire source/representation tuple. An identical registration returns the same target; conflicting bindings refuse. UPDATE/DELETE/TRUNCATE refuse, including raw DML; no baseline or automatic population. Original targets reference the immutable same-exam source; registration and projection compare the stored original-value fingerprint to the actual source. The fingerprint is an internal database binding, not a substitute for the P07 digest.

`target_sha256` is a separate, versioned review identity digest, calculated by SQL over an explicitly constructed typed `jsonb` identity object serialized with PostgreSQL `jsonb::text` and SHA256/UTF-8. Its object includes `format:explanation-review-target-v1`, target kind, exact locator, parent content identity, extraction version, original-value fingerprint and immutable packet digest; it excludes random target ID, time and operator. Return it to the operator rather than recomputing it as a P07 hash. Document and test this distinction: PostgreSQL serialization is not `canonicalJson`. Trusted JS validates P07 canonical hashes; SQL independently derives source/backing references, exact stored-row/FK matches and the review identity digest. A raw restricted-role caller has neither registration execution nor target writes. An incorrectly hashed operator target cannot match a recomputed runtime source; do not invent a generic SQL canonicalizer as incidental scope.

## Reuse of C03 authority and decisions

Extend `content_review_decision` with `subject_kind:explanation` and a typed FK to `explanation_review_target`. For that kind, `subject_id` is the target UUID's canonical string, `subject_version` is its exact representation version, `subject_sha256` equals `target_sha256`, and the old content/blueprint/form FK columns are null. For all existing kinds, retain existing constraints and version validation unchanged. The sealed C03 baseline is untouched; explanations never receive `legacy_unattributed` approval.

The target requires two independent dimensions:

| Dimension | Existing authority/decision category | Exact authority language |
|---|---|---|
| Educational correctness and relation to the original task/answer | `educational` | empty string |
| Native-language clarity and faithful meaning of this representation | `language` | target's exact language |

Neither dimension implies the other. Required dimensions come from trusted target kind, never an input list. Reuse `recordReviewerAuthority`, its evidence and explicit grant/revoke chain. A provider, publisher flag, interface preference, content author assertion or existing source approval cannot create authority. Operator-recorded attribution is not authenticated reviewer login or a digital signature. Real appointment/qualification evidence remains mandatory. The engineering quorum stays one valid decision per dimension; whether two distinct humans are required is an explicit human policy input, not an implied two-reviewer claim.

Keep C03 event UUID, exact-payload replay, expected authority head, expected decision head, monotone revision and one-successor constraints. Stale inputs conflict; never auto-rebase. Exact committed replay precedes later head/revocation checks and returns its prior receipt. Revoking an authority prevents future decisions under that grant, but does not retroactively erase earlier valid decisions; removing an earlier approval requires an explicit target reject/withdraw. A later explicit approve is possible only through the expected-head/current-authority checks. No timestamps choose heads and no second review ledger is added.

For explanation decisions, `approve` additionally requires the non-null `packetSha256` to equal the registered immutable `packet_sha256`; the SQL append/trigger must enforce that comparison, not merely a hash-shaped value. Registration constructs and hashes the canonical packet from verified actual source/representation data before deriving target identity; no caller-supplied packet body is trusted. `reject/withdraw` may record a negative without redisclosing blocked material or obtaining a new packet; they still require the exact registered target, authority and expected head. Replay of an earlier successful event does not require still-current rights or a newly generated packet. A negative always defeats an older positive in that same dimension/target stream. A new representation version never inherits the previous version's approval.

Do not change the old `resolve_review_subject` interface into a multi-row category resolver. Add a private `resolve_explanation_review_target` helper and a specific explanation branch in the existing append/trigger validation; preserve old content/format behavior. Unregistered explanation IDs and language decisions on whole content/blueprint/form subjects remain refused.

## Proposed module, SQL and CLI interfaces

Keep the current C03 writer module and receipts. Add exports in `server/owned-postgres/explanation-review.mjs`:

```text
registerExplanationReviewTarget(client, locator, {languageRegistry} = {})
  -> {targetId, subject:{kind:'explanation',examId,subjectId,version,sha256}, unchanged}
readExplanationReviewPacket(client, exactExplanationSubject)
  -> {packet, packetSha256}
readExplanationCoverage(client, {examId,releaseVersion,languages})
  -> {scope:'shared_objective', examId, releaseVersion, languages, exclusions}
```

Callers own one migration-role transaction; registration/decisions require READ COMMITTED. `{languageRegistry}` is a trusted server-only fixture/source declaration, never a JSON input, HTTP field or GUC. Existing `recordContentReview(client,input)` accepts the new typed subject and delegates exact target validation; its receipt shape is unchanged. Existing authority inputs are unchanged. A new target registration and a newly applied approval require known permitted effective parent rights; a review does not grant those rights. An exact registration/decision replay remains a receipt after later withdrawal. A negative on an already registered target must remain possible when rights prevent another packet read.

Freeze one internal SQL getter:

```sql
effective_explanation_review(
  p_exam_id text, p_set_id text, p_set_version text, p_item_id text,
  p_source_sha256 text, p_language text, p_representation_version text,
  p_payload_sha256 text, p_target_kind text
) RETURNS TABLE(
  dimension text, review_status text, review_basis text,
  blocked boolean, explicit_negative boolean, decision_ids uuid[]
)
```

It returns exactly two rows ordered educational, native_language. It is read-only VOLATILE SECURITY DEFINER with fixed `pg_catalog,"__SCHEMA__"` search_path, PUBLIC revoked, and safe EXECUTE only for learner/worker roles. No payload, target ID, reviewer, packet or evidence is returned. This metadata getter does not authorize content disclosure. Runtime table/column grants remain denied; payment/auth/deletion receive no new EXECUTE. Private resolver/registration/append helpers are not runtime-callable.

A valid supported locator with no registered target returns unreviewed/none/false/false/empty IDs in both dimensions, preserving P07 compatibility. Invalid/null/malformed/inconsistent locators or corrupt backing return unavailable/none/true/false/empty IDs. A registered undecided dimension returns unreviewed/none/false/false/empty IDs. Named decisions map approve/reject/withdraw to approved/rejected/withdrawn with named_decision; only explicit reject/withdraw sets explicit_negative. Missing approval is not a rights denial. No fabricated legacy approval.

Replace the runtime no-op `readExplanationReview` in `explanations.mjs` using this getter. Preserve its two-dimension return and add one server-internal `targetKind` field to its existing argument object for objective candidates: `readExplanationReview(client,{scope,sourceIdentity,sourceSha256,language,representationVersion,payloadSha256,ownerId,targetKind})`. The trusted candidate constructor supplies stored/original; do not infer kind from a version string or accept it through HTTP. Writing callers retain their existing arguments. `scope:writing` retains the owner-bound parent precondition and returns unreviewed without any review lookup. Remove the conflicting no-op logic in `content-review.mjs` by re-exporting/delegating to the single implementation; do not retain two divergent semantics.

Extend the existing `tools/review-content.mjs`, not a second CLI:

- `explanation-target --input FILE [--dry-run|--apply]` registers one validated shared locator, default rollback/dry-run;
- `explanation-packet --subject-file FILE --output PRIVATE_PATH` exports an already registered exact target for authorized operator handling;
- `explanation-coverage --exam EXAM [--release VERSION] [--languages de,en,uk,ar,tr]` is read-only;
- existing `authority` and `decision` operations retain their command shapes.

Retain explicit database/schema/role selection, no startup/fetch, restricted error codes and no raw payload/error logging. Packet reads recheck current known permitted effective rights in their coherent snapshot before disclosing protected material; target identity alone grants no right to obtain a packet. Dry-run is not a reservation or usable registration receipt after rollback. The immutable packet is `{schema:'explanation-review-packet-v1', locator, contentIdentity, extractionVersion, taskContext, itemAnswer, originalExplanation, representation, requiredDimensions}`. Here `locator` is the exact validated locator, `contentIdentity` is the exact parent content ID/digest, `taskContext` is the actual shared public set payload with its trusted interaction, `itemAnswer` is only this item's key, `representation` is this exact validated payload and provenance (virtual-original for an original extraction), and requiredDimensions is educational plus native_language. Hash with P07 canonical UTF-8 and store only the hash in the target. Exclude target UUID and target_sha256 from the packet to avoid a digest cycle; all source/representation bindings are already in the locator. Reconstruct the same packet on export and refuse a stored-hash mismatch. Exclude learner rows, other items' keys, authority evidence, credentials and mutable timestamps/statuses from the hashed packet. Do not hash a whole current coverage report. Preserve static-root/symlink/junction and exclusive private-output protections; sending packets to anyone is not authorized by this CLI.

Coverage counts exact release/form objective item references, deduplicated by source identity, with each requested language's approved/unreviewed/rejected/withdrawn/missing/unknown-source-language/not_modelled counts. A missing original, unsupported extraction or missing translation stays in its required denominator; never report completeness by dropping those items. `approved` requires named approval of both exact dimensions. Report shared objective coverage separately from personal feedback, guide/instruction/UI translation coverage and parent content/format eligibility. Add this report to existing C03 coverage without changing its `reviewComplete` meaning or silently requiring all five translations for S6 admission.

## Selection, history, rights and concurrency

`explanation-views.mjs` must obtain review for every valid current-head candidate and for the exact virtual original when it can be selected. Its present loop over stored rows alone is insufficient for an original extraction target. Match all identity/digest/version/language/kind fields before projecting. Preserve the existing `explanation-view-v1` DTO and SafeReview shape; strip decision IDs and all private metadata before HTTP/export display fields.

- Unreviewed remains visibly unreviewed; this slice adds no global approved-only admission switch.
- A rejected/withdrawn/unavailable requested representation falls back only to a separately allowed original, with truthful requested status and displayed language. A blocked current stored original must not be bypassed by manufacturing an unreviewed virtual copy. When the real selected original is virtual, apply its registered extraction review.
- If both are blocked, remove previously visible explanation prose and speech immediately on the next confirmed read; preserve authorized bands/evidence/answers and the parent's historical notice. Source may remain non-null for representation-level blocking; parent rights/content blocking still returns source=null with no protected prose.
- Representation review is not a retroactive rewrite or erasure of immutable historical source feedback. Existing raw assessment fields remain governed by C03 historical disclosure; do not claim child withdrawal makes all historical bytes inaccessible. Rights withholding remains stronger across parent/read/export paths.
- Source review and translation review are distinct. An old finalised snapshot whose exact source no longer matches a registrable immutable shared source remains unregistered; never retarget it to current prose or infer review from matching IDs alone. No new whole-current-release check on pinned history, and no source/version substitution after withdrawal. Already delivered bytes cannot be revoked from a past read.

Administrative registration, review, authority changes and shared head promotion acquire exact exam7351 before target/stream/head/tuple reads. They never acquire a learner owner/job tuple. Existing learner reads use owner7352 -> exam7351 -> fresh READ COMMITTED statements after any wait. The safe SQL projection itself takes no locks and cannot be declared STABLE. Retain the actual REPEATABLE READ READ ONLY no-lock export snapshot exception; test review visibility in that snapshot without claiming post-snapshot revocation. Existing account deletion keeps its owner fence and does not delete shared review records.

No new raw learner DML is introduced. Existing mark/play/finalise/worker guards stay as C03/P07/O01 defined; explanation review does not create a new grading gate or alter lease/debit behavior. An exact replay remains a receipt, not permission for new access. Read, withdraw, head promotion and rights races must be tested in both acquisition orders with observed separate backend waits.

## Export, privacy and remaining inputs

Learner export remains an owner-authorized coherent snapshot using existing credentials. Export only selected authorized shared representations reachable through that owner's saved evidence/finalised run; no catalogue dump, registered targets, reviewer identities/evidence or review-ledger rows. Include safe review fields where a representation is exported; blocked/missing selections retain truthful status without protected prose. Existing personal representation/head export and deletion remain unchanged because this slice creates no personal review rows. A deleted account cannot gain access through a review target; review writers never recreate learners, submissions or heads.

The new table is private editorial metadata, classified alongside C03 private ledgers, not an ordinary content table or owned learner table. Prove no PUBLIC, auth, learner, worker, deletion or payment table/column SELECT/DML grants. Safe status EXECUTE is the only runtime addition. Operator packets/evidence retention and authorized human recipients need policy before real use. No real appointments, decisions or coverage claims are seeded by migration.

Remaining inputs before real approval are named qualified educational/native reviewers, appointment evidence, any distinct-reviewer/quorum rule, lawful rights to all reviewed material, exact trusted original-language declarations for new source material not covered by the existing registry, evidence/packet retention and human evaluation criteria. Overall C06 also needs actual reusable translated material and a later accepted personal-review/access contract if personalized native approval is required. Human interface translation acceptance remains separate. This slice does not satisfy D10, create a provider, authorize live generation, approve content or publish a release.

## Proposed implementation paths and acceptance

These paths are a proposed partition, not an execution lease. Coordinator must assign one owner per path and recheck migration0040 availability:

| Partition | Paths |
|---|---|
| Core target/ledger extension | new `server/migrations/0040-explanation-review.sql`, new `server/explanation-review-contract.mjs`, new `server/owned-postgres/explanation-review.mjs`; `server/content-review-contract.mjs`, `server/owned-postgres/content-review.mjs`, `tools/review-content.mjs` |
| Runtime projection | `server/owned-postgres/explanations.mjs`, `server/owned-postgres/explanation-views.mjs`; `server/explanation-contract.mjs` only if selection needs a narrowly reviewed correction |
| Focused acceptance | new `tools/explanation-review-check.mjs`, new `tools/explanation-review-pg-check.mjs`; existing `tools/explanation-browser.mjs`, `tools/explanation-browser-check.mjs`, `tools/explanation-table-class-check.mjs` |
| Coordinator integration | `server/migrations/MANIFEST.json`, `tools/lib/catalogue.mjs`, `tools/table-class-check.mjs`, `tools/table-class-check.test.mjs`, `.github/workflows/ci.yml`; explicit retained fixture migration arrays, `docs/openapi.yaml` only if safe DTO semantics need clarification, paired status records |

No new public route, review dashboard, reviewer account, personal-reader grant, translation queue or client remount is required. Existing client review states should render the new actual statuses; a reproduced UI deficiency requires an explicit client-path lease. Docker already includes the existing review CLI; do not add another executable or dependency without a concrete need.

Required future evidence uses synthetic appointments/material and unique guarded disposable schemas only:

1. Pure exact-field validation and every identity/digest/language/kind/version mismatch; hostile keys, Unicode/canonical byte boundaries, unknown source language, current/non-current head distinction and no approval transfer from task/template/provider/locale.
2. Real restricted-role registration/ledger/column-read refusals, immutable target FKs and DML/TRUNCATE controls, unchanged C03 baseline/old decisions, migration replay and old checksum preservation. SQL and JS projections must agree on actual source/representation bindings; malformed operator targets never match canonical runtime candidates.
3. Exact decision replay before later revoke; changed event conflicts; stale and competing decision heads; revoked-authority new decision refusal while earlier valid decision remains; explicit negative precedence; educational-only/native-only/both approvals and changed version requiring fresh review. Packet digest mismatch refuses approval; negatives remain possible without redisclosure after rights withdrawal.
4. Actual standalone evidence and finalised mock reads: pre-answer/cross-owner/active-mock refusal, stored translated positive, virtual-original positive, blocked target with approved/unreviewed allowed original fallback, blocked original with no bypass, both blocked, corrupt backing, unknown-language legacy, preserved grades/answers/snapshots. No personal target or operator packet can be created.
5. Separate-connection, observed-blocker races in both orders for review/read, review/head promotion, authority-revoke/decision and rights/read; coherent read-only export snapshots; unchanged owner->exam order and no learner tuples in editorial transactions.
6. Stable full-row fingerprints of assessments, submissions, answers, jobs, balances, usage/provider ledgers and representation heads across repeated language/review reads; zero provider calls. Export cannot include private review metadata or unrelated shared/personal material; normal account deletion remains complete.
7. Real ledger-driven browser states, not transport-only status fixtures: translated positive, requested withdrawal fallback and both blocked remove prior prose/speech while grades remain; account/view/locale stale response fencing. Desktop/mobile Arabic and source-language annotations remain correct. Native quality/device acceptance is not inferred.

No such tests or migrations are executed by this drafting task. Independent source/security/concurrency review, discriminating old-code negatives, actual local evidence and the existing staged-source guard are required before an implementation is delivered. Coordinator freeze, hosted CI, merge, human review and product acceptance remain distinct.