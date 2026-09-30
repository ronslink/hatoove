# Hatoove: matched DeepSeek V4.1 Flash benchmark

This standalone research harness compares DeepSeek with the existing Mistral results. It does not modify or deploy Hatoove, change its production model, or send learner records. All tasks and letters are synthetic. Scores are **not** qualified-examiner ground truth.

**Completed findings:** [DeepSeek versus Mistral, 30 September 2026](RESULTS-2026-09-30.md). The main comparison completed 38 calls, followed by a separately labelled four-call register diagnostic. See `runs/2026-09-30T15-43-59-181Z/comparison.json` for machine-readable metrics. Regenerate that comparison offline with `node research/deepseek-feasibility/compare.mjs 2026-09-30T15-43-59-181Z`.

## Frozen comparison

The runner reads the saved Mistral protocols directly:

- `../mistral-feasibility/runs/2026-09-30T13-35-44-125Z/protocol.json`: original task, ten responses, one repeat, shortened rubric.
- `../mistral-feasibility/runs/2026-09-30T13-37-13-352Z/protocol.json`: three new tasks, twelve responses, two repeats, fuller grounded rubric.

These are 34 writing calls over 22 distinct responses. It keeps the exact original system instructions, user messages, synthetic text and schemas. Hashes and source copies are saved in every new protocol. Existing Mistral files are never written.

`--include-probes` adds four calls in the same process: one reading task set, five listening scripts, and Arabic/Ukrainian feedback translations. Generation wording and schemas match the original benchmark. Translation uses the frozen first Small 4 `plausible_b1_complete` assessment, giving the same input as that model's original translation probes. Large 3 originally translated its own feedback, so that translation comparison is not controlled input. Audio synthesis, playback and native-speaker translation validation are outside this suite.

## Provider and format differences

Default: GreenPT EU endpoint `https://api.greenpt.ai/v1`, exact model `deepseek-v4.1-flash`. There is no automatic provider, region or model fallback. `GET /models` must list the exact ID and each completion must return that ID. An unrecognised identity halts the run for inspection.

