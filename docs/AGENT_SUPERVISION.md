# Agent supervision: keeping work moving when an agent stalls

This is the durable version of a protocol learned the hard way during the 2026-09-30 coordination takeover. It
applies to anyone — human or agent — supervising dispatched workers. Its purpose is that **no single stalled,
hung or failed worker may idle the programme or silently lose work.**

## 1. A job reporting "running" is not evidence that work is happening

Wrappers lie. Check the **process** and the **artifacts**, not the status field.

| Observation | Reading |
|---|---|
| Wrapper `running`, **no worker process alive** | Wrapper is hung. Its work is likely finished or abandoned. |
| Wrapper `running`, process alive, artifacts advancing | Healthy. Leave it alone. |
| Wrapper `running`, process alive, **no artifact change for ~5 minutes** | Possibly stalled. Inspect before killing. |
| Wrapper exits `1` immediately | Dispatch error, usually reachability. Fix the dispatch and re-run. |

**Observed precedent.** A reviewer's wrapper remained `running` for roughly **38 minutes after** its report had
been written and its branch pushed, with no live process. Killing it lost nothing; the report and the branch
were both intact. Had the wrapper's status been trusted, the review would have been reported as "still working"
and its actual verdict delayed indefinitely.

**How to check.** For a local container: `docker exec <c> ps -eo pid,etime,cmd`. For a remote host:
`ps -p <pid>`. Then look for the artifact: report file, commit, pushed branch, bundle, PR.

## 2. Harvest before discarding

Before killing or re-dispatching, always establish what survived:

1. The **artifact** — report file, commit, pushed branch, bundle, PR. Work is frequently complete even when the
   wrapper failed.
2. The **worktree** — `git status`, `git log`, and whether the branch reached the remote.
3. **Preserve it.** Never delete a failed worker's worktree or branch until the artifact is confirmed absent
   *and* the coordinator has recorded that nothing was recoverable.

Re-dispatch only afterwards, and prefer a **different** worker when the failure looks like a capability or
environment problem rather than a transient one.

## 3. Make the input reachable — the most common dispatch failure

Every failure of this kind seen so far had one shape: **the worker could not see its input.**

- A candidate delivered as a **bundle on a host the reviewer cannot reach**. A bundle is not delivered until its
  branch is on `origin`.
- A task file placed **outside the worker's configured workspace**. One local agent's workspace is fixed by
  configuration with no `--cwd`; files must be placed *inside* it.
- A worker's **local `origin` pointing at a stale bundle** that had not been updated, so a fresh commit "did not
  exist" from its point of view.

**Rule:** before dispatching, prove the worker can see the input. For remote workers, fetch and verify the
commit. For local ones, place files in their actual workspace and confirm with a listing.

## 4. Never let one blocked worker block the queue

- Keep at least one fully specified, dispatchable task ready at all times, so a freed slot is filled immediately
  rather than after a planning delay.
- If a **file collision** is the only blocker, **queue rather than stack branches**. Stacked branches produced a
  rejected integration in this programme: a hand-rebuilt tree silently reverted seven files while its own tests
  stayed green.
- An idle slot may be filled by any worker whose work is genuinely unblocked.

## 5. Record failures honestly

- A failed, stalled or killed run is recorded with what was attempted, what was recovered and what was lost.
- **Never report a stalled worker as "working."**
- When a worker's claim is later shown false, record the correction against the **claim**, not only against the
  reviewer's verdict.

## 6. Batching reviews at the end does not relax the gates

If reviews are batched, the merging process must still run the mechanical gates before every merge — changed
paths within the grant, no unintended deletions, protected files untouched, baseline suites green, applicable CI
green — and every merged change is recorded as **"merged with independent review pending."**

When a review lands *after* a merge and finds a defect, that defect is tracked as **open against the merged
code**, not as caught in time.

**Observed cost of the trade.** A reset fix was merged and its review then contradicted a claim in the merged
documentation: the in-flight-save race was **not** closed, and a reset racing one in-flight save was resurrected
on reload. The defect is real and now tracked against the merged tree.

## 7. Verify the probe, not just the result

A passing test is not evidence unless it **discriminates**. Two concrete traps seen in this programme:

- A regression test was accepted that passed against **both** the broken and the fixed implementation. It proved
  nothing until it was run against the old code and failed.
- A probe's legacy-mode option silently fell back to the **current directory** when given no value, so it
  compared the candidate **against itself** and reported a false negative.

**Rule:** before trusting any new check, run it against the pre-fix code and confirm it fails there.
