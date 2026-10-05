# POOL-01-CI-01 — `pool-01-check` passed on Windows and failed in CI, and why

**Task:** task-51. **Branch:** `codex/pool-01-ci-01`, worktree `.worktrees/pool-01-ci`, base `eb5d778` (local
main). **Files:** `tools/pool-01-check.mjs`, `tools/build-objective-migration.mjs`, this note. No migration, no
manifest, no content and no product file was touched: `0010`, `0047` and `MANIFEST.json` are byte-identical to
the base commit (`git status` shows only the two tool files modified).

## Reproduction: the CI failure is a file-shape failure, and it reproduced exactly

CI job `111934298400` failed on ubuntu and passed on windows-latest. Reproduced locally by materialising the
pushed branch into an **LF checkout**: a `--no-local` clone with `core.autocrlf=false`, then the branch ref
(`eb5d778`) checked out in it. That clone is the CI shape — every file LF, which is what `actions/checkout`
produces on ubuntu — and `node tools/pool-01-check.mjs` there failed identically, on the same two legs, and then
died on the same uncaught exception:

```text
PASS 3 the migration imports the RELEASED sets and nothing else, unreviewed, with its provenance
FAIL 4 the additive builder change left the corpus untouched: 0010 still matches its source, and the batch is not spliced into it
FAIL 5 the committed migration is byte-identical to what the builder regenerates (--check)
PASS 6 the MANIFEST line is the sha256 of the migration bytes
PASS 7 the held sets are release-ready: their ids are free and their content is complete
AssertionError [ERR_ASSERTION]: the pristine batch must pass: [["FAIL","4 …"],["FAIL","5 …"]]
    at main (…/tools/pool-01-check.mjs:732:12)
```

## The two digests and the two values, on both sides

Both migrations record `-- Source: <file> (sha256 <digest>)`, and the digest is taken over the source bytes
**as checked out**. Neither source carries an `eol` attribute, so git checks them out CRLF on Windows
(`core.autocrlf=true`) and LF everywhere else. The same content therefore has two legitimate digests:

| source | Windows (CRLF) | CI shape (LF) | recorded in |
|---|---|---|---|
| `data/seed.json` | 93,292 B → `ef26279dfaf3399de1039e0528f385465a5c1a2bc414f0bd0b5c270df2023bac` | 91,372 B → `40a0a06616a539c291be4db1b6644f83f6027cf0423be81343f0dd8a5ed205a6` | `0010` records `ef26279d…` |
| `content/pool-01/batch-1.json` | 25,114 B → `45e361a1c67341d831f78c50a5bcb12a8013a6353566ed1b37abc1b88b319161` | 24,774 B → `f39498a18738282db4d8aec72bebc85c53415743174a331610ffd760000debaf` | `0047` records `45e361a1…` |

**Which side is wrong: the comparison, not the artifact.** Three measurements settle it:

1. **The migration bytes are identical in both checkouts.**
   `0010` = 81,632 B, LF, sha256 `1a23b42cd35e1f190d6590d0d9e729a879c632da3943410fe03412a95d3df18b` in both.
   `0047` = 12,068 B, LF, sha256 `6be1daa4936e96cf135e7dd287fc4d8f3166ab5fb0c249cdebc87e25c24491c5` in both.
2. **The MANIFEST agrees with `0047`'s bytes on both platforms** (`6be1daa4…`), and leg 6 passes in both.
3. **Regenerating the migration in the LF tree differs from the committed file on exactly one line:**

```text
=>  -- Source: content/pool-01/batch-1.json (sha256 f39498a18738282db4d8aec72bebc85c53415743174a331610ffd760000debaf)
<=  -- Source: content/pool-01/batch-1.json (sha256 45e361a1c67341d831f78c50a5bcb12a8013a6353566ed1b37abc1b88b319161)
2 differing lines (one change), 1,206 differing bytes in total
```

So this is **not** a content defect and **not** a blocker: no migration needs regenerating, and Ron's content
path does not need re-running. What was wrong is that `--check` compared the source record literally, which made
it a Windows-only gate.

## The crash, separately

`tools/pool-01-check.mjs:732` (base) was
`assert.deepEqual(controlFailed, [], 'the pristine batch must pass: …')` inside `main()` — the harness's own
"pristine control" check. Any failing leg above it turned into an **uncaught AssertionError**: CI printed legs 4
and 5 and then `triggerUncaughtException`, the summary never appeared, and legs 8+ (the `--postgres` legs) never
ran at all in the offline job. That is why the two failures and the crash have to be reported as three facts, not
two.

## The fix

### 1. `tools/build-objective-migration.mjs` — `--check` is platform-aware; generation is untouched

**I touched this file, and I say so explicitly.** It was necessary: legs 4 and 5 require
`node tools/build-objective-migration.mjs [--batch …] --check` to exit 0, so a check-only fix cannot make them
pass. **Nothing about generation changed** — the batch's split rules, the SECRET_FIELDS stripping, the SQL and
the recorded digest values are all exactly as they were, and `0010`/`0047`'s bytes are unchanged.

Added `legitimateSourceDigests(file)` (the digest of the file's bytes in each line-ending form: raw, LF, CRLF —
computed from the file on disk at comparison time) and `canonicalSourceRecord(text, file)`, which replaces the
record's hex with a placeholder **only when it is one of those digests**. Both `--check` comparisons now use it:

