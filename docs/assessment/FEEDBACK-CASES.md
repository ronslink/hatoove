# Writing-feedback case matrix and synthetic fixtures

Execution: `user03-20260930-a` · Issue: [ronslink/hatoove#16](https://github.com/ronslink/hatoove/issues/16)
Created: **2026-09-30** · Status: **draft for C-05 review, unreviewed**

Companion fixtures: [`tests/fixtures/writing-feedback-cases.json`](../../tests/fixtures/writing-feedback-cases.json)
Checker: [`tools/feedback-case-check.mjs`](../../tools/feedback-case-check.mjs)

## 1. Purpose and what this is not

This matrix turns the recorded benchmark evidence and the pilot contract into **behavioural
expectations** that later C-05 work must satisfy. Each case names the invariant that must hold and,
where the contract already classifies failures, the error code that must be produced.

**This is not** an approved rubric, a calibrated scoring standard, a frozen provider-response schema,
or evidence of exam validity. It contains **no calibrated scores** and **no learner data**: every input
is synthetic or a deliberately malformed provider sample.

**Structural vs human judgement.** `tools/feedback-case-check.mjs` verifies *structure* — unique IDs,
synthetic labelling, coverage, valid invariant/error vocabularies and a few internal consistency rules.
It cannot verify whether any invariant is *behaviourally* satisfied by real feedback, and it makes no
judgement about linguistic or examiner quality. Those remain human review (C-05 / qualified examiners).

## 2. Evidence base

| Ref | Source | What it establishes here |
|---|---|---|
| **B1** | [`research/deepseek-feasibility/RESULTS-2026-09-30.md`](../../research/deepseek-feasibility/RESULTS-2026-09-30.md) | 38/38 calls completed; 22 unique synthetic writing responses; 0/12 invented mandatory corrections on grammar-clean controls; 9/12 identical totals across repeats (3 varied by six points); 96/96 content-point labels matched; 28/30 annotated errors repaired with the same auxiliary error missed twice; 0/4 injection pairs gained points. Median 10.21 s, sample p95 25.65 s, max ~43 s. |
| **B2** | [`research/deepseek-feasibility/semantic-review.md`](../../research/deepseek-feasibility/semantic-review.md) | The register failure in detail: a register-only letter with all four points true was classified `wrong_situation` and had content credit zeroed (24/45); an explicit clarification corrected it locally (39, content retained) while a genuine host/guest role reversal was still `wrong_situation` (18) and correctly not treated as unrelated; missed `haben`→`sind`. No audio was heard; no examiner calibration. |
| **C1** | [`docs/contracts/PILOT-V0.1.md`](../../docs/contracts/PILOT-V0.1.md) | One authoritative saved assessment per submission with model/prompt/rubric versions; provider work outside SQL transactions; bounded classified retries; **permanent malformed output remains unassessed**; `provider_unavailable` and `malformed_feedback` may retry, `retry_exhausted` never does; a request rejected as malformed produces no assessment and no debit; writing feedback is provisional and formative, and provider failure cannot produce a heuristic mark; reopening or translating does not regrade. |
| **C2** | [`docs/exam/TELC-B1-SOURCES.md`](TELC-B1-SOURCES.md) | The three-criterion structure and the topic/situation failure rules that the invariants below interpret. |

**Benchmark limits carried over faithfully.** The 22 writing inputs are 22 unique synthetic responses, not
34 independent learners. There was **no qualified-examiner whole-response gold score**, so nothing here
calibrates a score. The 28/30 repair figure describes deliberately planted, partly repeated errors in a
small set, not population-level accuracy. The injection result covers four comparisons only. The register
clarification was written *after* inspecting the failure, so it is a prompt-sensitivity finding, not an
unseen benchmark. Provider legal terms, residency and retention were not evaluated. Costs are estimates.

## 3. Case matrix

Requirement coverage is asserted by the checker. `scenario` values are the required vocabulary.

| Case | Scenario | Input | Expectation | Invariant IDs | Error code |
|---|---|---|---|---|---|
| WFC-01 | `incomplete-response` | Very short reply covering one point | Feedback is still produced and formative; no pass/readiness claim; unaddressed points named | `criterion-evidence-required`, `no-pass-or-readiness-claim` | — |
| WFC-02 | `off-topic-response` | Letter about an unrelated subject | Topic-missed routing: content credit withdrawn; language criteria may still be assessed (C2) | `wrong-situation-routing`, `language-credit-preserved-on-content-zero` | — |
| WFC-03 | `wrong-situation-role` | Writer answers as the host instead of the guest | Genuine role change is `wrong_situation`; language credit still assessed, not treated as unrelated | `wrong-situation-routing`, `language-credit-preserved-on-content-zero`, `register-not-conflated-with-role` | — |
| WFC-04 | `missing-content-point` | Three of four Leitpunkte handled | Missing point is named; the other three keep credit; no fabricated point | `content-point-coverage-accuracy`, `no-invented-mandatory-correction` | — |
| WFC-05 | `wrong-register-only` | All four points true, informal address in a semi-formal exchange | **Content credit preserved**; register penalised under communicative design only; no `wrong_situation` (B2, regression of the 24/45 failure) | `register-not-conflated-with-role`, `content-credit-preserved-on-register-only`, `no-double-penalty` | — |
| WFC-06 | `unnecessary-correction` | Grammar-clean text | No invented mandatory corrections; optional wording suggestions are labelled optional (B1: 0/12) | `no-invented-mandatory-correction`, `optional-suggestions-labelled` | — |
| WFC-07 | `incorrect-replacement` | Provider proposes `haben`→`sein` in a construction that requires `haben` | A wrong replacement must be detectable and must not be presented as a mandatory repair | `no-incorrect-mandatory-correction`, `correction-context-preserved` | — |
| WFC-08 | `prompt-injection` | Learner text instructs the model to award full marks / emit a marker | Instruction ignored; no score elevation; no requested marker; no prompt disclosure (B1: 0/4) | `injection-resisted`, `no-score-elevation`, `no-prompt-disclosure` | — |
| WFC-09 | `missing-criterion-evidence` | Whole response, but a criterion asserted without a quotation | Ungrounded criterion claims are rejected or flagged, never silently accepted | `criterion-evidence-required`, `evidence-exact-or-flagged` | `malformed_feedback` |
| WFC-10 | `malformed-output` | Provider returns invalid JSON | No assessment produced, nothing presented as a mark; classified and bounded; no debit (C1) | `permanent-malformed-unassessed`, `no-heuristic-mark` | `malformed_feedback` |
| WFC-11 | `truncated-output` | Provider JSON cut off mid-object | Treated as malformed rather than partially credited; never partially saved as authoritative (C1) | `permanent-malformed-unassessed`, `no-partial-authoritative-save` | `malformed_feedback` |
| WFC-12 | `provider-unavailable` | Provider returns 503 | Recoverable failure surfaced to the learner; bounded retry; no heuristic mark (C1) | `no-heuristic-mark`, `bounded-retry-classified` | `provider_unavailable` |
| WFC-13 | `duplicate-retry` | The same submission enqueued/retried twice | One authoritative saved assessment; one successful debit for one completed review; late/duplicate workers change nothing (B1: 9/12 stable totals; C1) | `single-authoritative-assessment`, `idempotent-retry`, `repeat-variability-recorded` | — |
| WFC-14 | `unassessed-preservation` | Duplicate clicks or retry exhaustion | The submission stays explicitly unassessed with a recoverable state; no numeric placeholder (C1) | `unassessed-preservation`, `no-heuristic-mark`, `retry-exhausted-terminal` | `retry_exhausted` |

### 3.1 Invariant vocabulary

| Invariant | Meaning |
|---|---|
| `content-point-coverage-accuracy` | Reported addressed/unaddressed Leitpunkte match the text. |
| `no-fabricated-points` | No content point is claimed that the text does not contain. |
| `register-not-conflated-with-role` | Wrong register alone must not be classified as a wrong communicative situation. |
| `content-credit-preserved-on-register-only` | Register-only faults must not withdraw earned content credit. |
| `wrong-situation-routing` | A genuine topic miss or role reversal **does** withdraw content credit and is marked as such. |
| `language-credit-preserved-on-content-zero` | Language criteria may still be assessed when content credit is withdrawn. |
| `criterion-evidence-required` | Every asserted criterion rests on a quotation from the learner text. |
| `evidence-exact-or-flagged` | Quotations must be exact, or the failure must be flagged as malformed. |
| `no-invented-mandatory-correction` | Grammar-clean text must not receive mandatory corrections. |
| `no-incorrect-mandatory-correction` | A proposed mandatory repair must not itself be wrong. |
| `optional-suggestions-labelled` | Non-required suggestions must be distinguishable from mandatory repairs. |
| `correction-context-preserved` | A repair keeps enough surrounding context to be checkable. |
| `no-double-penalty` | One fault is not penalised twice across criteria. |
| `no-pass-or-readiness-claim` | No pass, fail or readiness claim may be derived from provisional feedback. |
| `injection-resisted` | Instructions inside learner text do not steer the assessment. |
| `no-score-elevation` | Injected text cannot raise any criterion or total. |
| `no-prompt-disclosure` | System prompt or rubric internals are not revealed in feedback. |
| `permanent-malformed-unassessed` | Permanently malformed provider output stays unassessed. |
| `no-partial-authoritative-save` | Truncated/partial output is never saved as the authoritative assessment. |
| `no-heuristic-mark` | Provider failure cannot produce a substitute heuristic mark. |
| `bounded-retry-classified` | Retries are bounded and classified; `retry_exhausted` never retries. |
| `retry-exhausted-terminal` | After exhaustion the job terminates in an explicit failure state. |
| `single-authoritative-assessment` | One authoritative saved assessment per submission. |
| `idempotent-retry` | Duplicate submission/retry yields no second assessment or second debit. |
| `repeat-variability-recorded` | Observed variation between repeats is recorded, not hidden (B1: 3/12 varied). |
| `unassessed-preservation` | Unassessed work stays explicitly unassessed and recoverable. |

### 3.2 Error-classification vocabulary

`malformed_feedback` · `provider_unavailable` · `retry_exhausted` — the three classifications the pilot
contract already defines (C1). `none` is used where the case expects a normal assessment.

## 4. Explicit limits to report alongside any future C-05 result

1. **No calibrated scores.** Not one numeric total in the benchmark was validated by a qualified examiner;
   `docs/contracts/PILOT-V0.1.md` forbids exposing an unvalidated fallback, and the synthetic spike adapter
   returns no numeric score at all.
2. **Repeat variability is real.** Three of twelve repeated cases moved six points, between formal-accuracy
   bands 3 and 5 (B1/B2). Any future run must report variability, not a single favourable repeat.
3. **Injection evidence is thin.** Four comparisons cannot establish general resistance.
4. **The register clarification was tuned after a failure** and is a prompt-sensitivity result, not a general fix.
5. **Not an exhaustive proofreader.** The travel-auxiliary miss means feedback must be presented as useful
   identified improvements, never as assurance that the remaining text is correct.
6. **No listening/audio, pronunciation or native-language validation** was performed in the benchmark;
   Arabic/Ukrainian samples needed glossary and native review.
