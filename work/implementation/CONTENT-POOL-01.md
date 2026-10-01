# CONTENT-POOL-01 — generating once, serving everyone

**Status: PROPOSAL. Not a decision, not dispatched, not built.** It contains two forks that are
Ron's (§7) and one dependency that is a human gate (live generation, R10).

Ron, 1 October 2026:

> "we also need a data schema that ensures we are not storing unnecessary data since much of the
> questions should be ai generated we should maybe discuss a pool of questions to save on tokens
> that are then stored in the database...since users will need the same content"

> "we should come up with a way to do this that is efficient and effective"

---

## 1. The shape of the answer

**Generate into a shared pool, off the request path, only to fill a measured deficit, and never
generate the same thing twice.**

Four properties follow, and all four matter:

| | |
|---|---|
| **Efficient** | Cost scales with *pool size*, not with learners or attempts. After a pool is filled, serving a learner costs **zero** tokens. The only irreducible per-learner cost is feedback on their own writing |
| **Effective** | Every learner gets the same reviewed items, so the content can be reviewed once, cited exactly, and compared between learners |
| **Honest** | An item carries `review_status` and a `generation_run`, so what a learner is shown can be labelled truthfully instead of implied to be approved |
| **Cheap to store** | Shared content is stored once and is immutable; learner tables hold *references* to versions and never copies of text |

The single most important rule: **the request path never calls a model.** Generation is a background
job. A learner never waits on a provider, cost is bounded and measurable, and an item can be labelled
before anyone sees it.

---

## 2. The pool key, and the deficit that drives work

A pool is a set of servable item versions under one **content specification**:

```
pool_spec = (exam_package, skill, task_type, difficulty_band, content_language)
```

Work is driven by a **deficit**, never by a schedule:

```
gap(pool_spec) = target - servable_count(pool_spec)
servable = review_status allowed by the serving policy  AND  rights_status allowed  AND  not retired
```

Two fill triggers, in priority order:

1. **Starvation** — a learner exists who has seen every servable item under a spec. This is real
   demand and jumps the queue.
2. **Coverage** — `gap > 0` against the target. This keeps a healthy pool before anyone is waiting.

Nothing else generates. A pool that is adequately covered costs nothing to leave alone, which is the
difference between a system that converges and one that generates forever.

---

## 3. Where the tokens actually go, and how batching removes them

The naive shape — one item per call, then one explanation per language per item, per learner — is the
expensive one and it is also the least reviewable. Four changes do most of the work:

1. **Batch the items.** One call returns *K* items for one `pool_spec` against one schema. The
   instruction and specification tokens are then amortised across K instead of paid K times. This is
   the largest single saving and it costs nothing in quality if the response is validated.
2. **Generate the item and its source-language explanation together.** They are the same act of
   writing. Splitting them means re-sending the item in a second prompt.
3. **Translate only what survives.** Language explanations are generated in a **second pass, for
   items that passed validation**, batched per language. There is no reason to pay to render an item
   in Ukrainian before deciding to keep it.
4. **Cache the explanation per `(item_version, language)` forever.** Every learner who is served that
   item reads the same explanation. This is the single most reused artifact in the system, and it is
   the one that would otherwise be regenerated on every page view.

Two further economies:

- **Deduplicate before storing.** A canonical `content_sha256` per item means a batch that re-derives
  something already held is dropped rather than stored and paid for twice.
- **Do not regenerate on model change.** A new model produces *new versions*; it never invalidates
  existing ones. Re-generation is a decision, not a side effect.

The metric that governs all of this is **tokens per accepted item** — not tokens per call. A high
rejection rate means the *specification* is wrong, and the fix is a better spec, not more spend.

---

## 4. Schema

Minimal, and every column has a named consumer.

```sql
-- one exam's blueprint; PILOT-04 introduces this and exam-scopes the content keys
exam_package(exam_id, exam, level, exam_language, blueprint_version)

-- the pool key: what "the same content is needed" means
pool_spec(pool_spec_id, exam_id, skill, task_type, difficulty_band,
          content_language, spec_json, target_count)

-- provenance of generation, without storing the prompt or the response
generation_run(run_id, pool_spec_id, provider, model_version, prompt_version,
               requested, accepted, rejected, tokens_in, tokens_out,
               started_at, finished_at, outcome)

-- identity + dedup. One row per distinct item, ever.
item(item_id, pool_spec_id, content_sha256, created_at)

-- the item itself. IMMUTABLE: a new version is a new row.
item_version(item_version_id, item_id, version,
             stem_json,                       -- question, options, instruction
             review_status, rights_status,    -- unreviewed | approved | rejected
             generation_run_id, model_version, prompt_version, created_at)

-- answer keys, in their OWN table, granted to NO runtime role (the existing task_key pattern)
item_key(item_version_id, key_json)

-- explanations: item x language, generated once, read by every learner
explanation(item_version_id, language, text,
            review_status, generation_run_id, created_at)

rubric_version(rubric_id, version, family, criteria, max_total, ...)
```

