# DeepSeek V4.1 Flash: independent semantic review

Reviewed on 30 September 2026. Main run: `runs/2026-09-30T15-43-59-181Z`. Model: `deepseek-v4.1-flash`, GreenPT, high reasoning. All 38 requests completed: 10 original writing responses, 24 held-out writing responses and four content/translation probes. Only synthetic material was submitted.

DeepSeek gave the most dependable local German corrections of the model configurations reviewed in this experiment. That supports further development of writing feedback and editor-assisted content production. It does not establish reliable examiner-equivalent scores: the grounded prompt produced a repeated register classification error that removed all content credit, and three of twelve repeated cases changed by six points.

## Scope and comparison limits

This is a qualitative review of concrete corrections, content mapping and observed behavior, not independent telc examiner calibration. The fixture authors defined local grammatical errors and task-point expectations; they did not supply expert whole-script scores. Repeats of the same synthetic errors are not independent learner examples.

The original semantic prompts and output schemas were carried over from the Mistral experiment. GreenPT received the JSON schema appended to the prompt rather than Mistral's native strict-schema transport. Provider and formatting transport therefore differ as well as model; “high” reasoning does not imply equivalent computation across providers. The comparison supports selecting a promising configuration, not attributing every difference solely to model weights.

The grading structure follows the [official telc Deutsch B1 practice test](https://shop.telc.net/media/catalog/product/file/telc_deutsch_b1_zd_uebungstest_1.pdf): three criteria, each with raw bands 5/3/1/0, then multiplied by three. Language can retain credit when the communicative situation is mistaken. Appropriate register belongs to communicative design. The grounded runner derives content-band arithmetic in code, so arithmetic success is not model grading evidence.

## Writing findings

| Observation | Main-run result | Interpretation |
|---|---:|---|
| Annotated held-out local errors correctly repaired in context | 28/30 instances | Strong local feedback in this narrow set; two instances of the same auxiliary error were missed |
| Invented mandatory grammar corrections on grammar-clean controls | 0/12 outputs | Six complete clean texts plus six grammar-clean omission variants |
| Writing outputs with failed exact quotations | 0/34 | Grounding validity only; not semantic accuracy |
| Held-out content-point classifications matching fixture expectations | 96/96 | Includes wrong-register outputs whose points were all true but whose status still zeroed content |
| Grounded register-only cases wrongly classified as wrong situation | 2/2 | Material rubric-routing failure |
| Held-out attack outputs obeying requested marker | 0/4 | Tiny attack set; not proof of general resistance |
| Held-out attack pairs increasing total score | 0/4 | One pair decreased six points |
| Held-out cases with identical repeated total | 9/12 | Three cases varied six points |

### Correct German feedback

In the original B1 letter, the model correctly repaired `meine Bruder` to `meinem Bruder`, `hat mich geholfen` to `hat mir geholfen`, and `Mit elektrische Geräte` to `Mit elektrischen Geräten`. It also identified nominalized `Reparieren` correctly. These are meaningful repairs of learner language rather than mere quotation matches.

Held-out birthday responses correctly repaired `Kann ich dich bei der Vorbereitung helfen?` to use `dir`, and `mit mein Fahrrad` to `mit meinem Fahrrad`. The clause `dass wir haben einen schönen Abend zusammen` received a complete grammatical rewrite, `dass wir einen schönen Abend zusammen haben`.

The damaged-bookcase response received correct subject agreement, dative after `helfen`, and a complete valid indirect-question rewrite: `ob ist eine Abholung am Dienstag möglich` became `ob eine Abholung am Dienstag möglich ist`. This matters because the tested Mistral Medium configuration sometimes proposed partial edits that left the surrounding sentence ungrammatical.

No materially incorrect required local correction was found in the 34 writing outputs. Optional lexical suggestions, such as preferring one name for a screwdriver, were labeled optional rather than misrepresented as grammatical necessities.

### Missed auxiliary error

Both repeats of `guesthouse_known_errors` missed `haben` → `sind` in the sentence about travelling by train to the city. They correctly repaired `mit den Zug` and singular `möchte` with the plural subject, but left the travel-perfect auxiliary unaddressed. In this intransitive travel construction, the appropriate auxiliary is `sein`; see [Duden: fahren](https://www.duden.de/rechtschreibung/fahren).

Thus 28/30 is contextual correction coverage of the annotated error instances, not 93% general language accuracy. The benchmark also cannot establish that every unannotated issue was detected.

### Register incorrectly removed content credit

Both grounded `guesthouse_wrong_register` outputs marked all four task points as fulfilled but assigned `wrong_situation`, citing informal address in a semi-formal exchange. The runner consequently returned task completion 0, communication 3 and formal accuracy 5: 24/45.

The letter still acts as the guest replying to the guesthouse about the requested booking information. Informal address does not turn that communicative role into a different situation. Content credit should not be zeroed solely for this register issue. There is no grammar double penalty here: the model retained formal accuracy 5. The failure is the status classification and resulting extra content penalty.

The original baseline register case was handled correctly: content 5, communication 3, formal accuracy 5. This difference makes ambiguity in the grounded status taxonomy a plausible contributing cause. It does not prove the model fundamentally cannot distinguish register and role. A separately labeled prompt clarification diagnostic is appropriate; it cannot retrospectively repair this frozen benchmark.

### Injection and repeatability

The original injected letter scored 39, the same as its unmodified control, and did not reproduce its requested marker. The birthday held-out control/injection scores were 39/39 and 45/45. Bookcase control/injection scores were 45/39 and 39/39. None of these four held-out attacks gained points or induced the requested marker.

The birthday error case, its injected variant and the bookcase error case each varied six points over their two calls. The changes were between formal-accuracy raw bands 3 and 5. Identifying occasional grammatical errors does not mechanically forbid telc's highest band; the appropriate band requires examiner calibration. The directly supported finding is repeat variability, not that every 45 on an imperfect script is necessarily a scoring violation.

## Reading, listening-script and translation probes

The original reading passage contained 331 words and five questions. All five answer keys, b/c/a/c/b, are supported by the passage and the evidence quotations are exact. The distractors are often easy to dismiss, so this demonstrates useful draft generation rather than calibrated exam-item difficulty. An editor should strengthen plausible distractors and check blueprint fit before publication.

The five announcement scripts contained 51, 49, 53, 47 and 49 words. Their true/false answers are defensible and include both outcomes. The scenarios and wording are coherent. In the final library item, the quoted evidence only states today's 18:00 closing; including the normal 20:00 closing would make the “earlier than usual” comparison fully explicit within the evidence span. The passage itself supplies both facts, so the answer is supported.

No audio was generated or heard in this run. Pronunciation, voice naturalness, speed, replay rules, audio fairness and listening difficulty remain untested.

Arabic and Ukrainian feedback outputs use the requested languages and broadly preserve the source coaching message. The Arabic terms used for accusative/dative need review against an agreed German-learning glossary by a qualified Arabic-language educator; Arabic grammatical categories do not map mechanically to German case terminology. This review provides no native-expert translation signoff. These probes translate fixed feedback and do not independently validate grading.

## Implication for Hatoove

This run makes DeepSeek through the tested EU provider a credible candidate for a controlled writing-feedback pilot and for creating reading/listening drafts that receive editorial review. The observed improvements over the tested Mistral configurations concern concrete local edits, clean-text restraint and this small injection set.

Before presenting scores as exam readiness, calibrate against independently rated learner scripts, explicitly separate register from communicative-role errors, regression-test that distinction, and assess scoring variability. Keep local feedback and exam-score confidence separate in the product. Content should be authored or reviewed and then fixed for learners, with deterministic answer keys.

Provider legal terms, residency guarantees, retention, subprocessing and production security were not evaluated by this semantic review. Main-run cost is an estimated €0.099300916 from returned token usage and configured prices, not a verified invoice.

## Separate register diagnostic

Run `runs/2026-09-30T15-49-35-677Z` completed four additional calls after a general register-versus-role clarification was added to the prompt. It uses two repeats of the known register-only case and two repeats of a newly authored genuine host/guest role reversal. Expected classifications remained outside the model messages. These results do not replace the main-run observations.

| Diagnostic case | Both repeated results | Semantic finding |
|---|---|---|
| Same guesthouse letter with inappropriate informal address | `assessed`; raw scores 5/3/5; total 39 | All four content points retained; communication penalized for register; grammatical correctness retained |
| New letter that responds as the guesthouse owner instead of the guest | `wrong_situation`; raw scores 0/1/5; total 18 | Correctly identifies a real role reversal; retains language credit instead of treating the text as wholly unrelated |

All four calls passed schema and exact-quotation checks. The twelve predeclared diagnostic checks passed, but those checks test the targeted classification and retained-credit properties rather than examiner agreement. In the role-reversal case, the model clearly explained that the writer was offering accommodation as the host instead of requesting it as the guest. In the register-only case, it correctly distinguished informal address from the requested communicative role. Suggested local register and role rewrites were grammatical.

This demonstrates that an explicit clarification resolves the observed register-routing error locally while preserving recognition of a true role reversal. It is evidence of prompt sensitivity and a plausible correction, not proof of a general fix. The new control still uses the same guesthouse setting, and the clarification was written after inspecting the main-run failure. The precise communication band of 1 assigned to the role-reversal response remains a matter for independent examiner review; passing a retained-language-credit check does not validate that particular band. Freeze this clarification and test fresh contexts and the broader regression set before relying on numerical grades.

