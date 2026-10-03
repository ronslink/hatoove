# PILOT-07: saved explanation representations

Frozen coordinator contract, 3 October 2026, [issue124](https://github.com/ronslink/hatoove/issues/124). Based on the independent design proposal and C03 runtime414c72f, published as PR125 at05c96f0. Independent EXPLAIN-CONTRACT-20261003-R2/R3 cleared the final design; author execution requires a separate bounded lease. PILOT_BUILD_PLAN and MASTER-PLAN section4 govern. Migration0037 is reserved for this slice; O01 starts later. No live provider, real content approval, learner backfill, production migration or retention-policy change.

## Result integrity and scope

An explanation is immutable versioned prose beside a saved result. A read or language selection never grades, submits, retries, debits, enqueues a translation, invokes a provider or updates the assessment/mock snapshot. Preserve original feedback, bands, evidence, criterion order, model/prompt/rubric/task versions and submit-time explanation language. Support de/en/uk/ar/tr. German interface/exam/evidence stay German; Arabic direction applies only to explanation paragraphs.

The implementation stores the original supported prose for new successful writing assessments. Only trusted built-in simulation output with exact known provenance and complete template match gets four additional authored simulation variants. Unknown/custom feedback has its original and explicitly missing translations. Historical results use a virtual original projection, with no writes or implicit backfill. This provides the storage/read/client path; C06 native review, real provider evaluation and actual corpus translations remain open.

## Source and representation contract

`server/explanation-contract.mjs` owns extraction, validation, canonical hashes and public projection. Reuse canonicalJson from package-contract.mjs. Hash canonical UTF-8 without trimming, normalising Unicode or hashing rendered HTML. Every hashed source object has format_version=explanation-source-v1.

Objective source binds exam_id, set_id, set_version, item_id, original_format, original_language and exact original explanation value. Saved finalised mock items use the original in that immutable snapshot, not today's catalogue. Recognise the existing key[item_id] and legacy key._set_why[item_id] paths; accept nonempty strings only. Missing/unknown object values do not become String(object).

Writing source binds server-derived owner_id, submission_id, attempt_id, exam_id, task_id/task_version, rubric_id/rubric_version, model_version, prompt_version, feedback kind, the entire exact feedback JSON and recorded original language. Changing any binding, band, evidence or original prose changes source_sha256. owner_id never comes from the HTTP caller and is not exposed in explanation_view.

Exports:

```text
EXPLANATION_LANGUAGES = ['de','en','uk','ar','tr']
extractWritingExplanationSource({ownerId,attempt,submission,assessment})
extractObjectiveExplanationSource({examId,setId,setVersion,itemId,originalValue,originalLanguage})
validateExplanationRepresentation(source,representation)
projectExplanationView({source,requestedLanguage,representations,heads,review})
```

Source extraction returns exactly `{formatVersion:'explanation-source-v1',kind,identity,sourceObject,sourceSha256,originalLanguage,originalFormat,originalPayload,supported}`. kind is writing/objective. Writing identity has exactly owner_id,submission_id,attempt_id,exam_id,task_id,task_version,rubric_id,rubric_version,model_version,prompt_version; private owner_id remains internal. Objective identity has exactly exam_id,set_id,set_version,item_id. sourceObject is the canonical hashed object `{format_version:'explanation-source-v1',kind,...identity,original_language,original_format,original_value}`; original_value is the entire feedback (including feedback kind) for writing or exact saved explanation value for objectives, with absent value represented as null. sourceSha256 hashes sourceObject. originalLanguage is a supported enum or null; originalPayload is a valid block payload or null; supported is true only with a valid nonempty originalPayload. originalFormat is legacy-comment, telc-b1-bands, dtz-writing-bands, objective-string or unsupported. Original feedback/result is never replaced. The same descriptor is used at import, persistence and read; unsupported extraction cannot invalidate an otherwise valid assessment.

Objective keys have no original-language column. Use a versioned trusted legacy-language adapter for explicitly recognised bundled German sources with exact identity/version/original digest; otherwise originalLanguage=null. Never infer language from requested language or generic exam_language. Synthetic publisher fixtures may use an explicit trusted exact-source language registry. New writing with unknown recorded original language remains a virtual original and skips persisted originals/dictionary variants; it must not fail a valid grade or pretend to use a requested language.

Payload is exactly `{schema:'explanation-text-v1',blocks:[{slot,text}]}`. Allowed slots derive from the original: objective/comment, legacy/comment, criterion/<exact-key>/comment and correction/<zero-based-index>. Require unique slots, exact original order and complete original set, nonempty supported strings, no extra fields. Bound comments at4000 UTF-16 units and corrections at1000 with at most40, respecting any tighter original assessment contract. Translation payload cannot contain grades, totals, bands, evidence, criterion labels, task text or provider metadata. Any malformed/partial representation falls back wholly; never mix prose from different languages.

Representation fields are explicit language, bounded version (`[A-Za-z0-9][A-Za-z0-9._-]{0,63}`), source_sha256, payload, payload_sha256 and strict provenance. Hashes are64 lowercase hex. Provenance is an exact union: `{kind:'original-assessment',source_sha256}`; `{kind:'builtin-simulation-dictionary',source_sha256,dictionary_version,dictionary_sha256}`; or `{kind:'publisher-authored',source_sha256,producer_version}`. No arbitrary evidence/provider/path keys. Public provenance_kind is exactly the union's kind. Bound blocks at44 (four criteria plus40 corrections), retaining objective/legacy's single block and all tighter source limits. Empty/whitespace-only text is missing, but valid stored text is never trimmed or truncated; test UTF-16 astral/whitespace behavior. The trusted reader verifies actual source digest, payload hash, slot shape and explicit head membership. No implicit MAX(version) and no client hash/owner/model/review authority.

## Persistence and grants

Forward0037 creates four tables; older migration bytes and content hashes remain unchanged.

| Table | Identity | Access |
|---|---|---|
| objective_explanation_representation | PK(set_id,set_version,item_id,source_sha256,language,representation_version); exam_id/original language/format/payload/hash/provenance/time; exact set FK | Shared protected content. Migration/publisher insert; no runtime direct SELECT or writes. |
| objective_explanation_head | PK(set_id,set_version,item_id,source_sha256,language); exact composite representation FK | Privileged compare-and-swap promotion only; no runtime direct access. |
| writing_explanation_representation | PK(owner_id,submission_id,source_sha256,language,representation_version); exact source bindings/payload/hash/provenance/time; composite FK(submission_id,owner_id) to assessments after adding matching UNIQUE | FORCE RLS. Worker minimal INSERT/SELECT, learner owner SELECT, deletion owner SELECT/DELETE. No UPDATE or learner INSERT. |
| writing_explanation_head | PK(owner_id,submission_id,source_sha256,language); exact composite representation FK | Worker initial INSERT only, learner owner SELECT, deletion owner SELECT/DELETE. No runtime promotion. |

SQL language/hash/binding/FK constraints supplement trusted-helper validation. Reject UPDATE of representations; permit owner deletion through the deletion role, unlike immutable shared content. REVOKE ALL FROM PUBLIC including new functions. No assessment UPDATE, payment grant, objective-key grant or broad content grant. Treat private owner tables as owner data in classification/export/deletion and shared tables as protected reference content, including column-level/PUBLIC privilege controls.

`server/owned-postgres/explanations.mjs` exports `readExplanationRepresentations(client,{source})`, `persistWritingExplanations(client,{ownerId,submissionId,representations})` and `readExplanationReview(client,{scope,sourceIdentity,sourceSha256,language,representationVersion,payloadSha256,ownerId})`. These are server-internal, invoked only after parent authorization. Persistence re-resolves the just-saved actual assessment and exact source in the existing successful worker transaction, rejecting mismatches.

A separate privileged shared manifest importer accepts exact existing source identities/digests and immutable records. Same identity and same canonical bytes replays; changed bytes conflict. Head CAS requires exact expected previous version. It cannot modify package bytes, keys, releases or parents. No importer execution against real learner/content data. Fixtures may publish explicit synthetic originals/variants. No HTTP representation-by-ID or generic source-hash endpoint.

## Worker simulation provenance

Existing owner7352 -> exam7351 -> job/row lock and fresh lease/deletion/content checks remain. Insert supported original representations and heads atomically with assessment and its single existing credit debit. Prepare optional dictionary variants before the transaction; absent/invalid optional variants are missing, not a failed grade. A persistence failure rolls back the whole successful transaction; never partial success or another debit.

The default built-in grader path must be internally identified, not inferred solely from model/prompt strings or provider payload flags. Exact stub-grader-v2 and dtz-simulation-v1 model/prompt/feedback-kind/source-language/comment template matches with supported corrections permit a versioned authored dictionary. An injected function claiming the same names is custom. Require empty corrections unless every correction has an exact known dictionary entry. Never invoke stubGrade again to translate.

Store all five languages only on complete matching templates. Preserve the original-language original head; do not compete with a dictionary head for it. Provenance: builtin-simulation-dictionary, dictionary version/hash and exact source hash; target language and payload hash are the separate required representation fields. Original grading provenance remains separate. Every variant is unreviewed and labelled simulation. A substantive unknown comment cannot be replaced with a generic template.

Historical legacy/comment, telc-b1-bands and dtz-writing-bands use versioned read-only extraction. Virtual original version is legacy-projection-v1 with persisted=false. Preserve unsupported original feedback in existing result/export. Recorded language may originate from0018's default: do not claim verified language. Invalid/unknown language is null, and speech is disabled until reliable language is available.

## Authorized routes and snapshots

Append `explanation_view` to writing result and each finalised mock item, without changing original fields. Existing result/mock GETs accept optional `explanationLanguage=<enum>`; omission means original recorded language. Invalid explicit language is422. New standalone GET `/api/v1/objective-evidence/:evidenceId/explanation?language=<enum>` accepts only evidence ID and language, resolves authenticated owner and returns the same view. It is read-only.

Use two typed VOLATILE SECURITY DEFINER SQL readers, fixed `pg_catalog,"__SCHEMA__"` search_path, PUBLIC revoked, learner EXECUTE only:

```sql
read_objective_evidence_explanation(p_evidence_id uuid,p_language text) RETURNS jsonb
read_finalised_mock_item_explanation(p_run_id uuid,p_set_id text,p_set_version text,p_item_id text,p_language text) RETURNS jsonb
```

The evidence reader derives owner from existing transaction context, requires mock_run_id IS NULL, resolves exact owned active/archived preparation/exam/set/version/item and validates a non-null string answer against that exact trusted interaction/options, including matching-ads x and grouped questions. A wrong valid answer permits explanation; writable evidence.correct or row existence is not marking proof. Reject media-required standalone sets, unknown items, malformed/null/non-string/out-of-option answers and unrelated preparations. Do not call current new-admission/marking functions to authorize saved history.

The run reader anchors every locator in the exact owned finalised run, pinned membership and immutable saved item result. Unanswered finalised items are allowed even though no item_evidence row exists; never fabricate evidence or grant direct shared SELECT. Original prose comes from that saved result, not today's key. The existing mock GET composes these reads; no new public mock-item route. Both functions return only the authorized item, never answer maps/transcripts/other items. No caller allowlist, source digest, review flag, authorization GUC or generic key reader.

Internal SQL envelope is `{kind,context,originalValue,representations,heads}`. context has the exact snake_case source identity fields (objective exam_id/set_id/set_version/item_id plus evidence_id or run_id as authorization metadata, excluded from shared source digest). originalValue is the exact protected string/unsupported original. SQL may return all five languages of current head/representation pairs for this already-authorized exact exam/set/version/item. Join only through exact current composite-head FKs; no non-head history or other items. heads contain language/source_sha256/representation_version. Detect a101st matching pair before payload aggregation and fail closed; do not truncate. Order deterministically by language/source hash/version. JS resolves trusted original language, recomputes canonical source/payload hashes, discards wrong-source/invalid rows, and emits only the exact requested or allowed original representation. Do not filter SQL by stored original_language claims or treat jsonb::text as canonicalJson bytes. Internal envelopes are never HTTP DTOs. Freeze physical row-to-envelope property mapping in A's interface note before B/C begin.

SQL policy floor is exact parent identity, known permitted rights basis (unknown/withdrawn denied), explicit applicable historical release rights block and C03 completed-history review semantics. API additionally narrows via trusted deployment/catalogue/rights policy. Do not claim raw SQL enforces environment-only settings without a trusted database source. Existing owner context is used for ownership, never a new caller policy override. Test raw SQL foreign owner/pre-answer/invalid evidence/active mock, and unanswered finalised positive controls.

Writing uses existing historicalContent/writingContext; mock uses readReleasedForm/runDto. Explanation-bearing reads use READ COMMITTED, owner7352 then exact exam7351, then fresh parent/rights/representation statements after waits. Move the current mock repeatable-read path to this explicit sequence when composing explanations; do not lock within its old snapshot and claim fresh authorization. Publisher head promotion uses the same exam fence. Rights withdrawal committed before authorization hides prose. A read authorized before a later withdrawal cannot revoke already delivered bytes. An incomplete newer release alone must not erase eligible pinned history. C03 completed-history facts remain readable after review withdrawal with notice; follow independent rights withholding. New explanation rejection never regrades or erases saved facts.

## Read DTO and review seam

```text
{
 schema:'explanation-view-v1',
 source:null|{kind,source_sha256,submission_id?,exam_id,task_id?,task_version?,
   rubric_id?,rubric_version?,set_id?,set_version?,item_id?},
 requested_language, original_language, displayed_language,
 state:'original'|'translated'|'fallback'|'missing'|'not_assessed'|'blocked',
 requested_status:'available'|'missing'|'pending'|'failed'|'blocked',
 reason:null|'translation_unavailable'|'unsupported_original'|'original_missing'|
   'assessment_pending'|'assessment_failed'|'content_blocked'|'representation_rejected'|
   'representation_withdrawn'|'representation_unavailable',
 representation:null|{version,payload_sha256,persisted,payload,provenance_kind},
 review:{educational:SafeReview,native_language:SafeReview},
 languages:[{language,status:'available'|'missing'|'pending'|'failed'|'blocked'}],
 operation:null
}
```

SafeReview is exactly `{review_status,review_basis,blocked,explicit_negative}` with C03 statuses approved/unreviewed/rejected/withdrawn/unavailable and bases none/named_decision/legacy_unattributed. Internal review may include decision_ids; strip those and all reviewer/private evidence fields from public DTOs. Initial explanation dimensions are unreviewed/none/false/false, never legacy-approved. Public provenance_kind additionally permits virtual-original only when persisted=false and version=legacy-projection-v1; it is forbidden in stored provenance. Languages are always the five supported enums. requested/original/displayed language may be null only for unknown original/omitted selection. Preserve actual displayed language on fallback; requested_status distinguishes blocked/rejected/withdrawn from missing. No successful assessment means not_assessed with source=null and no prose; parent blocked means source=null and no protected payload/provenance. Missing original means missing. pending/failed target states are supported only as discriminating synthetic projections/future contract; production has no translation operation and therefore reports missing, never endless pending. Parent review_withdrawn notice remains separate from child representation status.

`readExplanationReview` is fail-closed unreviewed in this slice. C03 initially registers content/blueprint/form subjects only; explanation source approval does not transfer to translation or personal feedback. Do not add parallel authority tables, expose private reviewer evidence, or enable language decisions until a separate exact-representation target/access contract exists. The seam keys full source/version/language/payload hash; synthetic rejection falls back only to an allowed original. Native/educational review dimensions remain distinct. No client/provider flag can approve prose. Personal reviewer access remains separately gated.

## Export, deletion and client behavior

Export all owned representation/head rows with original bindings/provenance using additive fields. Apply the same historical rights withholding as parent result; retain identity/reason without protected text when blocked. Shared export contains only selected authorized representations in owned answer/run contexts, never the shared catalogue. Do not export tokens, lease credentials or secrets. Delete personal heads before representations before assessments; include both tables in verified-absence checks. Existing owner fence and exact lease/FKs prevent late workers resurrecting deleted accounts. No translation queue exists.

`public/app/explanations.js` renders only prose and status and mounts speech. writing.js, archived writing, finalised mock and standalone answerItem share it; grade/evidence rendering remains original. After a successful objective answer use that exact returned evidence_id to read prose; fence subsequent answers per card as well as account/preparation/view/language. Language changes only reread, never resubmit. api.js passes current preference explicitly. Exact selected stored `textContent` reaches speech unchanged; trim only to check emptiness. Keep local-voice/visibility/disposal checks. No silent text shortening. In the same later client lease, correct the observed finalised mock timing-card action label so read-only history does not say Jetzt bearbeiten; preserve saved timing facts and controls.

Every await is fenced by language/account/preparation/view generation and source identity, including settings save and reread. Stop speech and detach handlers on switch/dispose/sign-out. Slow old responses cannot replace newer selection. Network failure retains last confirmed text labelled with actual language and offers retry-read; never relabel it as a new language. No mutation/finalisation/remount of active mocks to switch post-result language. Arabic dir=rtl is local to prose blocks; task/evidence/chrome remain LTR.

## Bounded partitions and acceptance

Coordinator owns contract, registry/provision/classification, CI/OpenAPI, paired status and final isolated browser evidence. After reviewed interfaces freeze, assign at most three non-overlapping authors: (A) core contract/schema/storage/importer and focused tests; (B) worker dictionary/worker changes and focused tests; (C) API/adapter/mock/export/delete integration and focused tests. Client author follows an available slot and stabilized read interface. Each gets separate worktree/branch, exact paths/base/checkpoint/expiry and ACK. Independent reviewers must not author their reviewed slice. No extra children.

Required proofs: restricted-role pre-answer/cross-owner/forged evidence and source/head failures; full source-digest isolation including changed evidence/rubric/owner; immutable assessment/job/ledger/provider-count snapshots across repeated five-language reads; exact known built-in recognition versus injected-name spoof and unknown feedback; legacy/unsupported/missing/partial/forged-review fallback; worker atomic rollback and deletion/late completion; parent rights and pinned-history preservation; shared export limitations; private table grants and deletion.

Browser evidence must cover available-unreviewed, missing/fallback, synthetic pending/failed/rejected, Arabic scope, exact-text speech, rapid language A->B->A, sign-out/account/view change, refresh, archived/mock history and read-network failure with retained result/text. Use source-only isolated Compose, synthetic records, exact cleanup and desktop/mobile light/dark evidence. Physical device audio/keyboard and C06 native quality remain separate acceptance gates. Tests that use synthetic transport projections identify them; core authorization/data invariants require actual PostgreSQL/API paths.
