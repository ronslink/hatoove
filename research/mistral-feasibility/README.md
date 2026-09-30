# Mistral feasibility experiment

This is a standalone research harness. It does not change the application, deploy the site, store credentials, or use real learner data.

**Completed findings:** [Mistral capability assessment, 30 September 2026](RESULTS-2026-09-30.md). The study produced 136 successful outputs, including 128 writing assessments. It supports reviewed content drafting and further feedback research, but does not validate autonomous exam grading. The machine-readable aggregate is `study-summary.json`; regenerate it offline with `node research/mistral-feasibility/summarize-study.mjs`.

## Scope

- Ten original synthetic German responses to one original four-point writing task.
- Three independent repeats at temperature 0 per pinned model.
- Mistral Small 4 (`mistral-small-2603`) and Large 3 (`mistral-large-2512`).
- Three official writing criteria; raw values 0/1/3/5 and a server-calculated total out of 45.
- Checks for task-point coverage, content-credit arithmetic, incomplete but relevant answers, register, blank/off-topic responses, grounded correction quotes, and a paired instruction-injection attempt.
- One reading task set and five short listening scripts per model. Audio synthesis and playback are not tested.
- Arabic and Ukrainian translations of an already-computed feedback summary. Translation has no score fields and cannot change the saved assessment.

The model sees the task and response, never fixture labels, expected results or comparison targets. Content and translation output need human review. No scores are expert ground truth. A stable model can still be wrong, and one unsuccessful injection is not evidence of general injection resistance.

## Extended capability evaluation

The initial 68-call baseline completed; see `baseline-review.md`. `heldout.json` adds 12 synthetic responses across three fresh task contexts, with controlled grammar changes and explicit evaluator annotations. `run-v2.mjs --profile grounded` uses the reviewed fuller rubric, exact evidence quotations and code-derived task-point arithmetic. Neither version has expert-scored whole-response ground truth.

The reasoning comparison tests Small 4 and Medium 3.5 with explicit `reasoning_effort=high`. Reasoning chunks are discarded; only final text is stored. Requests use `temperature=0, top_p=1`; Medium 3.5 rejected the earlier omitted-top_p configuration. Those HTTP 400 records are configuration failures and must not be counted as evidence of grading quality.

The fuller evaluation is not constrained to $1. The runners default to a configurable $25 conservative per-run reservation, with an upper safety guard of $100. This is an experiment guard, not an account-wide spending limit. Current planned synthetic batches require substantially less than their reservation.

With the key already copied, this launcher reads it once and retains it in the parent process while both batches complete:

```powershell
& './research/mistral-feasibility/run-capability-batches.ps1'
```

For only the corrected Medium comparison, add `-Models mistral-medium-3-5`. The launcher and runner never print or save the key. The clipboard may clear independently; that does not affect batches already holding their in-memory copy.

Offline extended preflight:

```powershell
node research/mistral-feasibility/run-v2.mjs --fixtures heldout.json --models mistral-small-2603,mistral-medium-3-5 --profile grounded --reasoning-effort high --concurrency 2 --repeats 2 --grading-only
```

`acceptanceFlag` checks complete schema and exact quotation structure; it does not certify that a correction or grade is correct. `knownErrorCoverage` detects overlapping quote spans as review candidates, not linguistic accuracy. Original model output stays intact alongside code-derived `canonicalAssessment`.

## Run the original suite

Node 20+ is required; no npm dependencies are installed.

Offline preflight (no network or credential access):

```powershell
node research/mistral-feasibility/run.mjs
```

Live, after identifying the correct 1Password vault item:

```powershell
node research/mistral-feasibility/run.mjs --live --op-item <item-id> --op-field credential --budget 1
```

The runner retrieves the specified field in memory. If the 1Password desktop connection must be made from the approved parent shell, pipe the field directly instead:

```powershell
op item get <item-id> --fields label=credential --reveal | node research/mistral-feasibility/run.mjs --live --key-stdin --budget 1
```

Do not run the first half of the pipe alone: it would display the credential. Never paste the key into chat, a command argument, or a source file.

Optional flags: `--models mistral-small-2603` and `--repeats 1`. Model IDs are restricted to an explicit price table. The endpoint is fixed to `https://api.eu.mistral.ai`; there is no global fallback or redirect following.

## Cost and failure handling

The local guard reserves a conservative request cost before each call, using UTF-8 input bytes plus 8,192 tokens of overhead and the full output allowance. Reservations are never released, including after unknown failures. The original run used $1; the expanded study uses the configurable guard described above. There are no automatic retries. This is a cost guard based on a price snapshot, not an account-wide provider spending limit.

The price table uses $0.15/$0.60 per million input/output tokens for Small 4, $0.50/$1.50 for Large 3 and $1.50/$7.50 for Medium 3.5, plus the documented 10% regional surcharge. Usage-based costs are estimates, not verified invoices. Authentication, credit and rate-limit failures stop further work. Malformed or truncated outputs never acquire a calculated assessment score.

Outputs go to a new timestamped `runs/` directory:

- `protocol.json`: endpoint, models, prompt/schema, temperature, hashes and pricing assumptions.
- `results.jsonl`: per-call output, validation, token usage, timing and cost estimate. Only synthetic content is included.
- `summary.json`: completion, repeat ranges, behavioural checks, paired injection deltas and limitations.

Required follow-up before claiming grading accuracy: permissioned real learner scripts, independent qualified human ratings, a held-out evaluation set, criterion/total-score agreement, overestimation analysis and native review of explanations. This small sample does not establish production reliability, statistical latency guarantees, examiner equivalence or whole-exam readiness.

## Sources checked 30 September 2026

- [Official telc Deutsch B1 sample and writing rubric, printed pages 36–38](https://shop.telc.net/media/catalog/product/file/telc_deutsch_b1_zd_uebungstest_1.pdf)
- [Mistral chat API](https://docs.mistral.ai/api/endpoint/chat)
- [Mistral model pricing](https://mistral.ai/pricing/api/)
- [Mistral regional endpoint and surcharge](https://docs.mistral.ai/inference/regional-inference)

The regional documentation lists EU/EFTA geography. This experiment demonstrates which hostname was called; it does not independently audit physical processing location, provider retention settings or contractual compliance.
