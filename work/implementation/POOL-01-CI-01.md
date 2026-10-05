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
3. ~~**The digest-forms helper is duplicated**: the builder has one, the check has its own. They cannot share one
   because the builder is a script with `process.exit`, not an importable module.~~ **RESOLVED by task-53/N5**
   (§N5 below): the builder is now an importable module with a guarded CLI body, and both files use the ONE
   exported rule.
4. **The canonicalisation matches one line shape.** A learner payload that happened to contain the exact text of
   a `-- Source: … (sha256 …)` line with a legitimate digest could in principle be masked. Not reachable today:
   each migration carries exactly one such line, and both are asserted.
5. **`--no-mutations` was not exercised** in this lease; the flag path is unchanged, but it is not part of any
   gate group.

## N5 (task-53) — the assert that could not fail, and the rule that existed twice

**Found (Claude's second pass, N5).** Leg 4 ended with:

```js
const fabricated = `${header[1].slice(0, 63)}${header[1].endsWith('0') ? '1' : '0'}`;
assert.notEqual(fabricated, header[1], 'the fabricated digest is a different value');
assert.ok(!seedForms.has(fabricated), 'and a digest one character away from the record is NOT accepted');
```

The last line is true by construction — a set of three real sha256 values cannot contain a 64-hex string that
differs from all of them — so it can never fail, it never touches `canonicalSourceRecord`, and no mutation
showed a hand-edited record being refused. The rule also existed **twice** (`legitimateSourceDigests` in the
builder, `sourceDigestForms` in the check), and a generator and its checker implementing the same rule
separately is how a gate stops meaning anything.

**Fixed, in three parts.**

1. **The rule is shared, not reimplemented.** `build-objective-migration.mjs` **exports**
   `legitimateSourceDigests` and `canonicalSourceRecord`; `pool-01-check.mjs` imports them and its own
   `sourceDigestForms` is deleted. Both legs (4 and 5) now read the rule from the generator.
2. **The builder is importable.** Sharing was impossible while the builder ran its whole CLI body at import
   time: `import`ing it printed the census and, in the write path, **rewrote
   `server/migrations/0010-objective-catalogue.sql` as a side effect of a CHECK** (identical bytes while the
   tree is consistent, which is exactly why it would have gone unnoticed until the day the tree was not).
   The CLI body is now behind `isCli`, so importing the module has no side effects. This is a real defect the
   N5 work exposed, not a refactor for taste.
3. **The decoration is replaced by two asserts that can fail.**
   - `canonicalSourceRecord(realRecord) !== canonicalSourceRecord(handEditedRecord)` — the generator
     canonicalises a real record and leaves a hand-edited one alone, so the two cannot look the same to the
     comparison. If the canonicalisation ever stops checking the digest, this fails.
   - **End to end**: a copy of `0047` with exactly one hex character of its source record changed is handed to
     the generator's own `--check` and **must be refused**, after the pristine copy is accepted first (so the
     refusal cannot be about something else).

**Mutation proof.** `BUILDER_MUTATIONS` gains M8, which makes the canonicalisation accept ANY digest
(`allowed.has(hex) ? … : whole` → `…` unconditionally). The run:

```text
node tools/pool-01-check.mjs                 7 legs, 0 failed
MUTATION M8 the source-record canonicalisation accepts ANY digest -> 2 leg(s) fail: 4 the additive builder
  change left the corpus untouched: 0010 still matches its source, and the batch is not spliced into it
  [the corpus migration must still match data/seed.json:]
node tools/pool-01-check.mjs --postgres      14 legs, 0 failed   (7 offline + P1–P7)
  all 8 mutations detected (M1–M8), each naming the legs that broke
```

And by hand, the two invocations the leg performs (this is the discrimination the old assert lacked):

```text
node tools/build-objective-migration.mjs --batch content/pool-01/batch-1.json --out %TEMP%\n5\pristine.sql --check
objective-batch: OK C:\…\pristine.sql matches content\pool-01\batch-1.json          exit 0
node tools/build-objective-migration.mjs --batch content/pool-01/batch-1.json --out %TEMP%\n5\hand-edited.sql --check
objective-batch: FAILED C:\…\hand-edited.sql differs from content\pool-01\batch-1.json   exit 1
```

The recorded digest `45e361a1…9161` was changed to `…9160` (one hex character) for the second run. `git
status` afterwards shows no change under `server/migrations/`: no generated byte moved, and `data/seed.json`,
`0047` and `MANIFEST.json` were not touched.

**The root cause is proposed, not applied.** Generation still hashes the source bytes AS CHECKED OUT, so a
batch built on Windows records a CRLF-dependent digest (this is the whole of §"The two digests"). The correct
fix is a `.gitattributes` `eol` rule:

```gitattributes
data/seed.json                text eol=lf
content/pool-01/*.json        text eol=lf
```

That changes how those files are CHECKED OUT — and therefore which digest is correct — so it is the Lead's
call, as the brief says. Not applied here; the canonicalisation stays as the safety net until it is.

**Evidence:** `node tools/pool-01-check.mjs` (7/0, 8/8 mutations), `--postgres` against a disposable
`postgres:17-alpine` container (14/0), `run-gates.mjs mirror` all passed, `baseline` all passed, `mirror-db`
7/7. The container and the temporary `pg` junction used for the database legs were removed afterwards.
