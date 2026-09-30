# INTEG-R1 — independent review of the integration candidate `7f1ffd7`

Reviewer: Claude for Windows (independent; not the author). Execution id: `integ-r1-claude-20260930-a`.
Coordinator: `COORD-TAKEOVER-20260930`. Candidate: PR #33, `origin/codex/integ-stack-01` @
`7f1ffd754504680dd8ab9e2cde11a8914d0f6982` (fetched and verified). Base: `origin/main` @ `074aebf`.
PR #17 head `7030a66`, PR #21 head `2bcf749`; both share merge-base `a9a4cfd` with `main`.

## Verdict: **REJECT**

The reconstruction **lost merged work**. It did not delete any files, but it overwrote seven tracked files
with **stale copies from `a9a4cfd`**, which silently reverts the code changes of PR #18 (local isolation) and
PR #12 (PILOT-01 CSS). All **38 deleted lines** in the candidate are these reverts, and the **9 added lines** in
those files are old code coming back. They are not PR #17/#21 work. PR #17 and #21 never modified any
of these files.

The underlying premise is also wrong. The "72 deletions" come from a two-dot **tree** comparison
(`git diff main <head>`). A real three-way merge (which is what GitHub does) of `2bcf749` into
`074aebf` is **clean and deletes nothing**. It adds exactly the 13 new files and leaves every PR #18/#20/#12
file intact. A hand-built reconstruction wasn't needed.

The 13 added files in the candidate are byte-identical to PR #21's, and the reported test counts are accurate.
The problem is limited to the seven "modified" files. Together they break the PR #18 isolation boundary, and
the CI step that would have caught it has been removed.

## Check 1 — completeness of the additive set

`git diff --name-status 074aebf 7f1ffd7`: 20 paths (13 A, 7 M).
The A/M set of the tree diff `074aebf..2bcf749` has 23 paths. It is a superset of `074aebf..7030a66` (18 paths). The candidate
contains all of them except the three deliberate exclusions (check 3). The blob hashes of all 13 added files
match `2bcf749` exactly. **Nothing is missing from the additive set.**

The classification is the error. The tree diff labels 10 paths "M", but base-relative diffs show PR #17/#21
modified **none** of them:

```
git diff --name-status a9a4cfd 2bcf749   # PR21's true contribution: 13 × A, 0 × M, 0 × D
git diff --name-status a9a4cfd 7030a66   # PR17's true contribution:  8 × A, 0 × M, 0 × D
```

Each of the 10 "M" paths is `unchanged on the branch, changed on main since a9a4cfd`. For all 10:
`git diff a9a4cfd 2bcf749 -- <path>` is empty, and the candidate's blob is the stale `a9a4cfd` blob.

## Check 2 — unintended deletions

`git diff --diff-filter=D --name-status 074aebf 7f1ffd7` is **empty**. No files were deleted.

The −38 lines are **not** legitimate modifications. They are regressions of already-merged work:

| File | main→candidate | Reverts | Effect |
|---|---|---|---|
| `.github/workflows/pilot-contracts.yml` | −1 | PR #18 `082524a` | drops `node --test spikes/auth-runtime/isolation.test.mjs` from CI |
| `spikes/auth-runtime/auth.mjs` | +2 −3 | PR #18 `082524a` | `localPool(schema)` ignores `{user,max}`, so every pool connects as `postgres`, and `pg_catalog` is dropped from `search_path` |
| `spikes/auth-runtime/store.mjs` | +4 −13 | PR #18 `082524a`, `86d2ed3` | `store(pool)` ignores `{ownerId}`, never sets `hatoove.owner_id`, and `reapExpired` runs outside `tx` |
| `spikes/auth-runtime/server.mjs` | +2 −3 | PR #18 `082524a` | `start(pool, secret)` ignores `{learnerPool, workerPool}`, and no owner-scoped store per request |
| `spikes/auth-runtime/README.md` | +1 −2 | PR #18 `082524a` | drops the isolation run instruction and the LOCAL-ISOLATION reference |
| `public/styles.css` | −8 | PR #12 `3ca5367` | restores the phone nested passage scroll (`.passage` max-height at ≤600px) |
| `public/studio.css` | −8 | PR #12 `3ca5367` | restores the narrow-phone `.daily-stat` text overflow |

Total: 1+3+13+3+2+8+8 = **38 deletions**. That is all of the candidate's −38. The candidate's +6598 is the 6589
lines of the 13 new files plus 9 stale lines restored in the table above.

The PR #12 evidence PNGs are still in the tree. The CSS they document has been reverted, so the evidence no
longer matches the code.

## Check 3 — deliberate exclusions

The candidate keeps **main's** blobs for `IMPLEMENTATION_PLAN.md`, `work/BOARD.md` and `docs/AGENT_RUNBOOK.md`.
`git diff a9a4cfd 2bcf749 -- <those three>` is **empty**, so PR #17/#21 never edited them. Excluding them loses
**nothing**, and I agree with that decision.

However, those three files are in exactly the same position as the seven files in check 2: unchanged on the
branch and changed on main. The coordinator excluded them because they are coordination records, but applied
the same stale-copy logic to the other seven. That inconsistency is the root cause of the defect.

## Check 4 — spike consistency with the kept isolation files

`isolation.test.mjs`, `isolation.sql` and `isolation-fixture.mjs` are byte-identical to main. The modules they
import are **not**, so they no longer match. The PR body's statement that the candidate "cannot regress it by
construction" is incorrect.

The kept test and fixture use the API that the candidate removes:

