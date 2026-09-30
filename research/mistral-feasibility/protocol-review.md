# Mistral capability protocol review

Reviewed 2026-09-30. Independent technical review; no credentials read and no inference requests made by this reviewer.

## Model comparison

Test `mistral-medium-3-5` as the current first-party frontier candidate, `mistral-small-2603` as the efficient candidate, and `mistral-large-2512` as a general-purpose comparison. Provider descriptions do not establish which is best at German assessment. Confirm each exact identifier at the selected regional endpoint and record the response model.

For Small 4 and Medium 3.5 compare explicitly specified `none` and `high`. The reasoning guide documents those settings. The generic endpoint schema lists additional values, but this is not evidence that an individual model supports them. Avoid retired Magistral models and third-party GLM models when answering the narrower question about first-party Mistral capability.

Sources: [model lineup](https://docs.mistral.ai/models), [Medium 3.5](https://docs.mistral.ai/models/mistral-medium-3-5-26-04), [Small 4](https://docs.mistral.ai/models/mistral-small-4-0-26-03), [Large 3](https://docs.mistral.ai/models/mistral-large-3-25-12).

## Response handling and output allowance

The original harness accepts only string content. Under high reasoning, Mistral documents an array containing `thinking` and `text` chunks; parse the concatenated top-level `text` chunks as the final JSON. Keep reasoning content out of learner-visible feedback. Validate the resulting object independently, even with strict custom structured output.

`max_tokens` is defined as the completion maximum. Reasoning is generated before the final answer, so treating this as a shared allowance is the prudent inference; the reviewed documentation does not explicitly itemize reasoning-token accounting. Start high-reasoning capability tests with 8,192 output tokens, record usage and finish reason, and distinguish token exhaustion from malformed content. If a case exhausts its allowance, rerun under a larger allowance as a separately recorded diagnostic rather than silently repairing the result. A 60-second timeout can also censor a reasoning comparison; record timeout failures separately from assessment failures.

Sources: [reasoning response format](https://docs.mistral.ai/studio/conversations/reasoning), [chat completion parameters](https://docs.mistral.ai/api/endpoint/chat), [structured outputs](https://docs.mistral.ai/studio/conversations/structured-output).

## Five material improvements

1. **Separate model and prompt experiments.** First run the unchanged rubric/prompt with none versus high after repairing only transport/parsing. Then freeze a revised rubric prompt and evaluate it separately on unseen cases. Otherwise improvement cannot be attributed to reasoning, rubric completeness, language choice or schema ordering.
2. **Specify the assessment task adequately.** The original rubric summary omits full level descriptors and some official exceptions. Include those before claiming a model ceiling. Require short observable evidence for each decision, permit no corrections when none are needed, validate exact original quotations, and calculate arithmetic in code. A quoted phrase existing in the response proves grounding, not that the proposed correction is linguistically necessary.
3. **Use multiple held-out task situations.** One repair-course letter cannot measure generalisation. Add informal and semi-formal contexts, compact but sufficient answers, omission and role-reversal pairs, strong text with a small local error, weak text with all content, and varied injection attempts. Freeze expectations before running. Keep grading accuracy, feedback quality, robustness and operational reliability as separate measures.
4. **Preserve failures in denominators.** Report every attempted request, unsupported-setting errors, timeouts, truncation, invalid schema, behavioral failures and manual-review findings. Do not abort an entire model comparison merely because the first case has invalid content, and do not report only latency of successful responses as overall service latency. Interleave models/cases to reduce run-order effects.
5. **Separate synthetic findings from human validation.** Synthetic cases can establish whether the workflow behaves sensibly and expose failures. They cannot establish agreement with examiners. Preserve a blind reviewer pack and later compare independently rated real or expert-authored scripts; disagreement near decision thresholds matters more than a mean score correlation. Native review remains necessary for Arabic/Ukrainian feedback, and script quality does not establish listening-audio quality.

## Important telc corrections for the revised protocol

A multi-component or plural content point may receive credit with one relevant answer. A very short sentence may suffice. Wrong situation zeros criterion I while the language criteria remain assessable; a wholly unrelated response zeros all criteria. Communication A is excluded by missing email conventions, inconsistent register, disconnected content points or predominantly Ich/Wir sentence starts. Accuracy A still permits occasional systematic errors; intelligibility and overall control distinguish it from B, not a fixed error count. B/C/D descriptors must be included, and code should not pretend point coverage itself is objectively known merely because it performs the final arithmetic.

Source: [official telc practice paper, printed pages 36–38](https://shop.telc.net/media/catalog/product/file/telc_deutsch_b1_zd_uebungstest_1.pdf).