**Why the keys are a separate table.** Not for storage economy — for *grants*. `item_key` is granted
to no runtime role, and marking happens through a `SECURITY DEFINER` function, so a key cannot leak
through a content download. This is the existing, proven pattern in this repository.

### What is deliberately absent

- **No `seen_by_learner` table.** Which items a learner has already seen is **derived** from
  `attempts` (`owner_id`, `item_version_id`) with an index. A separate table would be a second source
  of truth that can disagree with the first.
- **No progress counters, averages or readiness values.** Derived on read, or they drift.
- **No stored prompts or raw responses.** Provenance is `model_version` + `prompt_version` +
  `rubric_version`. The payload is reproducible from those, and storing it would put possibly-PII
  text in the database for no reader.
- **No per-learner copy of any shared text.** An attempt references `(item_id, item_version)`.

---

## 5. The loop

```
fill (background, bounded):
  for each pool_spec ordered by (starvation desc, deficit desc):
      gap = target - servable_count
      if gap <= 0: continue
      run = generate_batch(pool_spec, min(gap, MAX_BATCH))       # ONE model call
      accepted = validate(run.items)                             # schema, key/option agreement,
                                                                 # difficulty, dedup by sha256
      store accepted as item_version(review_status='unreviewed')
      record generation_run(requested, accepted, rejected, tokens)
      # rejected items are NOT stored. Counts are; payloads are not.

explain (background, batched, only for what survived):
  for each language in supported:
      for items approved and lacking that language:
          generate_batch(explanations) -> validate -> store

serve (request path, zero model calls):
  pick from servable items under the learner's pool_spec
  excluding (owner_id, item_version) already attempted   -- derived, not stored
  if the pool is exhausted: re-serve on a spaced basis, or queue a starvation fill.
    NEVER generate synchronously.
```

---

## 6. What this buys, measured honestly

| | Without a pool | With a pool |
|---|---|---|
| Token cost | grows with learners × attempts | **zero** per learner once filled; only pool fills |
| L1 explanation cost | per learner, per view | **once** per `(item, language)`, reused forever |
| Reviewability | impossible — content is unique per learner | reviewable, because the set is finite |
| Reproducibility | an assessment cites nothing stable | cites `item_version` + `rubric_version` |
| Fairness | two learners cannot compare notes | identical items |
| Rights exposure | every generation is new, unvetted text | one finite, reviewable set |

**A side effect worth naming:** AI-generated items are *original*. The 6 writing prompts and 15
objective sets currently seeded are `rights_status='unknown'`, and that is why production serves
nothing. Generated content can carry an honest `rights_status='generated'` — which means the pool
does not merely respect the content-rights gate, it **shrinks it**, leaving only the hand-authored
sets to be resolved. Educational validity is still a human gate (E-01): originality is not
correctness, and the pool must not be read as an answer to E-01.

---

## 7. The two forks that are Ron's

1. **Fill policy: batch-to-target, or fill-on-demand?** The proposal is **batch-to-target**, with
   starvation jumping the queue. Fill-on-demand never converges and cannot be reviewed ahead of use.
2. **What is the target, and who reviews?** A number per `pool_spec` (items per task type), and a
   reviewer who approves batches rather than a stream. `review_status` starts `unreviewed`; the
   serving policy decides whether an invite-only pilot may see it, labelled.

And one dependency that is not a fork but a gate: **live generation is not authorized (R10)**. This
proposal can be built and checked entirely against a **stub generator** that produces deterministic
items, exactly as the worker's grader is a stub today. The pool machinery, the schema, the deficit
logic and the serving can all be proven before a single live token is spent.

---

## 8. How this changes the plan

- **PILOT-04** adds `exam_package` and `pool_spec` and exam-scopes the content keys — the seam the
  pool needs, and the same seam the second exam needs.
- **PILOT-05** becomes "serve objective items from the pool" rather than "load the seeded sets".
- **PILOT-06/07** reuse `explanation` for pooled item explanations, and keep per-submission feedback
  for the learner's own writing — the one part that is genuinely per-learner.
- **A new slice** owns the filler, the validator and the generation provenance.

## 9. LIMITS

- **Nothing here is built or measured.** No generation was run, no schema was changed, and the token
  claims are reasoning about shape, not benchmarks. The first thing a slice should do is prove the
  deficit loop against a stub generator and record real counters.
- **The `explanation` design assumes explanation text is not learner-specific.** For pooled items
  that holds. Feedback on a learner's own writing does not fit this table and must not be forced
  into it.
- **A pool makes a bad item reach every learner at once.** That is the real risk of pooling, and it
  is why the review gate is load-bearing rather than decorative — and why `review_status` must never
  be flipped in bulk without a reader.