```js
if (canonicalSourceRecord(current, batchPath) !== canonicalSourceRecord(batchText, batchPath)) { … }
if (canonicalSourceRecord(current, SOURCE)    !== canonicalSourceRecord(sql, SOURCE))       { … }
```

The record line is **indented by four spaces** inside the generated SQL header. My first attempt anchored the
pattern at `^-- Source:`, which silently matched nothing and left legs 4 and 5 red — found by probing the regex
in isolation rather than re-reading it, and the pattern is now
`/^([ \t]*-- Source: .*\(sha256 )([0-9a-f]{64})(\)[ \t]*)$/m`. A line that is not exactly this shape is left
alone, so it still fails the comparison.

### 2. `tools/pool-01-check.mjs` — the record is read the same way, and strictly

- **leg 4** now asserts the recorded digest is a member of `sourceDigestForms('data/seed.json')` — the digests
  this checkout's file actually has — instead of equality with one platform's value. It then fabricates a digest
  one character away from the record and asserts it is **not** accepted, so the widened acceptance cannot become
  a rubber stamp.
- **leg 5** gained the same reading for `0047`'s record of `content/pool-01/batch-1.json`.
- The harness control is now a **reported leg rather than an assertion**: a non-pristine control emits a named
  `FAIL the pristine batch must pass before a mutation means anything: …`, the mutation proofs are **skipped**
  (they would be evaluated against a broken baseline, so they would prove nothing), and the run **always reaches
  its tally**. The mutation loops are additionally wrapped: a proof that cannot be evaluated reports a named
  failure instead of killing the process.

## Mutation proofs

| # | mutation | where | result |
|---|---|---|---|
| N1 | remove the source-record canonicalisation from the builder (back to `current !== batchText` / `current !== sql`) | CI-shaped LF tree, builder restored afterwards | `FAIL 4 … the corpus migration must still match data/seed.json` and `FAIL 5 … the builder must accept the committed migration`, exit 1 — **and the tally printed** (`8 legs, 3 failed`, with the named control failure and `mutation proofs SKIPPED`) instead of the old uncaught exception |
| N2 | the fabricated digest one character from the record | inside leg 4, every run | asserted **not** a legitimate form, so the acceptance set is not a rubber stamp |
| M1–M7 | the seven pre-existing mutation proofs, unchanged | CI-shaped LF tree **and** Windows | all seven still bite (held set released; bad LV1 answer; released set dropped; answer fields not stripped; duplicate confirmed key; confirmed key changed; reworded headline reverted) |

## Verification

**CI shape (LF clone at `eb5d778`, my two files copied in):**

```text
node tools/pool-01-check.mjs                       -> 7 legs, 0 failed   (+ all 7 mutations fire)
node tools/pool-01-check.mjs --postgres            -> 14 legs, 0 failed  (+ all 7 mutations fire)   exit 0
node tools/run-gates.mjs mirror                    -> mirror: 12/12 passed  (pool-01-check 1.4s)
node tools/run-gates.mjs baseline                  -> baseline: 9/9 passed
node tools/build-objective-migration.mjs --check   -> OK (24 sets, 24 keys)   exit 0
node tools/build-objective-migration.mjs --batch … --check -> OK (released 3, held 3)   exit 0
```

**Windows worktree (`.worktrees/pool-01-ci`):**

```text
node tools/run-gates.mjs mirror     -> mirror: 12/12 passed
node tools/run-gates.mjs mirror-db  -> mirror-db: 7/7 passed
                                       (library-i18n, part-index, practice-selection, practice-media,
                                        drill, content-rights, pool-01-check — all green)
```

`server/owned-postgres/node_modules` is a junction into the main checkout (node_modules is gitignored); without
it every `--postgres` gate fails instantly for want of `pg`, which is what the first `mirror-db` run here showed
— an environment artefact, not a defect, and worth knowing before reading a red `mirror-db` in a fresh worktree.

Nothing was pushed. The head is the branch tip for the Lead to push to the PR branch.

## Residual risk

1. **This run is Node on Windows over LF bytes, not a true ubuntu run.** The variable under test is the *file
   shape*, which the clone reproduces exactly (and which is why the failure reproduced), but the only proof that
   counts for CI is the PR job the Lead will read.
2. **The builder still rewrites its target when run without `--check`.** On Linux that would write the LF digest
   into `0010`/`0047` — changing an applied migration's bytes — and on Windows it already would not. That hazard
   pre-dates this slice and is not made worse by it (the fix actually removes the pressure, since a red
   `--check` was the path that led here), but a future slice could make generation record a canonical digest and
   refuse to rewrite an applied migration. I did not do that here because it would change generated bytes, which
   this lease forbids.
3. **The digest-forms helper is duplicated**: the builder has one, the check has its own. They cannot share one
   because the builder is a script with `process.exit`, not an importable module. The duplication is held
   together by legs 4 and 5, which require the *builder* to accept the committed files, and by leg 4's
   fabrication assert.
4. **The canonicalisation matches one line shape.** A learner payload that happened to contain the exact text of
   a `-- Source: … (sha256 …)` line with a legitimate digest could in principle be masked. Not reachable today:
   each migration carries exactly one such line, and both are asserted.
5. **`--no-mutations` was not exercised** in this lease; the flag path is unchanged, but it is not part of any
   gate group.
