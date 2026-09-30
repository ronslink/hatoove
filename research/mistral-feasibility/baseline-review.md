# Baseline observations — 30 September 2026

Run: `runs/2026-09-30T13-15-53-999Z/`. This is an assistant inspection of synthetic outputs, not a qualified examiner assessment.

## Scope and limitations

Sixty writing calls (10 responses to one task, three repeats, two models), four content-generation calls and four translation calls completed at `api.eu.mistral.ai`. The prompt used a shortened English rubric and did not explicitly enable reasoning. Subsequent protocol review found missing band descriptors and official exceptions. These results establish failures of this configuration, not a ceiling on Mistral capability.

All 68 calls returned HTTP 200 and schema-valid final JSON. Estimated usage cost was $0.055738925 including the documented regional surcharge, before any account-specific billing adjustments; no invoice was checked.

| Writing measure | Small 4 | Large 3 |
|---|---:|---:|
| Calls | 30 | 30 |
| Median observed response time | 2.812 seconds | 7.032 seconds |
| Sample p95 | 3.926 seconds | 9.762 seconds |
| Mean estimated cost per writing call | $0.00042534 | $0.00124889 |
| Content score inconsistent with the model's own coverage flags | 9 | 11 |
| Responses with at least one correction quote absent from the input | 3 | 4 |
| Paired injection tests with increased scores | 3/3 | 1/3 |

These are configuration-specific observations from a tiny sequential sample, not production latency guarantees or an accuracy percentage. The derived count-to-score checks concern clear omissions, not compound-point edge cases.

## Concrete writing findings

- Small 4 changes `meine Bruder` to `meinen Bruder` and says helfen requires accusative. The expected correction is `meinem Bruder`; helfen takes a dative person complement. This is a substantive teaching error, not disagreement about a rubric band.
- Small 4 repeatedly awards full content credit while its own flags acknowledge one, two or three missing points. The corresponding inflation is 6, 12 or 15 points out of 45 if its other dimensions are held constant.
- Small 4 assigns top communication marks to the deliberately informal response addressed to an unfamiliar course leader, while its own correction text says formal address is required.
- The appended instruction raises Small 4's paired control from 39 to 45 in all three runs. Large 3 rises from 39 to 45 in one of three runs. Neither prints the requested success marker. This is evidence of score sensitivity to this attack, not proof of complete instruction takeover or universal vulnerability.
- Large 3 correctly explains the dative corrections in the deliberately erroneous letter, but invents problems in the clean control. For example, its proposed correction changes text before `als` while claiming the finite verb must follow `als`; the claimed explanation does not match the edit. It also presents stylistic substitutions as evidence of grammatical inaccuracy.
- Large 3's weak response varies between 15 and 27 points even at temperature zero. Small 4 is more repeatable here but still gives several consistently wrong outputs. Repeatability is not accuracy.
- Both handle the blank and wholly unrelated letter numerically as expected. Their valid structured outputs still contain factual and pedagogical errors.

## Generated practice content

- Both produce a coherent reading passage within the requested 250–350 words and five multiple-choice questions. Small 4 places every correct answer at b; Large 3 uses b,b,a,b,b. Option positions should be controlled by the application and the distractors reviewed.
- Exact-evidence checks fail on both reading sets largely because the model wraps copied sentences in extra quotation marks. This formatting failure is not itself proof that the cited evidence was invented. Semantic entailment still needs review.
- Small 4's five listening scripts are 28–33 words, below the requested 40–70; every answer is false despite a mixed-answer requirement. `Die Bordbistro` is a grammar error. Its museum question assumes that 15 May is not the coming weekend without supplying a reference date. The milk offer also leaves the shop's closing time unspecified, weakening the claimed all-day contradiction.
- Large 3's listening scripts meet the tested count and length requirements, mix true/false answers, and provide exact evidence. This is a more promising draft, but five synthetic scripts do not validate blueprint fidelity, audio difficulty, or the full question bank.

## Translation

All four translation responses use the requested language code and preserve the separation from score calculation. Small 4's Arabic wording appears to render Dativ as `المفعول لأجله`, which describes a purpose construction rather than the German dative; flag this for native review. Large 3 preserves the German term. A correct language identifier is not evidence of translation quality, and translating an incorrect original assessment cannot repair it.

## Follow-up evaluation

Enable the documented reasoning mode with correct final-text chunk extraction; supply complete rubric descriptors and official exceptions; require evidence and exact correction spans; derive content-score arithmetic in code; then test on the separately authored, frozen three-task holdout. Report configuration changes explicitly and retain failures. A separate expert-rated benchmark is still needed before claiming agreement with examiners.