[GreenPT's chat-completion request schema](https://docs.greenpt.ai/chat-completion) does not document `response_format`. The runner uses prompt-only JSON, appending the original JSON schema to the system message. It does not claim constrained decoding. Rubric and learner content remain unchanged, but **format transport differs from Mistral's strict JSON-schema request** and may affect results. Local schema validation is identical.

Explicit `--provider deepseek` selects `https://api.deepseek.com/v1`, model `deepseek-flash`, the documented alias for V4.1 Flash. This requires a credential for that provider and is not EU hosting. This route uses documented `response_format: {type: 'json_object'}` and also appends the schema. Thinking mode explicitly enables reasoning; temperature is omitted in high mode because DeepSeek documents that it has no effect. It is never selected as a fallback.

High reasoning is the default; the setting does not imply equal inference compute between providers. Both use `top_p: 1`, an initial 8,192 output-token ceiling, 240-second client timeout, and at most two concurrent calls. GreenPT also receives `temperature: 0`. No tools, browsing, multi-turn context, compression skills or provider-side transformations are requested.

## Run

No dependencies beyond Node 24 are required. First run offline:

```powershell
& 'C:\Program Files\nodejs\node.exe' research\deepseek-feasibility\run.mjs --include-probes
```

The offline preflight confirms frozen message/task equality and replays all 34 existing valid Mistral writing outputs through the comparison scorer. It checks matching totals, score vectors, behavior checks and exact-quote flags, plus JSON/reasoning parsing and cached-token pricing. It reads no credentials and makes no network calls.

For live testing, a trusted local parent process must pipe the provider API token to stdin and run:

```text
node research/deepseek-feasibility/run.mjs --live --key-stdin --provider greenpt --include-probes
```

Do not type the token into an argument, write it to this directory, or print it. The runner keeps that one stdin credential in memory for the entire run, then clears its reference. It never reads clipboard, environment files or 1Password itself.

The separately supplied `run-from-env.mjs` launcher can read the user's existing `D:\B1_Prep\.env` file, select `greenpt_api_key`, and pipe it in memory without printing it. It is restricted to GreenPT and does not modify that environment file:

```powershell
& 'C:\Program Files\nodejs\node.exe' research\deepseek-feasibility\run-from-env.mjs --env-file D:\B1_Prep\.env --include-probes
```

The first scored call runs alone and serves as the format/runtime preflight. Only complete, schema-valid JSON permits the remaining batch. Authentication, configuration, rate-limit, capacity, transport and model-identity failures halt the run. Truncation or missing final JSON also halts for an explicit configuration decision. There are **no automatic retries or silent output replacements**. Another in-flight request can finish when concurrency is two. All attempted calls and diagnostics remain in a timestamped `runs/` folder.

Useful explicit options:

- `--max-calls 1`: stop after the first scored call.
- `--profile baseline` or `--profile grounded`: select one frozen grading profile.
- `--case CASE_ID`: retain one response, including its original repeat count.
- `--max-tokens 16384`: explicit larger-budget diagnostic rerun, preserving the earlier run.
- `--concurrency 1`: serial calls.
- `--reasoning-effort none`: separate non-thinking diagnostic, labelled in the protocol.
- `--safety-limit 25`: per-run conservative reservation in the provider currency; this is a runaway guard, not an account-wide spending cap.

## Records, confidentiality and interpretation

### Separate register diagnostic

`--register-diagnostic` selects a separate four-call study: the frozen guesthouse response using the wrong du/Sie register twice, plus the new independently authored role-reversal control in `register-diagnostic.json` twice. It appends a general German clarification distinguishing inappropriate register from an actual reversal of communicative roles. Expected labels, commentary and provenance are never included in model messages.

```powershell
& 'C:\Program Files\nodejs\node.exe' research\deepseek-feasibility\run.mjs --register-diagnostic
& 'C:\Program Files\nodejs\node.exe' research\deepseek-feasibility\run-from-env.mjs --env-file D:\B1_Prep\.env --register-diagnostic
```

Do not combine this mode with `--include-probes`. Its protocol records the exact addendum/hash, control provenance, and the label `register_status_prompt_tuned_diagnostic`. Its summary includes separate status/content/language-credit checks. This tests whether an observed failure is locally correctable after prompt tuning; it is **not** an unbiased holdout test or the original matched model comparison. Default benchmark messages and calls are unchanged.

Each run saves `protocol.json`, `model-check.json`, append-only `results.jsonl` and `summary.json`. Responses retain final, schema-valid JSON and the numeric usage metadata. `reasoning_content` is ignored. Tagged thinking blocks are stripped; unstructured or schema-invalid response values are withheld because some gateways mix reasoning into content. Those failures retain content length/hash, validation errors, finish reason and usage, without saving the reasoning. No raw response envelopes are logged. API errors are redacted against the in-memory token.

Grounded content scores use the same deterministic formula as Mistral. Correct arithmetic is **not model accuracy**. Exact quotation acceptance is **not correct grammar feedback**. Known-error overlap means a correction touched the relevant span, not that its replacement was correct. Human semantic review must assess invented corrections, grammar advice, content interpretation and injection effects. Injection summaries contain only injection-labelled paired cases, not ordinary omission variants. Repeated responses are correlated, not independent learners.

GreenPT estimates use EUR 0.22/M ordinary input, EUR 0.011/M reported cached input and EUR 1.10/M output. Direct DeepSeek estimates conservatively use peak USD rates (0.30/0.006/1.20); actual off-peak charges may be half. Currency is recorded explicitly, no EUR/USD equivalence is assumed, and no invoice is verified.

Official documentation checked on 30 September 2026:

- [GreenPT model, pricing and reasoning](https://docs.greenpt.ai/deepseek-v4-1-flash)
- [GreenPT chat API](https://docs.greenpt.ai/chat-completion)
- [GreenPT reasoning controls](https://docs.greenpt.ai/reasoning)
- [GreenPT model API and EU endpoint](https://docs.greenpt.ai/models)
- [DeepSeek alias, prices and supported features](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek thinking parameters](https://api-docs.deepseek.com/guides/thinking_mode/)
- [DeepSeek JSON output](https://api-docs.deepseek.com/guides/json_mode/)
