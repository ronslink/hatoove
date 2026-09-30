# USER-03 independent review disposition

Execution `user03r-20260930-a`, local read-only reviewer, completed 30 September 2026. Inspected PR17 commits e7037e9,74c7eae,7030a66 against a9a4cfd via exact Git objects; current USER04 checkout was not read as the historical snapshot or modified. All55 existing tests passed through an in-memory snapshot; additional mutation probes exposed the defects below. Coordinator relays findings to USER04 issue19. PR17 remains a draft until its corrections are reviewed/integrated in order.

| Priority | Finding at7030a66 | Required correction |
|---|---|---|
| P2 | exam-blueprint-check399-410 accepts LV part25-to-1 with section max75 | Sum actual part points and reconcile section maximum |
| P2 | exam-blueprint-check333-387,493-554 skips source validation on writing criteria/calculation/rating and writtenExam | Validate every defined source-reference field |
| P2 | exam-blueprint-check371-378,533-541 accepts missing subtestMax/writtenPassPoints | Require operands before arithmetic checks |
| P2 | feedback-case-check232-233 requires content-credit preservation whenever wrongSituation=false | Scope preservation to register-only, permit one/no-point content failure |
| P2 | WFC01/02/05 lack the actual task and four guiding points | Add synthetic task context supporting the expectations |
| P3 | Null section/case crashes both validators after recording an error | Guard remaining traversals and add regression fixtures |

Coordinator also found the contradictory PDF-page formula, off-topic versus wrong-situation conflation, unconditional provider-unavailable retry, narrow human-judgement labels and a broken relative link. These are explicitly in USER04's bounded five-task grant. The useful source register remains an unreviewed draft. No expert educational, content, rights, security or production approval is inferred from this review.