- `isolation-fixture.mjs:27` calls `localPool(schema,{user:role,max:...})`, and `isolation.test.mjs:168` does the same
- `isolation.test.mjs:50,172` calls `start(f.auth,secret,{learnerPool,workerPool})`
- `isolation.test.mjs:85,90,91,153,171` calls `store(f.learner,{ownerId})`
- `isolation.sql:41–57`: the RLS policies key on `current_setting('hatoove.owner_id')`, which the candidate's `store` never sets

**Dependency-free probe.** I ran `npm ci --ignore-scripts` inside the scratch extract's `spikes/auth-runtime`.
The probe constructed a `pg.Pool` only: no connection, no database, no server.

| | candidate `7f1ffd7` | main `074aebf` |
|---|---|---|
| `localPool('spike_ab',{user:'spike_ab_learner',max:1})` → `options.user` | **`postgres`** | `spike_ab_learner` |
| → `options.max` | **4** | 1 |
| → `options.options` | `-c search_path=spike_ab` | `-c search_path=spike_ab,pg_catalog` |
| `store(pool,{ownerId:42})` rejects an invalid owner | **false** | true |
| `store` source sets `hatoove.owner_id` | **false** | true |

**What this does to the isolation suite:**
- Every "learner"/"worker" pool connects as the `postgres` superuser, which bypasses RLS even with `FORCE ROW LEVEL SECURITY`.
- Scoped stores never set the owner GUC.

The suite would therefore either fail, where it asserts `not_found` or permission denial, or pass for the wrong
reason. Because the workflow step is also removed, CI on PR #33 would not surface this.

I have not executed the suite. That needs Postgres on port 55435, which this task forbids. The mismatch itself
is demonstrated statically and by the probe. It does not depend on running the test.

## Check 5 — actual counts (scratch extract of `7f1ffd7`, Node v24.4.1)

| Command | Result |
|---|---|
| `node tools/exam-blueprint-check.mjs` | exit 0 (4 sections, 9 parts, 61 items, 0 warnings) |
| `node tools/feedback-case-check.mjs` | exit 0 (6 warnings, 3 HUMAN-routed cases) |
| `node tools/objective-fixture-check.mjs` | exit 0 (0 warnings) |
| `node --test tools/exam-blueprint-check.test.mjs` | **52 / 52** |
| `node --test tools/feedback-case-check.test.mjs` | **43 / 43** |
| `node --test tools/objective-fixture-check.test.mjs` | **39 / 39** |
| all three together | **134 / 134**, 0 fail |
| `node tools/check.js` | **101 passed, 0 failed** |
| `node tools/writing-check.js` | **9 passed, 0 failed** |
| `node tools/feedback-check.js` | **14 passed, 0 failed** |

The coordinator's **134/134** and **101 + 9 + 14** figures are **correct**. None of these suites touches the
reverted files, so the green results say nothing about the defect. As the task says, a green suite does not
support the construction claim.

`tools/content-discovery.mjs` exits 1 in the extract because it runs `git ls-files` and a `git archive`
extract has no `.git`. That comes from my scratch method, not from the candidate, so I am not treating it as a finding.

The same checks on the clean three-way merge tree `68e6c6b` also gave **134/134** and **101 + 9 + 14**.

## Check 6 — was rebuilding from main the right call?

**No.** The rebuild was based on a misreading of the diff.

- `git merge-tree --write-tree 074aebf 2bcf749` → `68e6c6b`, **no conflicts**. `git diff 074aebf 68e6c6b` is
  exactly 13 × A, +6589, 0 deletions, and every PR #18/#20/#12 file is untouched. Likewise,
  `git merge-tree 074aebf 7030a66` is conflict-free.
- A merge or rebase preserves both sides because it diffs each branch against the merge-base. The
  "72 deletions" appear only when you compare a stale tree directly with a newer one. A merge **would not
  delete** those 72 files.
- The hand-applied "take the branch's copy of every A/M path" is what lost work. Taking the branch's whole-file
  blob for a path the branch never touched overwrites main's changes. `git diff 68e6c6b 7f1ffd7` is exactly those
  7 files, +9 −38.

The correct construction is therefore any of the following:
1. Merge PR #21 (whose history includes PR #17) into main.
2. Rebase `2bcf749` onto `074aebf`. This replays 17 commits that only add files, so no conflicts are expected.
3. Keep the candidate's approach but take only the 13 **added** paths.

All three give tree `68e6c6b` (for option 2, the tree should match; I did not run the rebase because the task forbids it).
A rebase would have preserved more and lost nothing. The candidate lost PR #18's code path and PR #12's CSS.

One caveat about the tree-diff warning. If PR #17 were **squash-merged by applying its tree** instead of merged, the
72 deletions would be real. The coordinator was right to be cautious about stale branches. The diagnosis
confused two-dot tree diffs with merge semantics.

## Required action before any landing

- Rebuild `codex/integ-stack-01` so that `git diff 074aebf <new>` equals 13 × A and nothing else. The target tree is
  `68e6c6baaaaaeebf50eb1e9375b29ebf884ac8c9`, or equivalently merge #21's history.
- For every future hand integration, check `git diff <merge-base> <branch-head> -- <path>` before treating a
  tree-diff "M" as branch work.
- Correct PR #33's body. The "byte-identical so cannot regress" claim for the isolation test is false for `7f1ffd7`.
- Re-review the rebuilt head. The PR #18 isolation suite still needs its Postgres run, which is outside this review.

## Scope and limits

- This is structural and construction review only. It is not exam validity, content correctness, translation
  quality or security approval.
- No database, server, browser, `.env` or provider call was used.
- The candidate was extracted read-only to `..\candidate-integ-7f1ffd7`, which is outside the repo. Comparison extracts:
  `..\main-spike-074aebf`, `..\merge-tree-68e6c6b`.
- `npm ci --ignore-scripts` ran only inside the scratch copies of `spikes/auth-runtime`.
- Nothing in the candidate branch was edited.
